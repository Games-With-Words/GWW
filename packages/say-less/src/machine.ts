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
  BallotSlot,
  Card,
  EngineEvent,
  Player,
  RoundReveal,
  RoundState,
  SessionConfig,
  SessionState,
  VoteCategory,
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
    votes: [],
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

  if (correct) events.push({ type: "guess.accepted", roundIndex: round.index, playerId });

  // A correct guess NO LONGER ends the round. Everyone gets their one guess,
  // then the room votes. Ending early would rob the ballot of its material and
  // hand the win to whoever types fastest — which was never the game.
  const everyoneGuessed = withGuess.guesses.length >= state.players.length - 1;
  if (!everyoneGuessed) {
    return { state: { ...state, round: withGuess }, events };
  }
  return closeGuessing({ ...state, round: withGuess }, events);
}

/**
 * Deterministic shuffle (Fisher-Yates over a seeded LCG).
 *
 * Submission order LEAKS IDENTITY — everyone knows who types fast. But a
 * random shuffle would break replay, so the order is derived from the session
 * seed and round index: unguessable to players, identical on every replay.
 */
export function shuffleSeeded<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = (seed >>> 0) || 1;
  const next = (): number => {
    // Numerical Recipes LCG — small, deterministic, good enough to hide order.
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Who may vote in each category. The Speaker knows the secret (Mark's call). */
export function electorate(state: SessionState, category: VoteCategory): string[] {
  const speakerId = state.round?.speakerId;
  // FUNNIEST: everyone, including the Speaker — they're in the room.
  if (category === "FUNNIEST") return state.players.map((p) => p.id);
  // CLOSEST: guessers only. A Speaker who knows the answer isn't voting, they
  // are adjudicating, and that is not a room opinion.
  return state.players.map((p) => p.id).filter((id) => id !== speakerId);
}

/**
 * Guessing is over. Open the ballot, or finish immediately in a small room.
 *
 * Called when every guesser has answered, or when the clock runs out.
 */
export function closeGuessing(state: SessionState, events: EngineEvent[] = []): Transition {
  const round = state.round;
  if (round === undefined || round.phase !== "GUESSING") {
    throw new EngineError("NO_ROUND", "No guessing round to close.");
  }
  const anyCorrect = round.guesses.some((g) => g.correct);
  const winnerId = [...round.guesses].filter((g) => g.correct).sort((a, b) => a.at - b.at)[0]?.playerId;

  // Too few players, or nothing to vote on: skip the pause entirely.
  const canBallot =
    state.players.length >= state.config.minPlayersForBallot && round.guesses.length >= 2;
  if (!canBallot) {
    return completeRound(state, round, anyCorrect, winnerId, events);
  }

  // Shuffle the GUESSES, then assign slot ids by position — so a slot id says
  // nothing about who submitted when. Seeded per round, so replay is identical.
  const shuffled = shuffleSeeded(
    round.guesses.map((g) => ({ text: g.value, owner: g.playerId })),
    state.config.seed + round.index * 7919,
  );
  const ballot: BallotSlot[] = shuffled.map((g, i) => ({ slotId: `slot${i}`, text: g.text }));
  const ballotOwners: Record<string, string> = {};
  shuffled.forEach((g, i) => { ballotOwners[`slot${i}`] = g.owner; });

  const open: RoundState = {
    ...round, phase: "BALLOT", ballot, ballotOwners,
    ...(winnerId !== undefined ? { winnerId } : {}),
  };
  return {
    state: { ...state, round: open },
    events: [...events, { type: "ballot.opened", roundIndex: round.index, slots: ballot }],
  };
}

/** Cast one vote. Enforces the rules players cannot see well enough to self-police. */
export function submitVote(
  state: SessionState,
  voterId: string,
  category: VoteCategory,
  slotId: string,
): Transition {
  const round = requireRound(state, "BALLOT");
  if (!electorate(state, category).includes(voterId)) {
    throw new EngineError("NOT_ELIGIBLE", `${voterId} may not vote on ${category}.`);
  }
  if (round.ballot?.some((s) => s.slotId === slotId) !== true) {
    throw new EngineError("NO_SUCH_SLOT", `No ballot slot ${slotId}.`);
  }
  // Self-voting is invisible to players on an anonymized ballot, so it can
  // never be left to trust.
  if (round.ballotOwners?.[slotId] === voterId) {
    throw new EngineError("SELF_VOTE", "You cannot vote for your own guess.");
  }
  if (round.votes.some((v) => v.voterId === voterId && v.category === category)) {
    throw new EngineError("ALREADY_VOTED", `Already voted on ${category}.`);
  }

  const votes = [...round.votes, { voterId, category, slotId }];
  const voted: RoundState = { ...round, votes };
  const events: EngineEvent[] = [
    { type: "vote.submitted", roundIndex: round.index, voterId, category },
  ];

  // Per-category completion: the Speaker only ever casts one vote, so "every
  // player cast two" would hang the phase forever.
  const done = (["FUNNIEST", "CLOSEST"] as VoteCategory[]).every((c) =>
    electorate(state, c).every((id) => votes.some((v) => v.voterId === id && v.category === c)),
  );
  if (!done) return { state: { ...state, round: voted }, events };
  return closeBallot({ ...state, round: voted }, events);
}

/** Tally, reveal, score. Called when every vote is in or the clock expires. */
export function closeBallot(state: SessionState, events: EngineEvent[] = []): Transition {
  const round = state.round;
  if (round === undefined || round.phase !== "BALLOT") {
    throw new EngineError("NO_BALLOT", "No open ballot to close.");
  }
  const anyCorrect = round.guesses.some((g) => g.correct);
  return completeRound(state, round, anyCorrect, round.winnerId,
    [...events, { type: "ballot.closed", roundIndex: round.index }]);
}

/** Top slots in a category. Ties are SHARED — cheaper than a runoff, funnier. */
export function tally(round: RoundState, category: VoteCategory): { slotId: string; playerId: string; votes: number }[] {
  const counts = new Map<string, number>();
  for (const v of round.votes) {
    if (v.category !== category) continue;
    counts.set(v.slotId, (counts.get(v.slotId) ?? 0) + 1);
  }
  if (counts.size === 0) return [];
  const top = Math.max(...counts.values());
  return [...counts.entries()]
    .filter(([, n]) => n === top)
    .map(([slotId, n]) => ({ slotId, playerId: round.ballotOwners?.[slotId] ?? "", votes: n }))
    .sort((a, b) => a.slotId.localeCompare(b.slotId));
}

/** Build the reveal, score the round, emit. The identity map drops HERE. */
function completeRound(
  state: SessionState,
  round: RoundState,
  anyCorrect: boolean,
  winnerId: string | undefined,
  events: EngineEvent[],
): Transition {
  const reason = anyCorrect ? "CORRECT" as const : "TIMEOUT" as const;
  const reveal: RoundReveal = {
    secret: round.card.secret,
    owners: round.ballotOwners ?? {},
    correctPlayerIds: round.guesses.filter((g) => g.correct).map((g) => g.playerId),
    funniest: tally(round, "FUNNIEST"),
    closest: tally(round, "CLOSEST"),
  };
  const ended: RoundState = {
    ...round, phase: "COMPLETE", endedReason: reason, reveal,
    ...(winnerId !== undefined ? { winnerId } : {}),
  };
  const all: EngineEvent[] = [...events,
    { type: "round.revealed", roundIndex: round.index, reveal },
    {
      type: "round.completed", roundIndex: round.index, reason,
      ...(winnerId !== undefined ? { winnerId } : {}),
      secret: round.card.secret,
    },
  ];
  return finishRound({ ...state, round: ended }, all);
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
