/**
 * Server-authoritative game session runner (spec §09).
 *
 * Owns: a game module's state, command authorization, server timers, the event
 * log, and — critically — SECRET ISOLATION, which stays a single choke point
 * here even though the redaction RULES now live inside each game.
 *
 * MULTI-GAME (2026-08-24, Mark: "make the engine capable of being multi-game").
 * This file used to import `sayLess` and hardcode its vocabulary: which fields
 * publicRound() may copy, that the secret goes to `round.speakerId`, that a dead
 * clock in GUESSING means "open the ballot". A second game could satisfy the
 * whole kit contract and still not run, because the runner underneath knew
 * exactly one game.
 *
 * Now it holds a GameModule it was handed, and knows nothing else about it:
 *   what a device may see       -> module.project(state, ctx)
 *   who must be told what       -> module.privateViews(state), delivered on change
 *   which clock, and what next  -> module.effects(state, event).timer.onExpire
 *   what may cross the wire     -> module.redactEvent(event)
 *   who may send a command      -> module.hostOnlyCommands + an injected actorId
 *
 * There is no switch on a phase name and no game id anywhere below.
 */

import type { GameModule, TimerSpec } from "@gww/kit";
import type { EventLog } from "./log.js";
import { glog } from "./logger.js";
import type { Room } from "./rooms.js";

export interface SessionCallbacks {
  /** Broadcast to every device in the room — players and boards. */
  broadcast(type: string, payload: unknown): void;
  /** Send to the display boards only (they get the no-viewer projection). */
  toBoards(type: string, payload: unknown): void;
  /** Deliver to exactly one player's device(s). */
  toPlayer(playerId: string, type: string, payload: unknown): void;
}

export class SessionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** The actor id used for platform-initiated commands (timers, auto-start). */
export const SYSTEM_ACTOR = "game";

export class GameSession {
  private state: unknown;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Server-time deadline of the active phase timer, for client countdowns. */
  private deadline: number | undefined;
  /**
   * Last private payload delivered to each player, as JSON.
   *
   * Delivery is diff-based: after every transition the runner asks the game who
   * should currently know what, and sends only what changed. That single decision
   * replaced the old resendSecretIfSpeaker special case, and it means a game
   * never has to think about reconnects, second tabs or delivery timing — it
   * describes what is true and the platform makes it so.
   */
  private lastPrivate = new Map<string, string>();

  constructor(
    private room: Room,
    private module: GameModule,
    seed: number,
    private log: EventLog,
    private callbacks: SessionCallbacks,
    private now: () => number = () => Date.now(),
  ) {
    const players = [...room.players.values()].map((p) => ({ id: p.id, displayName: p.displayName }));
    const t = this.module.createSession(players, seed);
    this.state = t.state;
    this.record(SYSTEM_ACTOR, t.events);
  }

  get gameId(): string {
    return this.module.manifest.gameId;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = undefined;
  }

  /**
   * Arm a clock whose expiry sends a command the GAME named.
   *
   * The runner neither knows nor cares what `onExpire` means. If the phase has
   * already moved on by the time it fires, the engine throws a coded error and
   * the throw is swallowed — the same tolerance the say-less-specific version
   * had, for the same reason: a clock firing into a finished round is normal.
   */
  private armTimer(spec: TimerSpec): void {
    this.clearTimer();
    this.deadline = this.now() + spec.ms;
    this.timer = setTimeout(() => {
      try {
        this.dispatch(SYSTEM_ACTOR, spec.onExpire, (spec.payload ?? {}) as Record<string, unknown>);
      } catch {
        /* phase already moved on between arm and fire — nothing to do */
      }
    }, spec.ms);
    // Never hold the process open for a party timer.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private name(playerId: string | undefined): string {
    if (playerId === undefined) return "?";
    return this.room.players.get(playerId)?.displayName ?? playerId;
  }

  /** Log every event in full, narrate it, and put only the redacted form on the wire. */
  private record(actorId: string, events: unknown[]): void {
    for (const e of events) {
      const line = this.module.narrate?.(e, (id) => this.name(id));
      if (line !== undefined) glog("game", `${this.room.shortCode} ${line}`);

      // The log keeps the FULL event. Redaction is a wire concern.
      const type = (e as { type?: string }).type ?? "event";
      this.log.append(this.room.id, actorId, type, e, this.now());

      const wire = this.module.redactEvent?.(e) ?? e;
      if (wire !== undefined) this.callbacks.broadcast("event", wire);

      const fx = this.module.effects?.(this.state, e);
      if (fx?.clearTimer === true) this.clearTimer();
      if (fx?.timer !== undefined) this.armTimer(fx.timer);
      if (fx?.cue !== undefined) this.callbacks.toBoards("cue", { cue: fx.cue });
    }
    this.pushState();
    this.pushPrivate();
  }

  /**
   * Send each device its own projection.
   *
   * Boards get the no-viewer projection, which is the strictest view a game
   * offers — a board is a television in a room full of players, so "nobody in
   * particular is watching" is both the correct and the safest frame for it.
   */
  private pushState(): void {
    this.callbacks.toBoards("state", this.snapshot());
    for (const pid of this.room.players.keys()) {
      this.callbacks.toPlayer(pid, "state", this.snapshot(pid));
    }
  }

  /** Deliver private views that changed since last time. */
  private pushPrivate(): void {
    const views = this.module.privateViews?.(this.state) ?? {};
    for (const [pid, value] of Object.entries(views)) {
      const encoded = JSON.stringify(value);
      if (this.lastPrivate.get(pid) === encoded) continue;
      this.lastPrivate.set(pid, encoded);
      /**
       * The wire type stays "secret", not "private".
       *
       * It was tempting to rename it now that the payload is any game's private
       * view rather than specifically a card. But "secret" is the established
       * protocol word: the client reducer keys on it, and gateway.test.ts asserts
       * on it as part of the secret-isolation release blocker. Renaming would
       * have meant editing a leak test in the same commit that rewrites the leak
       * path — exactly the edit you never want to see in that diff. The name is
       * also still accurate: this is the channel for things one player may know.
       */
      this.callbacks.toPlayer(pid, "secret", value);
    }
    // A player who no longer has anything private (round over) is forgotten, so
    // next round's view counts as a change and gets delivered.
    for (const pid of [...this.lastPrivate.keys()]) {
      if (!(pid in views)) this.lastPrivate.delete(pid);
    }
  }

  /**
   * Apply a command. Identity is the AUTHENTICATED actor, always injected as
   * `actorId`, so a payload's identity claims can never be believed.
   */
  private dispatch(actorId: string, name: string, payload: Record<string, unknown>): void {
    const t = this.module.command(this.state, name, { ...payload, actorId }, this.now());
    this.state = t.state;
    this.record(actorId, t.events);
  }

  /**
   * Handle a client command.
   *
   * Two authorization rules, both game-agnostic: the host gate is whatever the
   * game declared in `hostOnlyCommands`, and everything else is the engine's own
   * business — it receives the real actor and throws if that actor may not act.
   * The runner deliberately does NOT pre-validate roles it cannot know (who the
   * Speaker is, who the Ghost is); that check belongs where the state lives.
   */
  command(playerId: string, isHost: boolean, name: string, payload: Record<string, unknown>): void {
    if ((this.module.hostOnlyCommands ?? []).includes(name) && !isHost) {
      throw new SessionError("HOST_ONLY", `Only the host may send "${name}".`);
    }
    this.dispatch(playerId, name, payload);
  }

  /** Start the first round on behalf of the room. */
  startFirstRound(): void {
    this.dispatch(SYSTEM_ACTOR, "round.start", {});
  }

  /** Redacted state for join/reconnect snapshots (with the phase deadline). */
  snapshot(viewerId?: string) {
    const view = this.module.project(this.state, viewerId === undefined ? { isBoard: true } : { viewerId });
    return { ...(view as object), deadline: this.deadline, serverTime: this.now() };
  }

  /**
   * Re-deliver this player's private view, if they have one.
   *
   * Replaces resendSecretIfSpeaker(). A reconnecting player is just a player
   * whose last-delivered view is unknown, so forgetting the cache entry and
   * re-pushing is the entire implementation — and it works for any game's notion
   * of who deserves a private channel.
   */
  redeliverPrivate(playerId: string): void {
    this.lastPrivate.delete(playerId);
    this.pushPrivate();
  }

  get status(): string {
    return String((this.state as { status?: unknown }).status ?? "UNKNOWN");
  }

  dispose(): void {
    this.clearTimer();
  }
}
