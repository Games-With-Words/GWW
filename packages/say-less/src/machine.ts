/**
 * Server-authoritative Say Less state machine (spec §09 game engine).
 *
 * Pure and deterministic: every transition takes explicit `now` (server time, ms)
 * and returns { state, events }. The lobby/gateway layer owns the clock, wraps
 * EngineEvents in the room event envelope, and persists them to the NEDB log.
 * Replaying the same commands with the same times reproduces the same session.
 */

import { mulberry32, nextCycle } from "./rotation.js";
import { matchGuess, validateClue } from "./rules.js";
import { scoreRound } from "./scoring.js";
import { normalize } from "./normalize.js";
import type {
  Card,
  EngineEvent,
  Player,
  RoundState,
  SessionConfig,
  SessionState,
} from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export interface Transition {
  state: SessionState;
  events: EngineEvent[];
}

export class EngineError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

function rng(state: SessionState): () => number {
  // Derive per-decision randomness from seed + roundIndex + cycle so replay is stable
  // regardless of how many times the rng was consumed earlier.
  return mulberry32((state.config.seed ^ (state.roundIndex * 2654435761) ^ (state.cycle * 40503)) >>> 0);
}

export function createSession(
  players: Player[],
  deck: Card[],
  config: Partial<SessionConfig> & { seed: number },
): Transition {
  if (players.length < 2) throw new EngineError("TOO_FEW_PLAYERS", "Say Less needs at least 2 players.");
  if (deck.length === 0) throw new EngineError("EMPTY_DECK", "Deck has no cards.");
  const cfg: SessionConfig = { ...DEFAULT_CONFIG, ...config };
  const base: SessionState = {
    config: cfg,
    players,
    rotation: [],
    rotationCursor: 0,
    cycle: 0,
    deck,
    deckCursor: 0,
    roundIndex: 0,
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    scoreLog: [],
    status: "IDLE",
  };
  const rotation = nextCycle(players.map((p) => p.id), mulberry32(cfg.seed));
  const state: SessionState = { ...base, rotation };
  return {
    state,
    events: [{ type: "game.started", playerIds: players.map((p) => p.id), seed: cfg.seed }],
  };
}

function currentBudget(state: SessionState): number {
  const budgets = state.config.phaseBudgets;
  const phase = Math.min(state.cycle, budgets.length - 1);
  return budgets[phase] ?? budgets[budgets.length - 1] ?? 5;
}

export function startRound(state: SessionState): Transition {
  if (state.status === "COMPLETE") throw new EngineError("GAME_OVER", "Session is complete.");
  if (state.status === "IN_ROUND") throw new EngineError("ROUND_ACTIVE", "A round is already active.");
  if (state.roundIndex >= state.config.maxRounds || state.deckCursor >= state.deck.length) {
    return complete(state);
  }

  let s = state;
  if (s.rotationCursor >= s.rotation.length) {
    const last = s.rotation[s.rotation.length - 1];
    const cycle = s.cycle + 1;
    const rotation = nextCycle(
      s.players.map((p) => p.id),
      mulberry32((s.config.seed ^ (cycle * 97)) >>> 0),
      last,
    );
    s = { ...s, rotation, rotationCursor: 0, cycle };
  }

  const speakerId = s.rotation[s.rotationCursor]!;
  const card = s.deck[s.deckCursor]!;
  const budget = currentBudget(s);
  const round: RoundState = {
    index: s.roundIndex,
    speakerId,
    card,
    budget,
    phase: "AWAITING_CLUE",
    guesses: [],
  };
  const next: SessionState = {
    ...s,
    round,
    status: "IN_ROUND",
    rotationCursor: s.rotationCursor + 1,
    deckCursor: s.deckCursor + 1,
  };
  return {
    state: next,
    events: [
      { type: "round.started", roundIndex: round.index, speakerId, cardId: card.id, budget },
    ],
  };
}

export function submitClue(state: SessionState, speakerId: string, clue: string, now: number): Transition {
  const round = requireRound(state, "AWAITING_CLUE");
  if (speakerId !== round.speakerId) throw new EngineError("NOT_SPEAKER", "Only the Speaker may submit a clue.");

  const events: EngineEvent[] = [
    { type: "clue.submitted", roundIndex: round.index, speakerId, clue },
  ];
  const verdict = validateClue(round.card, clue, round.budget);

  if (verdict.status === "REJECTED") {
    // Spec §04 scoring: clue rejected -> 0 for the round; round ends.
    const ended: RoundState = { ...round, phase: "COMPLETE", endedReason: "CLUE_REJECTED" };
    events.push({ type: "clue.rejected", roundIndex: round.index, reason: verdict.reason, detail: verdict.detail });
    events.push({
      type: "round.completed",
      roundIndex: round.index,
      reason: "CLUE_REJECTED",
      secret: round.card.secret,
    });
    return finishRound({ ...state, round: ended }, events);
  }

  if (verdict.status === "SUSPICIOUS") {
    const voting: RoundState = { ...round, phase: "VOTING", clue, clueNormalized: verdict.normalized };
    events.push({ type: "clue.flagged", roundIndex: round.index, reason: verdict.reason });
    return { state: { ...state, round: voting }, events };
  }

  const accepted: RoundState = {
    ...round,
    phase: "GUESSING",
    clue,
    clueNormalized: verdict.normalized,
    clueAcceptedAt: now,
  };
  events.push({ type: "clue.accepted", roundIndex: round.index, clue, wordCount: verdict.wordCount });
  return { state: { ...state, round: accepted }, events };
}

/** Resolve a room vote on a SUSPICIOUS clue. The party retains final authority (spec §04). */
export function resolveVote(state: SessionState, allow: boolean, now: number): Transition {
  const round = requireRound(state, "VOTING");
  if (allow) {
    const accepted: RoundState = { ...round, phase: "GUESSING", clueAcceptedAt: now };
    return {
      state: { ...state, round: accepted },
      events: [
        {
          type: "clue.accepted",
          roundIndex: round.index,
          clue: round.clue ?? "",
          wordCount: (round.clueNormalized ?? "").split(" ").filter(Boolean).length,
        },
      ],
    };
  }
  const ended: RoundState = { ...round, phase: "COMPLETE", endedReason: "VOTE_REJECTED" };
  return finishRound({ ...state, round: ended }, [
    { type: "round.completed", roundIndex: round.index, reason: "VOTE_REJECTED", secret: round.card.secret },
  ]);
}

export function submitGuess(state: SessionState, playerId: string, value: string, now: number): Transition {
  const round = requireRound(state, "GUESSING");
  if (playerId === round.speakerId) throw new EngineError("SPEAKER_CANNOT_GUESS", "The Speaker may not guess.");
  if (round.guesses.some((g) => g.playerId === playerId)) {
    throw new EngineError("ALREADY_GUESSED", "One guess per player per clue.");
  }

  const correct = matchGuess(round.card, value);
  const record = { playerId, value, normalized: normalize(value), at: now, correct };
  const withGuess: RoundState = { ...round, guesses: [...round.guesses, record] };
  const events: EngineEvent[] = [
    { type: "guess.submitted", roundIndex: round.index, playerId, value },
  ];

  if (!correct) {
    return { state: { ...state, round: withGuess }, events };
  }

  events.push({ type: "guess.accepted", roundIndex: round.index, playerId });
  const ended: RoundState = { ...withGuess, phase: "COMPLETE", endedReason: "CORRECT", winnerId: playerId };
  events.push({
    type: "round.completed",
    roundIndex: round.index,
    reason: "CORRECT",
    winnerId: playerId,
    secret: round.card.secret,
  });
  return finishRound({ ...state, round: ended }, events);
}

/** Server-driven timeout or explicit host end (spec §04 core round, step 8). */
export function endRound(state: SessionState, reason: "TIMEOUT" | "HOST_ENDED"): Transition {
  const round = state.round;
  if (round === undefined || round.phase === "COMPLETE") {
    throw new EngineError("NO_ROUND", "No active round to end.");
  }
  const ended: RoundState = { ...round, phase: "COMPLETE", endedReason: reason };
  return finishRound({ ...state, round: ended }, [
    { type: "round.completed", roundIndex: round.index, reason, secret: round.card.secret },
  ]);
}

function finishRound(state: SessionState, events: EngineEvent[]): Transition {
  const round = state.round!;
  const eligible = state.players.length - 1;
  const scoreEvents = scoreRound(round, eligible, state.config);
  const scores = { ...state.scores };
  for (const e of scoreEvents) scores[e.playerId] = (scores[e.playerId] ?? 0) + e.delta;

  let next: SessionState = {
    ...state,
    scores,
    scoreLog: [...state.scoreLog, ...scoreEvents],
    roundIndex: state.roundIndex + 1,
    status: "IDLE",
    round,
  };
  if (scoreEvents.length > 0) {
    events.push({ type: "score.updated", events: scoreEvents, totals: scores });
  }
  if (next.roundIndex >= next.config.maxRounds || next.deckCursor >= next.deck.length) {
    const done = complete(next);
    return { state: done.state, events: [...events, ...done.events] };
  }
  return { state: next, events };
}

function complete(state: SessionState): Transition {
  const next: SessionState = { ...state, status: "COMPLETE" };
  return { state: next, events: [{ type: "game.completed", totals: next.scores }] };
}

function requireRound(state: SessionState, phase: RoundState["phase"]): RoundState {
  const round = state.round;
  if (state.status !== "IN_ROUND" || round === undefined) {
    throw new EngineError("NO_ROUND", "No active round.");
  }
  if (round.phase !== phase) {
    throw new EngineError("WRONG_PHASE", `Expected ${phase}, round is ${round.phase}.`);
  }
  return round;
}
