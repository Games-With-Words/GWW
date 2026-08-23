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
} as const;

/**
 * Compute score events for a completed round. Pure; the caller applies them.
 * v0.1 playtest rule: one guess per player per clue, first correct wins the round.
 */
export function scoreRound(round: RoundState, eligibleGuessers: number, config: SessionConfig): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  if (round.endedReason !== "CORRECT" || round.winnerId === undefined) return events;

  const r = round.index;
  const winner = round.winnerId;
  const winning = round.guesses.find((g) => g.playerId === winner && g.correct);

  events.push({ roundIndex: r, playerId: round.speakerId, reason: "SPEAKER_CORRECT", delta: SCORING.CORRECT_SPEAKER });
  events.push({ roundIndex: r, playerId: winner, reason: "GUESSER_CORRECT", delta: SCORING.CORRECT_GUESSER });
  events.push({ roundIndex: r, playerId: winner, reason: "FIRST_CORRECT", delta: SCORING.FIRST_CORRECT_BONUS });

  const used = round.clueNormalized === undefined ? round.budget : round.clueNormalized.split(" ").filter(Boolean).length;
  const unused = Math.max(0, round.budget - used);
  if (unused > 0) {
    events.push({ roundIndex: r, playerId: round.speakerId, reason: "UNUSED_WORDS", delta: unused * SCORING.UNUSED_WORD });
  }

  if (winning !== undefined && round.clueAcceptedAt !== undefined && winning.at - round.clueAcceptedAt <= config.fastAnswerMs) {
    events.push({ roundIndex: r, playerId: round.speakerId, reason: "SPEAKER_FAST", delta: SCORING.FAST_SPEAKER });
    events.push({ roundIndex: r, playerId: winner, reason: "GUESSER_FAST", delta: SCORING.FAST_GUESSER });
  }

  const correctCount = round.guesses.filter((g) => g.correct).length;
  if (eligibleGuessers > 0 && correctCount >= eligibleGuessers) {
    events.push({ roundIndex: r, playerId: round.speakerId, reason: "ALL_SOLVED", delta: SCORING.ALL_SOLVED_SPEAKER });
  }
  return events;
}
