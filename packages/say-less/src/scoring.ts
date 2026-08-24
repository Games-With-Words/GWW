/**
 * Say Less scoring — PROPOSED values from spec §04, deliberately centralized so
 * playtests can retune them in one place. Instrument before trusting.
 */

import type { RoundState, ScoreEvent, SessionConfig } from "./types.js";

export const SCORING = {
  CORRECT_SPEAKER: 100,
  CORRECT_GUESSER: 100,
  FIRST_CORRECT_BONUS: 50,
  UNUSED_WORD: 15,
  FAST_SPEAKER: 40,
  FAST_GUESSER: 25,
  ALL_SOLVED_SPEAKER: 50,
  /**
   * Community awards. Substantial enough that a wrong guess can out-score a
   * right one, which is the point — it makes the losing guesses worth writing
   * well. Still below correct+first (150), so being right stays the best round.
   */
  FUNNIEST: 75,
  CLOSEST: 75,
} as const;

/**
 * Compute score events for a completed round. Pure; the caller applies them.
 *
 * One guess per player per clue. EVERY correct guesser scores; the first also
 * takes the speed bonus. Community awards are paid independently of
 * correctness, so a round where nobody was right still has winners.
 */
export function scoreRound(round: RoundState, eligibleGuessers: number, config: SessionConfig): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  const r = round.index;

  // --- community awards: paid whether or not anyone was correct -------------
  // A wipeout round still produces winners. This is the whole reason the
  // ballot exists: "nobody got it" used to be the most deflating beat in the
  // game, and now it ends in a laugh and a score.
  for (const w of round.reveal?.funniest ?? []) {
    if (w.playerId !== "") events.push({ roundIndex: r, playerId: w.playerId, reason: "FUNNIEST", delta: SCORING.FUNNIEST });
  }
  for (const w of round.reveal?.closest ?? []) {
    if (w.playerId !== "") events.push({ roundIndex: r, playerId: w.playerId, reason: "CLOSEST", delta: SCORING.CLOSEST });
  }

  if (round.endedReason !== "CORRECT") return events;

  // --- correctness ----------------------------------------------------------
  const correct = round.guesses.filter((g) => g.correct);
  if (correct.length === 0) return events;
  // Every correct guesser scores. Fuzzy matching makes multiple-correct common
  // where exact matching made it rare; only the FIRST takes the speed bonus.
  const first = [...correct].sort((a, b) => a.at - b.at)[0]!;

  events.push({ roundIndex: r, playerId: round.speakerId, reason: "SPEAKER_CORRECT", delta: SCORING.CORRECT_SPEAKER });
  for (const g of correct) {
    events.push({ roundIndex: r, playerId: g.playerId, reason: "GUESSER_CORRECT", delta: SCORING.CORRECT_GUESSER });
  }
  events.push({ roundIndex: r, playerId: first.playerId, reason: "FIRST_CORRECT", delta: SCORING.FIRST_CORRECT_BONUS });

  const used = round.clueNormalized === undefined ? round.budget : round.clueNormalized.split(" ").filter(Boolean).length;
  const unused = Math.max(0, round.budget - used);
  if (unused > 0) {
    events.push({ roundIndex: r, playerId: round.speakerId, reason: "UNUSED_WORDS", delta: unused * SCORING.UNUSED_WORD });
  }

  if (round.clueAcceptedAt !== undefined && first.at - round.clueAcceptedAt <= config.fastAnswerMs) {
    events.push({ roundIndex: r, playerId: round.speakerId, reason: "SPEAKER_FAST", delta: SCORING.FAST_SPEAKER });
    events.push({ roundIndex: r, playerId: first.playerId, reason: "GUESSER_FAST", delta: SCORING.FAST_GUESSER });
  }

  if (eligibleGuessers > 0 && correct.length >= eligibleGuessers) {
    events.push({ roundIndex: r, playerId: round.speakerId, reason: "ALL_SOLVED", delta: SCORING.ALL_SOLVED_SPEAKER });
  }
  return events;
}
