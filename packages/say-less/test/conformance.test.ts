import { describe, it, expect } from "vitest";
import { checkConformance } from "@gww/kit";
import { sayLess } from "../src/module.js";
import type { SessionState } from "../src/types.js";

const players = [
  { id: "p1", displayName: "Mark" },
  { id: "p2", displayName: "Ris" },
  { id: "p3", displayName: "Sonia" },
  { id: "p4", displayName: "Sam" },
];

/** Start, clue, everyone guesses, everyone votes. */
function script(state: unknown, step: number) {
  const s = state as SessionState;
  if (step === 0) return { name: "round.start", payload: {} };

  const round = s.round;
  if (round === undefined) return undefined;

  if (round.phase === "AWAITING_CLUE") {
    return { name: "clue.submit", payload: { speakerId: round.speakerId, clue: "totally safe generic hint" } };
  }

  if (round.phase === "GUESSING") {
    const next = s.players.find(
      (p) => p.id !== round.speakerId && !round.guesses.some((g) => g.playerId === p.id),
    );
    if (next === undefined) return undefined;
    return { name: "guess.submit", payload: { playerId: next.id, value: `guess from ${next.id}` } };
  }

  if (round.phase === "BALLOT") {
    const slots = round.ballot ?? [];
    const owners = round.ballotOwners ?? {};
    for (const category of ["FUNNIEST", "CLOSEST"] as const) {
      for (const p of s.players) {
        // CLOSEST is guessers only; skip the Speaker there.
        if (category === "CLOSEST" && p.id === round.speakerId) continue;
        const already = round.votes.some((v) => v.voterId === p.id && v.category === category);
        if (already) continue;
        const slot = slots.find((sl) => owners[sl.slotId] !== p.id);
        if (slot === undefined) continue;
        return { name: "ballot.vote", payload: { voterId: p.id, category, slotId: slot.slotId } };
      }
    }
    return { name: "ballot.close", payload: {} };
  }
  return undefined;
}

/** The secret, until the round reveals it. */
function secrets(state: unknown): string[] {
  const s = state as SessionState;
  const round = s.round;
  if (round === undefined || round.phase === "COMPLETE") return [];
  return [round.card.secret];
}

describe("kit conformance", () => {
  it("passes the platform's house rules", () => {
    const r = checkConformance(sayLess, { players, seed: 42, next: script, secrets });
    expect(r.failures).toEqual([]);
  });

  it("passes across seeds", () => {
    for (const seed of [3, 21, 42, 777]) {
      const r = checkConformance(sayLess, { players, seed, next: script, secrets });
      expect(r.failures).toEqual([]);
    }
  });

  it("catches the historical leak: authorship on the wire during an anonymous ballot", () => {
    /**
     * This is a REAL bug this codebase shipped and fixed (see redactEvent in
     * module.ts): `guess.submitted` carried playerId AND value while the ballot
     * was busy hiding authorship. Here it is reproduced by removing the redactor,
     * so the harness is proven against a failure that actually happened rather
     * than one I invented.
     */
    const unredacted = { ...sayLess, redactEvent: undefined };
    const r = checkConformance(unredacted, {
      players,
      seed: 42,
      next: script,
      secrets: (state) => {
        const s = state as SessionState;
        const round = s.round;
        if (round === undefined || round.phase !== "BALLOT") return [];
        // During the ballot, a guess's TEXT paired with its author is the leak.
        return round.guesses.map((g) => g.value);
      },
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/event on the wire leaks/);
  });
});
