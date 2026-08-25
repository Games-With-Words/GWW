/**
 * Server-authoritative Ghostwriter state machine (spec §09 game engine).
 *
 * Pure and deterministic: every transition takes explicit `now` (server time, ms)
 * and returns { state, events }. The platform owns the clock, the sockets, the
 * private delivery and the event log; this file owns the rules. Replaying the
 * same commands with the same times reproduces the same session exactly.
 *
 * Round shape:  ANSWERING -> VOTING -> [LAST_WORD] -> COMPLETE
 */

import { mulberry32, nextCycle, slotOrder } from "./rotation.js";
import { framedPlayer, isCaught, matchLastWord, tallyVotes, validateAnswer } from "./rules.js";
import { scoreRound } from "./scoring.js";
import { normalize } from "./normalize.js";
import type {
  AnswerRecord,
  AnswerSlot,
  EngineEvent,
  Player,
  PromptCard,
  RoundReveal,
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

export function createSession(
  players: Player[],
  deck: PromptCard[],
  config: Partial<SessionConfig> & { seed: number },
): Transition {
  /**
   * Three is the real floor, not a cautious one. With two players the vote is
   * one person picking between their own answer and the only other answer, and
   * the Ghost is whoever didn't get a prompt — there is nothing to deduce.
   */
  if (players.length < 3) throw new EngineError("TOO_FEW_PLAYERS", "Ghostwriter needs at least 3 players.");
  if (deck.length === 0) throw new EngineError("EMPTY_DECK", "Deck has no prompt cards.");

  const cfg: SessionConfig = { ...DEFAULT_CONFIG, ...config };
  const rotation = nextCycle(players.map((p) => p.id), mulberry32(cfg.seed));
  const state: SessionState = {
    config: cfg,
    players,
    rotation,
    rotationCursor: 0,
    cycle: 0,
    deck,
    deckCursor: 0,
    roundIndex: 0,
    scores: Object.fromEntries(players.map((p) => [p.id, 0])),
    scoreLog: [],
    status: "IDLE",
  };
  return {
    state,
    events: [{ type: "game.started", playerIds: players.map((p) => p.id), seed: cfg.seed }],
  };
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

  const ghostId = s.rotation[s.rotationCursor]!;
  const card = s.deck[s.deckCursor]!;
  const round: RoundState = {
    index: s.roundIndex,
    ghostId,
    card,
    phase: "ANSWERING",
    answers: [],
    votes: [],
  };
  return {
    state: { ...s, round, status: "IN_ROUND", rotationCursor: s.rotationCursor + 1, deckCursor: s.deckCursor + 1 },
    events: [
      // No ghostId on the wire, and no prompt text. The platform delivers the
      // prompt privately to everyone EXCEPT the ghost; the public event says
      // only that a round started and which category it is.
      { type: "round.started", roundIndex: round.index, cardId: card.id, category: card.category },
    ],
  };
}

/**
 * Submit one answer. Everyone writes at once, including the Ghost.
 *
 * A rejection does NOT end the round or consume the player's turn — they get to
 * try again until the clock runs out. This is the opposite of Say Less, where a
 * bad clue ends the round at zero, and the difference is deliberate: there, the
 * Speaker broke a rule they could see. Here the most common rejection is
 * TOO_TELLING, which fires on an answer that felt completely reasonable to
 * write, and killing the round for it would punish the innocent player for the
 * Ghost's benefit.
 */
export function submitAnswer(state: SessionState, playerId: string, text: string, now: number): Transition {
  const round = requireRound(state, "ANSWERING");
  if (!state.players.some((p) => p.id === playerId)) {
    throw new EngineError("NOT_A_PLAYER", `${playerId} is not in this session.`);
  }
  if (round.answers.some((a) => a.playerId === playerId)) {
    throw new EngineError("ALREADY_ANSWERED", "One answer per player per round.");
  }

  const verdict = validateAnswer(
    round.card,
    text,
    round.answers,
    state.config.answerWords,
    playerId === round.ghostId,
  );
  if (verdict.status === "REJECTED") {
    return {
      state,
      events: [
        {
          type: "answer.rejected",
          roundIndex: round.index,
          playerId,
          reason: verdict.reason,
          detail: verdict.detail,
        },
      ],
    };
  }

  const record: AnswerRecord = { playerId, text, normalized: verdict.normalized, at: now };
  const withAnswer: RoundState = { ...round, answers: [...round.answers, record] };
  const events: EngineEvent[] = [{ type: "answer.submitted", roundIndex: round.index, playerId }];

  if (withAnswer.answers.length < state.players.length) {
    return { state: { ...state, round: withAnswer }, events };
  }
  return closeAnswers({ ...state, round: withAnswer }, events);
}

/**
 * Writing is over: anonymize the answers and open the hunt.
 *
 * Called when everyone has answered or when the clock expires.
 */
export function closeAnswers(state: SessionState, events: EngineEvent[] = []): Transition {
  const round = state.round;
  if (round === undefined || round.phase !== "ANSWERING") {
    throw new EngineError("NO_ROUND", "No answering round to close.");
  }

  /**
   * A Ghost who never wrote cannot be caught — there is no slot to point at. If
   * that scored as survival, the winning strategy would be to put the phone
   * down, so a silent Ghost is a NO_CONTEST worth nothing to anybody.
   */
  const ghostAnswered = round.answers.some((a) => a.playerId === round.ghostId);
  if (!ghostAnswered || round.answers.length < state.config.minAnswersForVote) {
    return completeRound(state, { ...round, phase: "COMPLETE" }, "NO_CONTEST", events);
  }

  const ordered = slotOrder(round.answers, state.config.seed, round.index);
  const slots: AnswerSlot[] = ordered.map((a, i) => ({ slotId: `slot${i}`, text: a.text }));
  const slotOwners: Record<string, string> = {};
  ordered.forEach((a, i) => { slotOwners[`slot${i}`] = a.playerId; });

  const voting: RoundState = { ...round, phase: "VOTING", slots, slotOwners };
  return {
    state: { ...state, round: voting },
    events: [...events, { type: "answers.closed", roundIndex: round.index, slots }],
  };
}

/**
 * Who may vote: everyone who wrote an answer, the Ghost included.
 *
 * The Ghost voting is not a courtesy, it is cover — a Ghost who abstained would
 * be identifiable from the vote record alone, and the platform broadcasts who
 * has voted so the room knows who it is waiting on. Players who never answered
 * are excluded: voting without having exposed an answer is risk-free influence.
 */
export function electorate(round: RoundState): string[] {
  return round.answers.map((a) => a.playerId);
}

export function submitVote(state: SessionState, voterId: string, slotId: string, now: number): Transition {
  const round = requireRound(state, "VOTING");
  if (!electorate(round).includes(voterId)) {
    throw new EngineError("NOT_ELIGIBLE", "Only players who answered may vote.");
  }
  if (round.slots?.some((s) => s.slotId === slotId) !== true) {
    throw new EngineError("NO_SUCH_SLOT", `No slot ${slotId} on the board.`);
  }
  // Invisible on an anonymized board, so it can never be left to trust.
  if (round.slotOwners?.[slotId] === voterId) {
    throw new EngineError("SELF_VOTE", "You cannot vote for your own answer.");
  }
  if (round.votes.some((v) => v.voterId === voterId)) {
    throw new EngineError("ALREADY_VOTED", "One vote per player per round.");
  }

  const votes = [...round.votes, { voterId, slotId, at: now }];
  const voted: RoundState = { ...round, votes };
  const events: EngineEvent[] = [{ type: "vote.submitted", roundIndex: round.index, voterId }];

  const done = electorate(round).every((id) => votes.some((v) => v.voterId === id));
  if (!done) return { state: { ...state, round: voted }, events };
  return closeVotes({ ...state, round: voted }, events);
}

/**
 * Votes are in. Either the Ghost walks, or they get one last word.
 *
 * Called when everyone has voted or when the clock expires.
 */
export function closeVotes(state: SessionState, events: EngineEvent[] = []): Transition {
  const round = state.round;
  if (round === undefined || round.phase !== "VOTING") {
    throw new EngineError("NO_VOTE", "No open vote to close.");
  }
  const owners = round.slotOwners ?? {};
  const ghostSlotId = Object.keys(owners).find((slot) => owners[slot] === round.ghostId);
  const caught = isCaught(tallyVotes(round.votes, owners), ghostSlotId);
  const closed: EngineEvent[] = [...events, { type: "votes.closed", roundIndex: round.index }];

  if (!caught) {
    return completeRound(state, { ...round, phase: "COMPLETE" }, "SCORED", [
      ...closed,
      { type: "ghost.survived", roundIndex: round.index },
    ]);
  }
  // Caught — but the round is not over. The Ghost has been staring at other
  // people's answers for a minute and may have worked out the question.
  return {
    state: { ...state, round: { ...round, phase: "LAST_WORD" } },
    events: [...closed, { type: "ghost.caught", roundIndex: round.index }],
  };
}

/** The caught Ghost names the prompt they never saw. One attempt. */
export function submitLastWord(state: SessionState, ghostId: string, text: string, now: number): Transition {
  const round = requireRound(state, "LAST_WORD");
  if (ghostId !== round.ghostId) throw new EngineError("NOT_GHOST", "Only the Ghost gets the last word.");
  if (round.lastWord !== undefined) throw new EngineError("ALREADY_ANSWERED", "The Ghost gets one attempt.");
  if (normalize(text).length === 0) throw new EngineError("EMPTY", "Say something.");

  const correct = matchLastWord(round.card, text);
  const withWord: RoundState = { ...round, lastWord: { text, correct }, phase: "COMPLETE" };
  return completeRound(state, withWord, "SCORED", [
    { type: "lastword.submitted", roundIndex: round.index, text, correct },
  ]);
}

/** The Ghost let the last-word clock run out. Score the round without it. */
export function closeLastWord(state: SessionState, events: EngineEvent[] = []): Transition {
  const round = state.round;
  if (round === undefined || round.phase !== "LAST_WORD") {
    throw new EngineError("NO_LAST_WORD", "No open last word to close.");
  }
  return completeRound(state, { ...round, phase: "COMPLETE" }, "SCORED", events);
}

/** Server-driven timeout or explicit host end, from any phase. */
export function endRound(state: SessionState, reason: "TIMEOUT" | "HOST_ENDED"): Transition {
  const round = state.round;
  if (round === undefined || round.phase === "COMPLETE") {
    throw new EngineError("NO_ROUND", "No active round to end.");
  }
  return completeRound(state, { ...round, phase: "COMPLETE" }, reason, []);
}

/**
 * Build the reveal, score, emit. The owner map and the prompt drop HERE and
 * nowhere earlier — this function is the anonymity boundary of the whole game.
 */
function completeRound(
  state: SessionState,
  round: RoundState,
  reason: NonNullable<RoundState["endedReason"]>,
  events: EngineEvent[],
): Transition {
  const owners = round.slotOwners ?? {};
  const ghostSlotId = Object.keys(owners).find((slot) => owners[slot] === round.ghostId);
  const tally = tallyVotes(round.votes, owners);
  const caught = isCaught(tally, ghostSlotId);
  // The Ghost's own vote is cover, not the room's opinion — it convicts, but it
  // must never frame. Same split as scoring.ts, for the same live-caught reason.
  const framed = framedPlayer(tallyVotes(round.votes.filter((v) => v.voterId !== round.ghostId), owners), ghostSlotId);

  const reveal: RoundReveal = {
    prompt: round.card.prompt,
    essence: round.card.essence,
    ghostId: round.ghostId,
    owners,
    tally,
    caught,
    catcherIds: round.votes.filter((v) => v.slotId === ghostSlotId).map((v) => v.voterId),
    ...(ghostSlotId !== undefined ? { ghostSlotId } : {}),
    ...(framed !== undefined ? { framedId: framed } : {}),
    ...(round.lastWord !== undefined ? { lastWord: round.lastWord } : {}),
  };

  const ended: RoundState = { ...round, phase: "COMPLETE", endedReason: reason, reveal };
  const all: EngineEvent[] = [
    ...events,
    { type: "round.revealed", roundIndex: round.index, reveal },
    { type: "round.completed", roundIndex: round.index, reason },
  ];
  return finishRound({ ...state, round: ended }, all);
}

function finishRound(state: SessionState, events: EngineEvent[]): Transition {
  const round = state.round!;
  const scoreEvents = scoreRound(round);
  const scores = { ...state.scores };
  for (const e of scoreEvents) scores[e.playerId] = (scores[e.playerId] ?? 0) + e.delta;

  const next: SessionState = {
    ...state,
    scores,
    scoreLog: [...state.scoreLog, ...scoreEvents],
    roundIndex: state.roundIndex + 1,
    status: "IDLE",
    round,
  };
  const out = [...events];
  if (scoreEvents.length > 0) {
    out.push({ type: "score.updated", events: scoreEvents, totals: scores });
  }
  if (next.roundIndex >= next.config.maxRounds || next.deckCursor >= next.deck.length) {
    const done = complete(next);
    return { state: done.state, events: [...out, ...done.events] };
  }
  return { state: next, events: out };
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
