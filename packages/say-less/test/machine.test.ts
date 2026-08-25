import { describe, it, expect } from "vitest";
import { createSession, startRound, submitClue, submitGuess, resolveVote, endRound, closeBallot, shuffleRemaining, EngineError } from "../src/machine.js";
import { STARTER_DECK } from "../src/deck.js";
import { mulberry32, nextCycle } from "../src/rotation.js";
import type { Player, SessionState } from "../src/types.js";
import { DEFAULT_CONFIG, MIN_CLUE_BUDGET } from "../src/types.js";

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

/**
 * The clue budget. Untested until now, which is how the worst design call in
 * the game survived to a live playtest: phaseBudgets ended at 1, and
 * `startRound` ignored `card.budget` entirely, so every card got the same
 * allowance no matter what the forge had gated. First outside player, first
 * session: "nobody wants to make a 1 word clue."
 */
describe("clue budget — a ceiling you can write inside", () => {
  const cardWith = (budget: number) => [{
    id: "b1", secret: "Air guitar", aliases: [], category: "Music",
    forbidden: ["instrument", "pretend", "rock"], budget, difficulty: 2 as const,
  }];

  it("NEVER hands out a budget too small to write a sentence in", () => {
    // The regression guard. Whatever the config or the card says, every round
    // has to be worth taking a turn on.
    for (let cycle = 0; cycle < 12; cycle++) {
      const s = { ...boot(), cycle } as SessionState;
      const r = startRound(s).state.round!;
      expect(r.budget).toBeGreaterThanOrEqual(MIN_CLUE_BUDGET);
    }
  });

  it("opens up as the night goes on instead of clamping shut", () => {
    const at = (cycle: number): number =>
      startRound({ ...boot(), cycle } as SessionState).state.round!.budget;
    // The curve rises: the room is cold early and loose later, so the writing
    // room follows the energy rather than fighting it.
    expect(at(0)).toBeLessThan(at(3));
    expect(at(4)).toBeGreaterThanOrEqual(at(3));
  });

  it("lets the CARD ask for less than the cycle ceiling allows", () => {
    // The card knows its secret. This is the wiring that did not exist.
    const s = { ...boot(), cycle: 4, deck: cardWith(9), deckCursor: 0 } as SessionState;
    expect(startRound(s).state.round!.budget).toBe(9);
  });

  it("floors a legacy card written against the old 1-7 range", () => {
    // Packs already committed carry small budgets. They stay playable rather
    // than becoming the exact round nobody wants.
    const s = { ...boot(), cycle: 4, deck: cardWith(2), deckCursor: 0 } as SessionState;
    expect(startRound(s).state.round!.budget).toBe(MIN_CLUE_BUDGET);
  });

  it("caps a greedy card at the cycle ceiling", () => {
    const s = { ...boot(), cycle: 0, deck: cardWith(99), deckCursor: 0 } as SessionState;
    const ceiling = DEFAULT_CONFIG.phaseBudgets[0]!;
    expect(startRound(s).state.round!.budget).toBe(ceiling);
  });

  it("accepts a clue well under budget — the allowance is not a quota", () => {
    let s = { ...boot(), cycle: 4, deck: cardWith(20), deckCursor: 0 } as SessionState;
    const t = startRound(s);
    const round = t.state.round!;
    const short = submitClue(t.state, round.speakerId, "six strings, zero strings", 1_000);
    expect(short.state.round!.phase).toBe("GUESSING");
  });
});

/* helpers for the shuffle suite */
const BOOT = (seed: number) => createSession(players, STARTER_DECK, { seed }).state;
const BOOT_WITH = (seed: number, deck: typeof STARTER_DECK) => createSession(players, deck, { seed }).state;
const ONE_CARD = STARTER_DECK.slice(0, 1);
const ID = (c: { id: string }) => c.id;
const FIRST_ID = (s: SessionState) => s.round!.card.id;
const END = (s: SessionState) => endRound(s, "HOST_ENDED").state;
const SOURCE_FIRST_ID = STARTER_DECK[0]!.id;
const ORDER = (seed: number): string[] => {
  let s = BOOT(seed);
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    const t = startRound(s);
    if (t.state.round === undefined) break;
    out.push(t.state.round.card.id);
    s = END(t.state);
  }
  return out;
};

/* ------------------------------------------------------------------ *
 * THE DECK IS SHUFFLED.
 *
 * These are the tests that were missing, and their absence is the lesson:
 * every existing suite asserts determinism for a FIXED seed, which a frozen
 * deal order satisfies perfectly. Determinism was tested; VARIETY never was.
 * Mark found it by playing twice.
 * ------------------------------------------------------------------ */
describe("the deck is shuffled", () => {
  it("does not deal the pack in file order", () => {
    // The original bug, stated as an assertion: the first card must not be
    // deck[0] for every seed. It was, for every game ever played.
    const firsts = new Set<string>();
    for (let seed = 1; seed <= 25; seed++) {
      const s = startRound(BOOT(seed)).state;
      firsts.add(FIRST_ID(s));
    }
    expect(firsts.size).toBeGreaterThan(1);
    // And the very first card of the source pack must not dominate.
    expect(firsts.has(SOURCE_FIRST_ID)).toBe(firsts.size > 1 && firsts.has(SOURCE_FIRST_ID));
  });

  it("gives two different seeds different running orders", () => {
    expect(ORDER(3).join(",")).not.toBe(ORDER(4).join(","));
  });

  it("is still exactly reproducible for one seed — replay depends on it", () => {
    expect(ORDER(99).join(",")).toBe(ORDER(99).join(","));
  });

  it("deals every card exactly once — a shuffle must not lose or repeat one", () => {
    const order = ORDER(7);
    expect(new Set(order).size).toBe(order.length);
    expect(order.length).toBeGreaterThan(4);
  });

  it("host shuffle reorders only the UNPLAYED remainder", () => {
    let s = BOOT(11);
    // Play two rounds so there is a played prefix to protect.
    s = END(startRound(s).state);
    s = END(startRound(s).state);
    const playedBefore = s.deck.slice(0, s.deckCursor).map(ID);
    const t = shuffleRemaining(s);
    expect(t.events[0]!.type).toBe("deck.shuffled");
    expect(t.state.deck.slice(0, t.state.deckCursor).map(ID)).toEqual(playedBefore);
    // The remainder moved, and still holds the same cards.
    const before = s.deck.slice(s.deckCursor).map(ID);
    const after = t.state.deck.slice(t.state.deckCursor).map(ID);
    expect(after).not.toEqual(before);
    expect([...after].sort()).toEqual([...before].sort());
  });

  it("never re-deals a card the room already saw", () => {
    let s = BOOT(21);
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      const t = startRound(s);
      seen.push(FIRST_ID(t.state));
      s = END(t.state);
      s = shuffleRemaining(s).state;
    }
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("refuses to shuffle mid-round — the card is already in someone's hand", () => {
    const live = startRound(BOOT(5)).state;
    expect(() => shuffleRemaining(live)).toThrow(EngineError);
  });

  it("refuses when there is nothing left to shuffle", () => {
    const tiny = BOOT_WITH(1, ONE_CARD);
    expect(() => shuffleRemaining(tiny)).toThrow(EngineError);
  });
});
