/**
 * Server-authoritative game session runner (spec §09).
 *
 * Owns: the game module's state, command validation by ROLE (never trust a
 * payload's identity claims), server timers, the event log, and — critically —
 * SECRET ISOLATION: full card contents go only to the Speaker's private
 * channel; everyone else sees redacted public state. A leaked secret is a
 * release blocker (spec §16), so redaction lives here in one choke point.
 */

import { sayLess } from "@gww/say-less";
import type { EngineEvent, RoundState, SessionState } from "@gww/say-less";
import type { EventLog } from "./log.js";
import { glog } from "./logger.js";
import type { Room } from "./rooms.js";

export interface SessionCallbacks {
  /** Broadcast a public event envelope payload to every device in the room. */
  broadcast(type: string, payload: unknown): void;
  /** Deliver a private message to exactly one player's device(s). */
  toPlayer(playerId: string, type: string, payload: unknown): void;
}

export class SessionError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/** Public projection of a round — no card contents until the round completes. */
function publicRound(round: RoundState | undefined) {
  if (round === undefined) return undefined;
  return {
    index: round.index,
    speakerId: round.speakerId,
    budget: round.budget,
    phase: round.phase,
    category: round.card.category,
    clue: round.clue,
    guessCount: round.guesses.length,
    guessedPlayerIds: round.guesses.map((g) => g.playerId),
    // The public guess feed — wrong guesses are half the comedy (spec §04:
    // "the humor comes from ... misunderstanding and the group's reaction").
    guesses: round.guesses.map((g) => ({ playerId: g.playerId, value: g.value, correct: g.correct })),
    winnerId: round.winnerId,
    endedReason: round.endedReason,
    // The card's reveal line goes public the moment the round completes.
    ...(round.phase === "COMPLETE" ? { revealLine: round.card.revealLine } : {}),
  };
}

/** Public projection of the whole session — NEVER includes the deck. */
export function publicState(state: SessionState) {
  return {
    status: state.status,
    roundIndex: state.roundIndex,
    maxRounds: state.config.maxRounds,
    scores: state.scores,
    round: publicRound(state.round),
  };
}

export class GameSession {
  private state: SessionState;

  constructor(
    private room: Room,
    seed: number,
    private log: EventLog,
    private callbacks: SessionCallbacks,
    private now: () => number = () => Date.now(),
    private clueTimeoutMs = 45_000,
    private guessTimeoutMs = 60_000,
  ) {
    const players = [...room.players.values()].map((p) => ({
      id: p.id,
      displayName: p.displayName,
    }));
    const t = sayLess.createSession(players, seed);
    this.state = t.state;
    this.record("game", t.events);
  }

  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Server-time deadline of the active phase timer, for client countdowns. */
  private deadline: number | undefined;

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = undefined;
  }

  private armTimer(ms: number): void {
    this.clearTimer();
    this.deadline = this.now() + ms;
    this.timer = setTimeout(() => {
      try {
        if (this.state.status === "IN_ROUND") {
          this.apply("game", (s) => sayLess.command(s, "round.end", { reason: "TIMEOUT" }, this.now()));
        }
      } catch {
        /* round already ended between fire and handling — nothing to do */
      }
    }, ms);
    // Never hold the process open for a party timer.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  private name(playerId: string | undefined): string {
    if (playerId === undefined) return "?";
    return this.room.players.get(playerId)?.displayName ?? playerId;
  }

  /** One narration line per engine event. The secret stays dark until reveal. */
  private narrate(e: EngineEvent): void {
    const code = this.room.shortCode;
    switch (e.type) {
      case "game.started":
        glog("game", `${code} game.started (${e.playerIds.length} players)`); return;
      case "round.started":
        glog("game", `${code} R${e.roundIndex + 1} started — speaker "${this.name(e.speakerId)}", card ${e.cardId}, ${e.budget}-word budget (secret withheld from log until reveal)`); return;
      case "clue.submitted":
        glog("game", `${code} R${e.roundIndex + 1} clue submitted by "${this.name(e.speakerId)}": "${e.clue}"`); return;
      case "clue.accepted":
        glog("game", `${code} R${e.roundIndex + 1} clue ACCEPTED (${e.wordCount} words) — guessing open`); return;
      case "clue.rejected":
        glog("game", `${code} R${e.roundIndex + 1} clue REJECTED (${e.reason}): ${e.detail}`); return;
      case "clue.flagged":
        glog("game", `${code} R${e.roundIndex + 1} clue FLAGGED — loophole vote: ${e.reason}`); return;
      case "guess.submitted":
        glog("game", `${code} R${e.roundIndex + 1} guess by "${this.name(e.playerId)}": "${e.value}"`); return;
      case "guess.accepted":
        glog("game", `${code} R${e.roundIndex + 1} CORRECT — "${this.name(e.playerId)}" got it!`); return;
      case "round.completed":
        glog("game", `${code} R${e.roundIndex + 1} complete (${e.reason}) — the secret was "${e.secret}"${e.winnerId !== undefined ? `, winner "${this.name(e.winnerId)}"` : ""}`); return;
      case "score.updated":
        glog("game", `${code} scores: ${Object.entries(e.totals).map(([id, v]) => `${this.name(id)}=${v}`).join(" ")}`); return;
      case "game.completed":
        glog("game", `${code} GAME COMPLETE — final: ${Object.entries(e.totals).map(([id, v]) => `${this.name(id)}=${v}`).join(" ")}`); return;
    }
  }

  /** Append engine events to the log and broadcast them (public payloads only). */
  private record(actorId: string, events: EngineEvent[]): void {
    for (const e of events) {
      this.narrate(e);
      this.log.append(this.room.id, actorId, e.type, e, this.now());
      this.callbacks.broadcast("event", e);
      if (e.type === "round.started") this.afterRoundStarted();
      if (e.type === "clue.accepted") this.armTimer(this.guessTimeoutMs);
      if (e.type === "round.completed" || e.type === "game.completed") this.clearTimer();
    }
    this.callbacks.broadcast("state", this.snapshot());
  }

  /** Private delivery of the secret card to the Speaker only (spec §04 step 2). */
  private afterRoundStarted(): void {
    const round = this.state.round;
    if (round === undefined) return;
    this.callbacks.toPlayer(round.speakerId, "secret", {
      roundIndex: round.index,
      card: {
        secret: round.card.secret,
        aliases: round.card.aliases,
        category: round.card.category,
        forbidden: round.card.forbidden,
        revealLine: round.card.revealLine,
      },
      budget: round.budget,
    });
    this.armTimer(this.clueTimeoutMs);
  }

  private apply(actorId: string, fn: (s: SessionState) => { state: SessionState; events: EngineEvent[] }): void {
    const t = fn(this.state);
    this.state = t.state;
    this.record(actorId, t.events);
  }

  /**
   * Handle a client command. Identity comes from the AUTHENTICATED player id
   * on the socket — payload identity claims are ignored by construction.
   */
  command(playerId: string, isHost: boolean, name: string, payload: Record<string, unknown>): void {
    const now = this.now();
    switch (name) {
      case "round.start": {
        if (!isHost) throw new SessionError("HOST_ONLY", "Only the host starts rounds.");
        this.apply(playerId, (s) => sayLess.command(s, "round.start", {}, now));
        return;
      }
      case "clue.submit": {
        const round = this.state.round;
        if (round === undefined || playerId !== round.speakerId) {
          throw new SessionError("NOT_SPEAKER", "Only the Speaker may submit a clue.");
        }
        const clue = String(payload["clue"] ?? "");
        this.apply(playerId, (s) => sayLess.command(s, "clue.submit", { speakerId: playerId, clue }, now));
        return;
      }
      case "guess.submit": {
        const value = String(payload["value"] ?? "");
        this.apply(playerId, (s) => sayLess.command(s, "guess.submit", { playerId, value }, now));
        return;
      }
      case "vote.resolve": {
        if (!isHost) throw new SessionError("HOST_ONLY", "Only the host resolves votes in v0.1.");
        const allow = payload["allow"] === true;
        this.apply(playerId, (s) => sayLess.command(s, "vote.resolve", { allow }, now));
        return;
      }
      case "round.end": {
        if (!isHost) throw new SessionError("HOST_ONLY", "Only the host may end a round.");
        this.apply(playerId, (s) => sayLess.command(s, "round.end", { reason: "HOST_ENDED" }, now));
        return;
      }
      default:
        throw new SessionError("UNKNOWN_COMMAND", `Unknown command "${name}".`);
    }
  }

  /** Redacted state for join/reconnect snapshots (with the phase deadline). */
  snapshot() {
    return { ...publicState(this.state), deadline: this.deadline, serverTime: this.now() };
  }

  /** Re-deliver the secret to a reconnecting Speaker — and ONLY the Speaker. */
  resendSecretIfSpeaker(playerId: string): void {
    const round = this.state.round;
    if (round !== undefined && round.phase !== "COMPLETE" && round.speakerId === playerId) {
      this.afterRoundStarted();
    }
  }

  get status() {
    return this.state.status;
  }

  dispose(): void {
    this.clearTimer();
  }
}
