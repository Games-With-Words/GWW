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
    // WHO has answered is public — the room needs "waiting on two more".
    guessedPlayerIds: round.guesses.map((g) => g.playerId),
    // WHAT they answered is NOT, until the round is over.
    //
    // The guess feed used to broadcast playerId + value live, because wrong
    // guesses are half the comedy (spec §04). That is still true — but the
    // community ballot is anonymous, and a live feed naming every author makes
    // the anonymity pure theatre. The comedy now lands at the reveal, all at
    // once, which is a better beat anyway.
    guesses: round.phase === "COMPLETE"
      ? round.guesses.map((g) => ({ playerId: g.playerId, value: g.value, correct: g.correct }))
      : [],
    winnerId: round.winnerId,
    endedReason: round.endedReason,
    // The ANONYMIZED ballot. ballotOwners is deliberately absent — the owner
    // map never crosses the wire until it arrives inside `reveal`.
    ...(round.ballot !== undefined ? { ballot: round.ballot } : {}),
    votedBy: round.votes.map((v) => ({ voterId: v.voterId, category: v.category })),
    ...(round.reveal !== undefined ? { reveal: round.reveal } : {}),
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
    private ballotTimeoutMs = 15_000,
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

  /**
   * What a expiring clock means depends on WHICH phase is running.
   *
   * Before the rework every timeout ended the round. Now a guessing timeout
   * opens the ballot (the round is not over — the room still votes on what
   * came in) and a ballot timeout closes it, counting whatever arrived.
   */
  private onDeadline(): void {
    const phase = this.state.round?.phase;
    if (phase === "GUESSING") {
      this.apply("game", (s) => sayLess.command(s, "guessing.close", {}, this.now()));
      return;
    }
    if (phase === "BALLOT") {
      this.apply("game", (s) => sayLess.command(s, "ballot.close", {}, this.now()));
      return;
    }
    this.apply("game", (s) => sayLess.command(s, "round.end", { reason: "TIMEOUT" }, this.now()));
  }

  private armTimer(ms: number): void {
    this.clearTimer();
    this.deadline = this.now() + ms;
    this.timer = setTimeout(() => {
      try {
        if (this.state.status === "IN_ROUND") {
          this.onDeadline();
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

  /**
   * Public projection of an EVENT.
   *
   * The log keeps the full event; the wire gets a redacted one. `guess.submitted`
   * carries playerId AND value, which would hand every device the exact
   * authorship the anonymous ballot exists to hide — a state-level redaction
   * alone is not enough when the event stream says the same thing out loud.
   */
  private publicEvent(e: EngineEvent): EngineEvent | { type: string; [k: string]: unknown } {
    if (e.type === "guess.submitted") {
      // Who answered, not what. The text lands at the reveal, all at once.
      return { type: e.type, roundIndex: e.roundIndex, playerId: e.playerId };
    }
    if (e.type === "guess.accepted") {
      // "Somebody got it" would tell the room which ballot slot is correct
      // before they vote on CLOSEST. Withhold until the reveal.
      return { type: e.type, roundIndex: e.roundIndex };
    }
    return e;
  }

  /** Append engine events to the log and broadcast them (public payloads only). */
  private record(actorId: string, events: EngineEvent[]): void {
    for (const e of events) {
      this.narrate(e);
      this.log.append(this.room.id, actorId, e.type, e, this.now());
      this.callbacks.broadcast("event", this.publicEvent(e));
      if (e.type === "round.started") this.afterRoundStarted();
      if (e.type === "clue.accepted") this.armTimer(this.guessTimeoutMs);
      // The ballot gets its own, much shorter clock — a vote is a reflex, not
      // a deliberation, and party games die on dead time.
      if (e.type === "ballot.opened") this.armTimer(this.ballotTimeoutMs);
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
      case "ballot.vote": {
        // The voter is ALWAYS the connected player — never taken from the
        // payload, or one phone could cast another player's ballot.
        const category = payload["category"] === "CLOSEST" ? "CLOSEST" : "FUNNIEST";
        const slotId = String(payload["slotId"] ?? "");
        this.apply(playerId, (s) =>
          sayLess.command(s, "ballot.vote", { voterId: playerId, category, slotId }, now));
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
