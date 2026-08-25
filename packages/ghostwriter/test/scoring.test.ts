import { describe, it, expect } from "vitest";
import { SCORING, scoreRound } from "../src/scoring.js";
import type { RoundState, PromptCard } from "../src/types.js";

const card: PromptCard = {
  id: "s1",
  prompt: "What's the worst possible name for a boat?",
  essence: "bad boat names",
  aliases: [],
  category: "Mixed Chaos",
  telling: ["boat"],
  difficulty: 1,
};

/** slot0 = ghost, slot1..3 = innocents. */
const owners = { slot0: "ghost", slot1: "p2", slot2: "p3", slot3: "p4" };

function round(votes: { voterId: string; slotId: string }[], extra: Partial<RoundState> = {}): RoundState {
  return {
    index: 0,
    ghostId: "ghost",
    card,
    phase: "COMPLETE",
    answers: [
      { playerId: "ghost", text: "purple", normalized: "purple", at: 1 },
      { playerId: "p2", text: "Kevin", normalized: "kevin", at: 2 },
      { playerId: "p3", text: "a stapler", normalized: "a stapler", at: 3 },
      { playerId: "p4", text: "Tuesday", normalized: "tuesday", at: 4 },
    ],
    slots: Object.entries(owners).map(([slotId]) => ({ slotId, text: "x" })),
    slotOwners: owners,
    votes: votes.map((v) => ({ ...v, at: 10 })),
    endedReason: "SCORED",
    ...extra,
  };
}

function totals(r: RoundState): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of scoreRound(r)) out[e.playerId] = (out[e.playerId] ?? 0) + e.delta;
  return out;
}

describe("scoreRound", () => {
  it("pays the surviving Ghost and nobody else", () => {
    const t = totals(round([
      { voterId: "p2", slotId: "slot2" },
      { voterId: "p3", slotId: "slot2" },
      { voterId: "p4", slotId: "slot2" },
      { voterId: "ghost", slotId: "slot3" },
    ]));
    // slot2 (p3) took a clear 3 votes — the Ghost walked, and p3 was framed.
    // NOTE: an earlier version of this fixture split the vote 2-2 and expected a
    // framed player anyway. The engine was right and the test was wrong: a tie
    // frames nobody, exactly as it convicts nobody.
    expect(t["ghost"]).toBe(SCORING.GHOST_SURVIVED);
    expect(t["p3"]).toBe(SCORING.FRAMED);
    expect(t["p2"]).toBeUndefined();
  });

  it("pays every catcher, and nothing to the caught Ghost", () => {
    // Only two votes arrived (a vote clock can expire mid-round), both on the
    // Ghost: a strict plurality with no innocent suspected, so CAUGHT_GHOST is
    // the whole payout and no FRAMED bonus muddies the assertion.
    const t = totals(round([
      { voterId: "p2", slotId: "slot0" },
      { voterId: "p3", slotId: "slot0" },
    ]));
    expect(t["p2"]).toBe(SCORING.CAUGHT_GHOST);
    expect(t["p3"]).toBe(SCORING.CAUGHT_GHOST);
    expect(t["ghost"]).toBeUndefined();
  });

  it("does not let the Ghost's own deflection vote frame anybody", () => {
    /**
     * REGRESSION, found in a live smoke run and not by any unit test here: three
     * players caught the Ghost, and one of them ALSO collected FRAMED because the
     * Ghost's single cover vote had landed on her — making her the most-suspected
     * innocent by default. 100 + 40 = 140 for catching the Ghost.
     *
     * The Ghost's vote convicts (it counts toward the tally) but never frames.
     */
    const t = totals(round([
      { voterId: "p2", slotId: "slot0" },
      { voterId: "p3", slotId: "slot0" },
      { voterId: "p4", slotId: "slot0" },
      { voterId: "ghost", slotId: "slot1" },
    ]));
    expect(t["p2"]).toBe(SCORING.CAUGHT_GHOST);
    expect(t["p3"]).toBe(SCORING.CAUGHT_GHOST);
    expect(t["p4"]).toBe(SCORING.CAUGHT_GHOST);
    expect(Object.values(t).some((v) => v === SCORING.CAUGHT_GHOST + SCORING.FRAMED)).toBe(false);
  });

  it("still frames an innocent the ROOM suspected", () => {
    const t = totals(round([
      { voterId: "p2", slotId: "slot2" },
      { voterId: "p3", slotId: "slot2" },
      { voterId: "p4", slotId: "slot0" },
      { voterId: "ghost", slotId: "slot1" },
    ]));
    // slot2 (p3) drew two room votes; slot1 drew only the Ghost's, which is not
    // the room's opinion and pays nothing.
    expect(t["p3"]).toBe(SCORING.FRAMED);
    expect(t["p2"]).toBeUndefined();
  });

  it("does not pay a voter who pointed at an innocent", () => {
    const t = totals(round([
      { voterId: "p2", slotId: "slot0" },
      { voterId: "p3", slotId: "slot0" },
      { voterId: "p4", slotId: "slot1" },
      { voterId: "ghost", slotId: "slot1" },
    ]));
    expect(t["p4"]).toBeUndefined();
  });

  it("adds the last-word consolation only when the Ghost got it right", () => {
    const votes = [
      { voterId: "p2", slotId: "slot0" },
      { voterId: "p3", slotId: "slot0" },
      { voterId: "p4", slotId: "slot0" },
    ];
    const right = totals(round(votes, { lastWord: { text: "boat names", correct: true } }));
    const wrong = totals(round(votes, { lastWord: { text: "tin prices", correct: false } }));
    expect(right["ghost"]).toBe(SCORING.GHOST_LAST_WORD);
    expect(wrong["ghost"]).toBeUndefined();
  });

  it("scores nothing for NO_CONTEST or a host-ended round", () => {
    const votes = [{ voterId: "p2", slotId: "slot0" }, { voterId: "p3", slotId: "slot0" }];
    expect(scoreRound(round(votes, { endedReason: "NO_CONTEST" }))).toEqual([]);
    expect(scoreRound(round(votes, { endedReason: "HOST_ENDED" }))).toEqual([]);
  });

  it("scores an empty vote as survival — nobody even tried", () => {
    const t = totals(round([]));
    expect(t["ghost"]).toBe(SCORING.GHOST_SURVIVED);
  });

  it("keeps the payout shape intact: the room out-earns the Ghost, one catcher does not", () => {
    // The design claim in scoring.ts, asserted rather than asserted in prose.
    expect(SCORING.GHOST_SURVIVED).toBeGreaterThan(SCORING.CAUGHT_GHOST);
    expect(SCORING.CAUGHT_GHOST * 2).toBeGreaterThan(SCORING.GHOST_SURVIVED);
    expect(SCORING.GHOST_LAST_WORD).toBeLessThan(SCORING.CAUGHT_GHOST);
    expect(SCORING.FRAMED).toBeLessThan(SCORING.CAUGHT_GHOST);
  });
});
