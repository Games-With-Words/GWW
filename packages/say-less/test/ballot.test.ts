/**
 * The community ballot: anonymous double-vote, then the reveal.
 *
 * The rules that matter most here are the ones a player CANNOT police from
 * their own screen — self-voting on an anonymized ballot, and who is even
 * allowed to vote in each category. Those get the hardest tests.
 */
import { describe, expect, it } from "vitest";
import {
  createSession, startRound, submitClue, submitGuess,
  submitVote, closeGuessing, closeBallot, shuffleSeeded, electorate, tally,
  EngineError,
} from "../src/machine.js";
import { SCORING } from "../src/scoring.js";
import type { Card, SessionState } from "../src/types.js";

const CARD: Card = {
  id: "c1", secret: "Air guitar", aliases: [], category: "Music",
  forbidden: ["instrument", "pretend", "rock"], budget: 5, difficulty: 2,
};

/** A room of n players, clue submitted, sitting in GUESSING. */
function roomAt(n: number): SessionState {
  const players = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, displayName: `P${i}` }));
  const deck = Array.from({ length: 5 }, (_, i) => ({ ...CARD, id: `c${i}` }));
  let s = createSession(players, deck, { seed: 42 }).state;
  s = startRound(s).state;
  s = submitClue(s, s.round!.speakerId, "strings but not really", 1_000).state;
  return s;
}

const guessers = (s: SessionState): string[] =>
  s.players.map((p) => p.id).filter((id) => id !== s.round!.speakerId);

/** Everyone guesses; `correct` names the ids that get it right. */
function allGuess(s: SessionState, correct: string[] = []): SessionState {
  let t = s;
  guessers(s).forEach((id, i) => {
    const value = correct.includes(id) ? "air guitar" : `wrong ${i}`;
    t = submitGuess(t, id, value, 2_000 + i * 100).state;
  });
  return t;
}

describe("ballot — opening", () => {
  it("opens after the LAST guess, not the first correct one", () => {
    let s = roomAt(5);
    const g = guessers(s);
    // First correct guess must NOT end the round any more.
    s = submitGuess(s, g[0]!, "air guitar", 2_000).state;
    expect(s.round!.phase).toBe("GUESSING");
    s = submitGuess(s, g[1]!, "banjo", 2_100).state;
    s = submitGuess(s, g[2]!, "lute", 2_200).state;
    s = submitGuess(s, g[3]!, "harp", 2_300).state;
    expect(s.round!.phase).toBe("BALLOT");
  });

  it("carries NO player ids on the ballot — anonymity by construction", () => {
    const s = allGuess(roomAt(5));
    const slots = s.round!.ballot!;
    expect(slots).toHaveLength(4);
    for (const slot of slots) {
      expect(Object.keys(slot)).toEqual(["slotId", "text"]);
      expect(JSON.stringify(slot)).not.toContain("p0");
    }
    // The owner map exists, but separately — leaking it has to be deliberate.
    expect(Object.keys(s.round!.ballotOwners!)).toHaveLength(4);
  });

  it("shuffles so submission order cannot identify the fast typist", () => {
    const s = allGuess(roomAt(7));
    const order = s.round!.ballot!.map((b) => b.text);
    const submitted = s.round!.guesses.map((g) => g.value);
    expect(order).not.toEqual(submitted);
    expect([...order].sort()).toEqual([...submitted].sort());
  });

  it("shuffles DETERMINISTICALLY, so a session replays identically", () => {
    const a = allGuess(roomAt(6)).round!.ballot!.map((b) => b.text);
    const b = allGuess(roomAt(6)).round!.ballot!.map((b) => b.text);
    expect(a).toEqual(b);
    expect(shuffleSeeded([1, 2, 3, 4, 5], 99)).toEqual(shuffleSeeded([1, 2, 3, 4, 5], 99));
    expect(shuffleSeeded([1, 2, 3, 4, 5], 99)).not.toEqual(shuffleSeeded([1, 2, 3, 4, 5], 100));
  });

  it("skips the ballot in a small room — 2 guesses is too thin to vote on", () => {
    const s = allGuess(roomAt(3));
    expect(s.round!.phase).toBe("COMPLETE");
    expect(s.round!.ballot).toBeUndefined();
  });

  it("opens at exactly 4 players, the documented floor", () => {
    expect(allGuess(roomAt(4)).round!.phase).toBe("BALLOT");
  });

  it("opens when the clock runs out mid-guessing", () => {
    let s = roomAt(5);
    s = submitGuess(s, guessers(s)[0]!, "banjo", 2_000).state;
    s = submitGuess(s, guessers(s)[1]!, "lute", 2_100).state;
    s = closeGuessing(s).state;
    expect(s.round!.phase).toBe("BALLOT");
    expect(s.round!.ballot).toHaveLength(2);
  });
});

describe("ballot — who may vote", () => {
  it("lets everyone vote FUNNIEST, including the Speaker", () => {
    const s = allGuess(roomAt(5));
    expect(electorate(s, "FUNNIEST")).toHaveLength(5);
    expect(electorate(s, "FUNNIEST")).toContain(s.round!.speakerId);
  });

  it("excludes the Speaker from CLOSEST — they know the secret", () => {
    const s = allGuess(roomAt(5));
    expect(electorate(s, "CLOSEST")).toHaveLength(4);
    expect(electorate(s, "CLOSEST")).not.toContain(s.round!.speakerId);
  });

  it("REJECTS a Speaker closest-vote loudly rather than dropping it", () => {
    const s = allGuess(roomAt(5));
    expect(() => submitVote(s, s.round!.speakerId, "CLOSEST", "slot0"))
      .toThrow(/may not vote on CLOSEST/);
  });

  it("accepts a Speaker funniest-vote", () => {
    const s = allGuess(roomAt(5));
    expect(submitVote(s, s.round!.speakerId, "FUNNIEST", "slot0").state.round!.votes).toHaveLength(1);
  });
});

describe("ballot — the rules players cannot self-police", () => {
  it("BLOCKS self-voting, which is invisible on an anonymized ballot", () => {
    const s = allGuess(roomAt(5));
    const owner = s.round!.ballotOwners!["slot0"]!;
    expect(() => submitVote(s, owner, "FUNNIEST", "slot0")).toThrow(/your own guess/);
    expect(() => submitVote(s, owner, "CLOSEST", "slot0")).toThrow(/your own guess/);
  });

  it("blocks a second vote in the same category but allows one in the other", () => {
    const s = allGuess(roomAt(5));
    const voter = guessers(s).find((id) => s.round!.ballotOwners!["slot0"] !== id)!;
    const once = submitVote(s, voter, "FUNNIEST", "slot0").state;
    expect(() => submitVote(once, voter, "FUNNIEST", "slot1")).toThrow(/Already voted/);
    expect(submitVote(once, voter, "CLOSEST", "slot0").state.round!.votes).toHaveLength(2);
  });

  it("rejects a vote for a slot that does not exist", () => {
    const s = allGuess(roomAt(5));
    expect(() => submitVote(s, guessers(s)[0]!, "FUNNIEST", "slot99")).toThrow(/No ballot slot/);
  });

  it("rejects voting outside the ballot phase", () => {
    const s = roomAt(5);
    expect(() => submitVote(s, guessers(s)[0]!, "FUNNIEST", "slot0")).toThrow(EngineError);
  });
});

describe("ballot — closing and the reveal", () => {
  it("closes only when BOTH electorates are done — the Speaker casts one vote", () => {
    let s = allGuess(roomAt(5));
    const owners = s.round!.ballotOwners!;
    // Every FUNNIEST vote is in, including the Speaker's. Still open, because
    // CLOSEST has its own (smaller) electorate outstanding.
    for (const id of electorate(s, "FUNNIEST")) {
      s = submitVote(s, id, "FUNNIEST", owners["slot0"] === id ? "slot1" : "slot0").state;
    }
    expect(s.round!.phase).toBe("BALLOT");
    expect(s.round!.votes).toHaveLength(5);

    const closestVoters = electorate(s, "CLOSEST");
    for (const id of closestVoters) {
      s = submitVote(s, id, "CLOSEST", owners["slot0"] === id ? "slot1" : "slot0").state;
    }
    expect(s.round!.phase).toBe("COMPLETE");
  });

  it("closes on the clock with partial votes, counting what arrived", () => {
    let s = allGuess(roomAt(5));
    const voter = guessers(s).find((id) => s.round!.ballotOwners!["slot0"] !== id)!;
    s = submitVote(s, voter, "FUNNIEST", "slot0").state;
    s = closeBallot(s).state;
    expect(s.round!.phase).toBe("COMPLETE");
    expect(s.round!.reveal!.funniest).toEqual([
      { slotId: "slot0", playerId: s.round!.ballotOwners!["slot0"], votes: 1 },
    ]);
  });

  it("reveals the secret, the owners, and who was correct", () => {
    let s = allGuess(roomAt(5), []);
    const g = guessers(s);
    s = closeBallot(s).state;
    const rev = s.round!.reveal!;
    expect(rev.secret).toBe("Air guitar");
    expect(Object.keys(rev.owners)).toHaveLength(4);
    expect(rev.correctPlayerIds).toEqual([]);
    expect(g.length).toBe(4);
  });

  it("SHARES a tie rather than running off", () => {
    let s = allGuess(roomAt(5));
    const owners = s.round!.ballotOwners!;
    const a = guessers(s).find((id) => owners["slot0"] !== id)!;
    const b = guessers(s).find((id) => owners["slot1"] !== id && id !== a)!;
    s = submitVote(s, a, "FUNNIEST", "slot0").state;
    s = submitVote(s, b, "FUNNIEST", "slot1").state;
    s = closeBallot(s).state;
    expect(s.round!.reveal!.funniest).toHaveLength(2);
    expect(s.round!.reveal!.funniest.every((w) => w.votes === 1)).toBe(true);
  });

  it("tallies nothing when nobody voted", () => {
    const s = closeBallot(allGuess(roomAt(5))).state;
    expect(s.round!.reveal!.funniest).toEqual([]);
    expect(s.round!.reveal!.closest).toEqual([]);
  });
});

describe("scoring under the new round", () => {
  it("pays EVERY correct guesser, and the speed bonus only to the first", () => {
    let s = roomAt(5);
    const g = guessers(s);
    s = submitGuess(s, g[0]!, "air guitar", 2_000).state;
    s = submitGuess(s, g[1]!, "air guitar", 2_500).state;
    s = submitGuess(s, g[2]!, "banjo", 2_600).state;
    s = submitGuess(s, g[3]!, "lute", 2_700).state;
    s = closeBallot(s).state;

    const log = s.scoreLog.filter((e) => e.roundIndex === 0);
    const correctPaid = log.filter((e) => e.reason === "GUESSER_CORRECT").map((e) => e.playerId);
    expect(correctPaid.sort()).toEqual([g[0]!, g[1]!].sort());
    expect(log.filter((e) => e.reason === "FIRST_CORRECT")).toEqual([
      { roundIndex: 0, playerId: g[0]!, reason: "FIRST_CORRECT", delta: SCORING.FIRST_CORRECT_BONUS },
    ]);
  });

  it("pays the community awards even when NOBODY was correct", () => {
    let s = allGuess(roomAt(5), []);
    const owners = s.round!.ballotOwners!;
    const voter = guessers(s).find((id) => owners["slot0"] !== id)!;
    s = submitVote(s, voter, "FUNNIEST", "slot0").state;
    s = submitVote(s, voter, "CLOSEST", "slot0").state;
    s = closeBallot(s).state;

    expect(s.round!.endedReason).toBe("TIMEOUT");
    const log = s.scoreLog.filter((e) => e.roundIndex === 0);
    const winner = owners["slot0"]!;
    expect(log.find((e) => e.reason === "FUNNIEST")).toEqual(
      { roundIndex: 0, playerId: winner, reason: "FUNNIEST", delta: SCORING.FUNNIEST });
    expect(log.find((e) => e.reason === "CLOSEST")).toEqual(
      { roundIndex: 0, playerId: winner, reason: "CLOSEST", delta: SCORING.CLOSEST });
    expect(s.scores[winner]).toBe(SCORING.FUNNIEST + SCORING.CLOSEST);
  });

  it("lets a WRONG guess out-score a right one — the reason the ballot exists", () => {
    let s = roomAt(5);
    const g = guessers(s);
    s = submitGuess(s, g[0]!, "air guitar", 2_000).state; // correct, boring
    s = submitGuess(s, g[1]!, "a haunted banjo", 2_100).state; // wrong, funny
    s = submitGuess(s, g[2]!, "lute", 2_200).state;
    s = submitGuess(s, g[3]!, "harp", 2_300).state;

    const owners = s.round!.ballotOwners!;
    const funnySlot = Object.keys(owners).find((k) => owners[k] === g[1]!)!;
    for (const id of electorate(s, "FUNNIEST")) {
      if (owners[funnySlot] === id) continue;
      s = submitVote(s, id, "FUNNIEST", funnySlot).state;
    }
    s = closeBallot(s).state;
    expect(s.scores[g[1]!]).toBe(SCORING.FUNNIEST);
    expect(s.scores[g[1]!]).toBeGreaterThan(0);
  });
});
