/**
 * ODD ONE OUT — the smallest complete Games With Words game.
 *
 * READ THIS FIRST IF YOU ARE MAKING A GAME.
 *
 * Say Less is the reference implementation, and Ghostwriter is the second — but
 * between them they are about 1,100 lines of hard-won subtlety, and nobody should
 * have to read that to ship their first game. This file is the whole contract in
 * one screenful, with every platform surface used exactly once, so you can copy
 * the package and start deleting.
 *
 * THE GAME: everyone gets the same word except one player, who gets a different
 * one. Say your word out loud in turn, then the host ends the round and the odd
 * one out is revealed. That's it — the rules are trivial ON PURPOSE, so the only
 * thing this file teaches is the contract.
 *
 * WHAT THE PLATFORM GIVES YOU FOR FREE: private lobbies with QR join, sockets,
 * reconnects, the display board, the scoreboard, host assignment, timers, the
 * event log, and Ris's voice. You write rules and a projection.
 *
 * THE SIX HOUSE RULES (see CONTRIBUTING.md):
 *   1. Deterministic — seeded RNG only, never Math.random(). Marked [1] below.
 *   2. Server-authoritative — trust `actorId`, never a payload's claim. [2]
 *   3. Secrets on the private channel, never in public state. [3]
 *   4. Playable with zero AI. (This file never mentions a model.)
 *   5. Tested — see test/example.test.ts, including the kit conformance run.
 *   6. Kind by default — roast the move, never the person.
 */

import type { Effects, GameManifest, GameModule, ViewContext } from "@gww/kit";

/* ----------------------------------------------------------------- types */

export interface Player {
  id: string;
  displayName: string;
}

export interface Round {
  index: number;
  /** The word most players see. */
  common: string;
  /** The word exactly one player sees instead. */
  odd: string;
  /** Who got the odd word. NEVER goes into a public projection. [3] */
  oddPlayerId: string;
  phase: "TALKING" | "COMPLETE";
  /** Votes for who the room thinks is odd. slot = playerId here; no anonymity. */
  votes: { voterId: string; suspectId: string }[];
}

export interface State {
  seed: number;
  players: Player[];
  round?: Round;
  roundIndex: number;
  scores: Record<string, number>;
  status: "IDLE" | "IN_ROUND" | "COMPLETE";
}

export type Event =
  | { type: "game.started"; playerIds: string[] }
  | { type: "round.started"; roundIndex: number }
  | { type: "vote.submitted"; roundIndex: number; voterId: string }
  | { type: "round.completed"; roundIndex: number; oddPlayerId: string; common: string; odd: string }
  | { type: "game.completed"; totals: Record<string, number> };

export class GameError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

/* ------------------------------------------------- [1] seeded randomness */

/**
 * mulberry32 — the same tiny PRNG both shipped games use.
 *
 * Determinism is not a style preference here: the platform persists your events
 * and must be able to replay a session and get the identical result. One
 * Math.random() makes the log a work of fiction.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORD_PAIRS: [string, string][] = [
  ["beach", "desert"],
  ["cat", "dog"],
  ["coffee", "tea"],
  ["winter", "summer"],
  ["pizza", "pasta"],
];

/* ------------------------------------------------------------ the rules */

export function createSession(players: Player[], seed: number): { state: State; events: Event[] } {
  if (players.length < 3) throw new GameError("TOO_FEW_PLAYERS", "Odd One Out needs at least 3 players.");
  return {
    state: {
      seed,
      players,
      roundIndex: 0,
      scores: Object.fromEntries(players.map((p) => [p.id, 0])),
      status: "IDLE",
    },
    events: [{ type: "game.started", playerIds: players.map((p) => p.id) }],
  };
}

export function startRound(state: State): { state: State; events: Event[] } {
  if (state.status === "IN_ROUND") throw new GameError("ROUND_ACTIVE", "A round is already running.");

  // [1] Everything random is derived from seed + roundIndex, so a replay of the
  // same commands lands on the same word pair and the same odd player.
  const rng = mulberry32((state.seed ^ (state.roundIndex * 2654435761)) >>> 0);
  const pair = WORD_PAIRS[Math.floor(rng() * WORD_PAIRS.length)]!;
  const oddPlayer = state.players[Math.floor(rng() * state.players.length)]!;

  const round: Round = {
    index: state.roundIndex,
    common: pair[0],
    odd: pair[1],
    oddPlayerId: oddPlayer.id,
    phase: "TALKING",
    votes: [],
  };
  return {
    state: { ...state, round, status: "IN_ROUND" },
    // Note what this event does NOT carry: the words, or who is odd. Events go
    // on the wire to every device, so they are a leak surface too. [3]
    events: [{ type: "round.started", roundIndex: round.index }],
  };
}

export function submitVote(state: State, voterId: string, suspectId: string): { state: State; events: Event[] } {
  const round = state.round;
  if (round === undefined || round.phase !== "TALKING") throw new GameError("NO_ROUND", "Nothing to vote on.");
  if (!state.players.some((p) => p.id === voterId)) throw new GameError("NOT_A_PLAYER", "You are not in this session.");
  if (round.votes.some((v) => v.voterId === voterId)) throw new GameError("ALREADY_VOTED", "One vote each.");
  if (suspectId === voterId) throw new GameError("SELF_VOTE", "You cannot vote for yourself.");

  const votes = [...round.votes, { voterId, suspectId }];
  const withVote: State = { ...state, round: { ...round, votes } };
  const events: Event[] = [{ type: "vote.submitted", roundIndex: round.index, voterId }];

  if (votes.length < state.players.length) return { state: withVote, events };
  const done = endRound(withVote);
  return { state: done.state, events: [...events, ...done.events] };
}

/** Score and reveal. Called when every vote is in, or when the clock expires. */
export function endRound(state: State): { state: State; events: Event[] } {
  const round = state.round;
  if (round === undefined || round.phase === "COMPLETE") throw new GameError("NO_ROUND", "No live round.");

  const scores = { ...state.scores };
  for (const v of round.votes) {
    if (v.suspectId === round.oddPlayerId) scores[v.voterId] = (scores[v.voterId] ?? 0) + 100;
  }
  /**
   * The odd one out scores for every player they fooled — and their OWN vote
   * does not count as fooling anybody.
   *
   * Left in deliberately as a caught bug: the first version of this line was
   * `v.suspectId !== round.oddPlayerId`, which paid the odd player 50 for their
   * own (necessarily wrong) vote. The test one directory over found it. Scoring
   * is where every game hides an off-by-one, and it is the least visible place to
   * have one — nobody at the table audits the scoreboard.
   */
  const fooled = round.votes.filter(
    (v) => v.voterId !== round.oddPlayerId && v.suspectId !== round.oddPlayerId,
  ).length;
  scores[round.oddPlayerId] = (scores[round.oddPlayerId] ?? 0) + fooled * 50;

  return {
    state: {
      ...state,
      round: { ...round, phase: "COMPLETE" },
      scores,
      roundIndex: state.roundIndex + 1,
      status: "IDLE",
    },
    // The reveal is where the secret becomes public — and the only place it may.
    events: [
      { type: "round.completed", roundIndex: round.index, oddPlayerId: round.oddPlayerId, common: round.common, odd: round.odd },
    ],
  };
}

/* --------------------------------------------------- the platform surfaces */

export const MANIFEST: GameManifest = {
  gameId: "odd-one-out",
  title: "Odd One Out",
  tagline: "Everyone got the same word. Except one of you.",
  rulesVersion: "odd-one-out/1",
  credit: { maker: "Your Name Here", line: "The example game — copy me" },
  minPlayers: 3,
  maxPlayers: 10,
  sessionMinutes: [10, 20],
  categories: ["Mixed Chaos"],
};

/**
 * [3] What a device may see.
 *
 * Required by the contract. The words and the odd player's identity are the whole
 * game, so they are absent until the round completes. Note that the BOARD (no
 * viewerId) gets the same treatment as a player — it is a TV in a room full of
 * people, so it is the easiest possible way to leak.
 */
function project(state: State, _ctx: ViewContext): unknown {
  const round = state.round;
  return {
    status: state.status,
    roundIndex: state.roundIndex,
    scores: state.scores,
    round: round === undefined ? undefined : {
      index: round.index,
      phase: round.phase,
      votedPlayerIds: round.votes.map((v) => v.voterId),
      // Only at the reveal do the words and the culprit go public.
      ...(round.phase === "COMPLETE"
        ? { common: round.common, odd: round.odd, oddPlayerId: round.oddPlayerId, votes: round.votes }
        : {}),
    },
  };
}

/**
 * [3] Who must be told what.
 *
 * One entry per player: their own word, and nobody else's. The platform delivers
 * only what changed and re-delivers on reconnect, so you describe the CURRENT
 * truth and never think about timing.
 */
function privateViews(state: State): Record<string, unknown> {
  const round = state.round;
  if (round === undefined || round.phase === "COMPLETE") return {};
  const out: Record<string, unknown> = {};
  for (const p of state.players) {
    out[p.id] = {
      roundIndex: round.index,
      word: p.id === round.oddPlayerId ? round.odd : round.common,
      // Deliberately NOT telling them whether they are the odd one. That is the
      // game. (Ghostwriter makes the opposite call and tells its Ghost — your
      // call to make.)
    };
  }
  return out;
}

/** Clocks and voice cues. `onExpire` names one of YOUR commands. */
function effects(state: State, event: Event): Effects | undefined {
  switch (event.type) {
    case "round.started":
      // 90 seconds to talk it out, then the round ends itself.
      return { timer: { ms: 90_000, onExpire: "round.end" }, cue: "round" };
    case "round.completed":
      return { clearTimer: true };
    case "game.completed":
      return { clearTimer: true, cue: "outro" };
    default:
      return undefined;
  }
}

/** [2] Trust the platform's actorId over anything in the body. */
function actor(payload: unknown, claimed: string | undefined): string {
  const injected = (payload as { actorId?: unknown }).actorId;
  return typeof injected === "string" && injected !== "" ? injected : (claimed ?? "");
}

export const oddOneOut: GameModule<State, Event> = {
  manifest: MANIFEST,
  hostOnlyCommands: ["round.start", "round.end"],

  createSession: (players, seed) => createSession(players, seed),

  command(state, name, payload, _now) {
    const p = payload as { suspectId?: string; voterId?: string };
    switch (name) {
      case "round.start":
        return startRound(state);
      case "vote.cast":
        return submitVote(state, actor(payload, p.voterId), p.suspectId ?? "");
      case "round.end":
        return endRound(state);
      default:
        throw new GameError("UNKNOWN_COMMAND", `Odd One Out has no command "${name}".`);
    }
  },

  project,
  privateViews,
  effects,

  narrate(event) {
    if (event.type === "round.started") return `R${event.roundIndex + 1} started (words withheld until reveal)`;
    if (event.type === "round.completed") return `R${event.roundIndex + 1} complete — odd word was "${event.odd}"`;
    return undefined;
  },
};

export default oddOneOut;
