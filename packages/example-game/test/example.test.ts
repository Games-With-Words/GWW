/**
 * The smallest test suite that clears the bar in CONTRIBUTING house rule 5.
 *
 * Copy this alongside src/index.ts. The conformance run at the bottom is the
 * important one: it enforces determinism, no leakage into public projections,
 * and that every timer names a command that exists — the three things that fail
 * SILENTLY and cost a real evening.
 */

import { describe, expect, it } from "vitest";
import { assertConformance, createArcade } from "@gww/kit";
import { oddOneOut, createSession, startRound, submitVote, endRound, GameError, type State } from "../src/index.js";

const players = [
  { id: "p1", displayName: "Mark" },
  { id: "p2", displayName: "Ris" },
  { id: "p3", displayName: "Sonia" },
];

function open(seed = 7): State {
  return startRound(createSession(players, seed).state).state;
}

describe("rules", () => {
  it("needs three players", () => {
    expect(() => createSession(players.slice(0, 2), 1)).toThrow(GameError);
  });

  it("gives exactly one player the odd word", () => {
    const s = open();
    const views = oddOneOut.privateViews!(s) as Record<string, { word: string }>;
    const words = Object.values(views).map((v) => v.word);
    const odd = words.filter((w) => w === s.round!.odd);
    expect(odd).toHaveLength(1);
    expect(words).toHaveLength(3);
  });

  it("refuses a second vote, a self-vote and a stranger", () => {
    const s = open();
    const once = submitVote(s, "p1", "p2").state;
    expect(() => submitVote(once, "p1", "p3")).toThrow(GameError);
    expect(() => submitVote(s, "p1", "p1")).toThrow(GameError);
    expect(() => submitVote(s, "nobody", "p1")).toThrow(GameError);
  });

  it("pays voters who found the odd one, and the odd one for each player fooled", () => {
    const s = open();
    const odd = s.round!.oddPlayerId;
    const others = players.filter((p) => p.id !== odd);
    // Both innocents point at the odd player: 100 each, nobody fooled.
    let next = submitVote(s, others[0]!.id, odd).state;
    next = submitVote(next, others[1]!.id, odd).state;
    // The odd player votes for an innocent to fill the round out.
    next = submitVote(next, odd, others[0]!.id).state;
    expect(next.scores[others[0]!.id]).toBe(100);
    expect(next.scores[others[1]!.id]).toBe(100);
    // Their own wrong vote counts as nobody fooled — the odd player scores 0.
    expect(next.scores[odd]).toBe(0);
  });

  it("is deterministic for a seed", () => {
    expect(JSON.stringify(open(42))).toBe(JSON.stringify(open(42)));
  });

  it("ends a round on the host's command as well as on a full vote", () => {
    const s = open();
    const done = endRound(s).state;
    expect(done.round!.phase).toBe("COMPLETE");
    expect(done.status).toBe("IDLE");
  });
});

describe("the platform contract", () => {
  it("registers on the arcade shelf", () => {
    const arcade = createArcade();
    arcade.register(oddOneOut as never);
    expect(arcade.get("odd-one-out")).toBeDefined();
  });

  it("keeps the words out of every public projection until the reveal", () => {
    const s = open();
    for (const ctx of [{ isBoard: true }, {}, { viewerId: "p1" }]) {
      const text = JSON.stringify(oddOneOut.project(s, ctx));
      expect(text).not.toContain(s.round!.common);
      expect(text).not.toContain(s.round!.odd);
    }
  });

  it("passes the kit conformance suite", () => {
    assertConformance(oddOneOut, {
      players,
      seed: 7,
      next: (state, step) => {
        const s = state as State;
        if (step === 0) return { name: "round.start", payload: {} };
        const round = s.round;
        if (round === undefined || round.phase === "COMPLETE") return undefined;
        const voter = s.players.find((p) => !round.votes.some((v) => v.voterId === p.id));
        if (voter === undefined) return undefined;
        const suspect = s.players.find((p) => p.id !== voter.id)!;
        return { name: "vote.cast", payload: { voterId: voter.id, suspectId: suspect.id } };
      },
      secrets: (state) => {
        const s = state as State;
        const round = s.round;
        if (round === undefined || round.phase === "COMPLETE") return [];
        return [round.common, round.odd];
      },
    });
  });
});
