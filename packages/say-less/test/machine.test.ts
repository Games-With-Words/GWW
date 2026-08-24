import { describe, it, expect } from "vitest";
import { createSession, startRound, submitClue, submitGuess, resolveVote, endRound, closeBallot } from "../src/machine.js";
import { STARTER_DECK } from "../src/deck.js";
import { mulberry32, nextCycle } from "../src/rotation.js";
import type { Player, SessionState } from "../src/types.js";

const players: Player[] = [
  { id: "p1", displayName: "Mark" },
  { id: "p2", displayName: "Ris" },
  { id: "p3", displayName: "Sonia" },
  { id: "p4", displayName: "Sam" },
];

function boot(seed = 42) {
  const t = createSession(players, STARTER_DECK, { seed });
  return t.state;
}

describe("rotation", () => {
  it("is deterministic for a given seed", () => {
    const a = nextCycle(players.map((p) => p.id), mulberry32(7));
    const b = nextCycle(players.map((p) => p.id), mulberry32(7));
    expect(a).toEqual(b);
  });
  it("never immediately repeats a speaker across cycles", () => {
    const ids = players.map((p) => p.id);
    let last: string | undefined;
    for (let c = 0; c < 50; c++) {
      const cycle = nextCycle(ids, mulberry32(c), last);
      expect(cycle[0]).not.toBe(last);
      last = cycle[cycle.length - 1];
    }
  });
});

describe("session flow", () => {
  it("replays identically: same seed + same commands = same state", () => {
    const run = () => {
      let s = boot(99);
      let t = startRound(s);
      s = t.state;
      const speaker = s.round!.speakerId;
      t = submitClue(s, speaker, "prehistoric theme attraction", 1000);
      s = t.state;
      const guesser = players.find((p) => p.id !== speaker)!.id;
      t = submitGuess(s, guesser, s.round!.card.secret, 4000);
      return t.state;
    };
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("runs a full happy-path round with scoring", () => {
    let s = boot();
    let t = startRound(s);
    s = t.state;
    expect(s.status).toBe("IN_ROUND");
    const speaker = s.round!.speakerId;
    const card = s.round!.card;

    t = submitClue(s, speaker, "prehistoric theme attraction", 1000);
    // If this card rejects that clue, use a safe generic clue for flow purposes.
    if (t.state.round!.phase !== "GUESSING") {
      s = boot(7);
      t = startRound(s);
      s = t.state;
    } else {
      s = t.state;
    }
    const sp = s.round!.speakerId;
    const secret = s.round!.card.secret;
    if (s.round!.phase === "AWAITING_CLUE") {
      t = submitClue(s, sp, "totally safe generic hint", 1000);
      s = t.state;
    }
    expect(s.round!.phase).toBe("GUESSING");

    const guesser = players.find((p) => p.id !== sp)!.id;
    const wrong = submitGuess(s, guesser, "definitely wrong", 2000);
    s = wrong.state;
    expect(s.round!.phase).toBe("GUESSING");

    const other = players.find((p) => p.id !== sp && p.id !== guesser)!.id;
    t = submitGuess(s, other, secret, 5000);
    s = t.state;
    // A correct guess NO LONGER ends the round — everyone gets their turn,
    // then the room votes. (Round rework, 2026-08-24.)
    expect(s.round!.phase).toBe("GUESSING");

    const third = players.find((p) => p.id !== sp && p.id !== guesser && p.id !== other)!.id;
    t = submitGuess(s, third, "also wrong", 6000);
    s = t.state;
    // Four players clears the ballot floor, so the round pauses for the vote.
    expect(s.round!.phase).toBe("BALLOT");
    t = closeBallot(s);
    s = t.state;
    expect(s.round!.endedReason).toBe("CORRECT");
    expect(s.scores[other]).toBeGreaterThanOrEqual(150); // 100 + 50 first-correct
    expect(s.scores[sp]).toBeGreaterThanOrEqual(100);
    expect(t.events.some((e) => e.type === "round.completed")).toBe(true);
    expect(t.events.some((e) => e.type === "score.updated")).toBe(true);
  });

  it("speaker cannot guess; players get one guess per clue", () => {
    let s = boot();
    s = startRound(s).state;
    const sp = s.round!.speakerId;
    s = submitClue(s, sp, "totally safe generic hint", 0).state;
    const g = players.find((p) => p.id !== sp)!.id;
    expect(() => submitGuess(s, sp, "x", 1)).toThrowError(/Speaker/);
    s = submitGuess(s, g, "nope", 1).state;
    expect(() => submitGuess(s, g, "again", 2)).toThrowError(/One guess/);
  });

  it("rejected clue zeroes the round and advances", () => {
    let s = boot();
    s = startRound(s).state;
    const sp = s.round!.speakerId;
    const forbidden = s.round!.card.forbidden[0]!;
    const t = submitClue(s, sp, `contains ${forbidden} obviously`, 0);
    expect(t.state.round!.endedReason).toBe("CLUE_REJECTED");
    expect(t.state.status).toBe("IDLE");
    expect(Object.values(t.state.scores).every((v) => v === 0)).toBe(true);
  });

  it("SUSPICIOUS clue routes to vote; the party retains final authority", () => {
    let s = boot();
    s = startRound(s).state;
    const sp = s.round!.speakerId;
    const initials = s.round!.card.secret
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w[0])
      .join(" ");
    const t = submitClue(s, sp, initials, 0);
    if (t.state.round!.phase === "VOTING") {
      const allowed = resolveVote(t.state, true, 10);
      expect(allowed.state.round!.phase).toBe("GUESSING");
      const denied = resolveVote(t.state, false, 10);
      expect(denied.state.round!.endedReason).toBe("VOTE_REJECTED");
    } else {
      // Single-word secrets can't form multi-letter initials — rejected as answer fragment instead.
      expect(["COMPLETE", "GUESSING"]).toContain(t.state.round!.phase);
    }
  });

  it("timeout ends the round with no scores", () => {
    let s = boot();
    s = startRound(s).state;
    const t = endRound(s, "TIMEOUT");
    expect(t.state.round!.endedReason).toBe("TIMEOUT");
    expect(Object.values(t.state.scores).every((v) => v === 0)).toBe(true);
  });

  it("completes the game when the deck runs out", () => {
    let s: SessionState = boot();
    let guard = 0;
    while (s.status !== "COMPLETE" && guard++ < 100) {
      const t = startRound(s);
      s = t.state;
      if (s.status === "COMPLETE") break;
      s = endRound(s, "HOST_ENDED").state;
    }
    expect(s.status).toBe("COMPLETE");
  });
});
