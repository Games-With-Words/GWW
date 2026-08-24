/**
 * Scoring — specifically, WHAT THE SCORING ASKS PEOPLE TO DO.
 *
 * There were no tests here, and that is how the game shipped paying players not
 * to write. UNUSED_WORD sat at 15 points: on the old 7-word budget a one-word
 * clue that landed paid the Speaker 90 bonus on top of 100 for being right, so
 * the highest-value play in Say Less was to say almost nothing. The first
 * outside playtest felt it immediately — "nobody wants to make a 1 word clue" —
 * and it read as a content complaint when it was an incentive one.
 *
 * These tests pin the incentive, not the arithmetic. If someone retunes the
 * numbers so that terseness beats writing something the room will repeat, they
 * break a test that says so out loud.
 */

import { describe, it, expect } from "vitest";
import { scoreRound, SCORING } from "../src/scoring.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { Card, RoundState, SessionConfig } from "../src/types.js";

const card: Card = {
  id: "s1", secret: "Air guitar", aliases: [], category: "Music",
  forbidden: ["instrument", "pretend", "rock"], budget: 20, difficulty: 2,
};

const config: SessionConfig = { ...DEFAULT_CONFIG, seed: 1 };

/** A round somebody won, with a clue of `used` words against `budget`. */
function round(over: { budget: number; used: number }): RoundState {
  return {
    index: 0,
    speakerId: "sp",
    card,
    budget: over.budget,
    phase: "COMPLETE",
    endedReason: "CORRECT",
    clueNormalized: new Array(over.used).fill("word").join(" "),
    clueAcceptedAt: 0,
    guesses: [{ playerId: "g1", value: "air guitar", at: 60_000, correct: true }],
    votes: [],
  } as RoundState;
}

const totalFor = (r: RoundState, id: string): number =>
  scoreRound(r, 3, config).filter((e) => e.playerId === id).reduce((a, e) => a + e.delta, 0);

const concision = (r: RoundState): number =>
  scoreRound(r, 3, config).filter((e) => e.reason === "UNUSED_WORDS").reduce((a, e) => a + e.delta, 0);

describe("concision is a nod, not a strategy", () => {
  it("pays something for coming in under the ceiling", () => {
    expect(concision(round({ budget: 20, used: 18 }))).toBeGreaterThan(0);
  });

  it("CANNOT pay more than a community award, however short the clue", () => {
    // The regression that raising budgets to 20 would otherwise have caused:
    // more headroom meant more unused words meant a bigger payout for saying
    // less. Capped, the best available play is to write something good.
    const oneWord = concision(round({ budget: 20, used: 1 }));
    expect(oneWord).toBe(SCORING.MAX_CONCISION);
    expect(oneWord).toBeLessThan(SCORING.FUNNIEST);
  });

  it("does not reward a bigger budget for the same clue", () => {
    // Otherwise the late-game generous ceilings quietly become a points farm
    // for anyone who keeps writing two-word clues.
    expect(concision(round({ budget: 20, used: 2 }))).toBe(concision(round({ budget: 10, used: 2 })));
  });

  it("pays nothing extra for spending the whole allowance", () => {
    expect(concision(round({ budget: 20, used: 20 }))).toBe(0);
  });

  it("leaves a full-length clue within a community award of a one-word one", () => {
    // The point of the whole change: a Speaker who writes the memorable
    // 18-word clue must be able to out-score the one who wrote "guitar" the
    // moment the room votes for it. It cannot be a losing move to play.
    const wordy = totalFor(round({ budget: 20, used: 18 }), "sp");
    const terse = totalFor(round({ budget: 20, used: 1 }), "sp");
    expect(terse - wordy).toBeLessThan(SCORING.FUNNIEST);
  });
});
