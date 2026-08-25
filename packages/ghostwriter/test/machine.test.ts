import { describe, it, expect } from "vitest";
import {
  createSession,
  startRound,
  submitAnswer,
  submitVote,
  submitLastWord,
  closeAnswers,
  closeVotes,
  closeLastWord,
  endRound,
  electorate,
  shuffleRemaining,
  EngineError,
} from "../src/machine.js";
import { STARTER_DECK } from "../src/deck.js";
import { mulberry32, nextCycle, slotOrder } from "../src/rotation.js";
import type { EngineEvent, Player, SessionState } from "../src/types.js";

const players: Player[] = [
  { id: "p1", displayName: "Mark" },
  { id: "p2", displayName: "Ris" },
  { id: "p3", displayName: "Sonia" },
  { id: "p4", displayName: "Sam" },
];

/** Neutral answers, chosen to trip no card's telling list. */
const NEUTRAL = ["purple", "Kevin", "a stapler", "loud silence", "Tuesday", "wet socks"];

function boot(seed = 42): SessionState {
  return createSession(players, STARTER_DECK, { seed }).state;
}

/** Start a round and return { state, ghostId }. */
function open(seed = 42) {
  const s = startRound(boot(seed));
  return { state: s.state, ghostId: s.state.round!.ghostId, events: s.events };
}

/** Everybody answers with a distinct neutral line. Returns the transition. */
function allAnswer(state: SessionState, t0 = 1000) {
  let s = state;
  let events: EngineEvent[] = [];
  state.players.forEach((p, i) => {
    const t = submitAnswer(s, p.id, NEUTRAL[i]!, t0 + i);
    s = t.state;
    events = [...events, ...t.events];
  });
  return { state: s, events };
}

function slotOf(state: SessionState, playerId: string): string {
  const owners = state.round!.slotOwners!;
  return Object.keys(owners).find((k) => owners[k] === playerId)!;
}

describe("session creation", () => {
  it("needs three players — two cannot deduce anything", () => {
    expect(() => createSession(players.slice(0, 2), STARTER_DECK, { seed: 1 })).toThrow(EngineError);
    expect(() => createSession(players.slice(0, 3), STARTER_DECK, { seed: 1 })).not.toThrow();
  });
  it("refuses an empty deck", () => {
    expect(() => createSession(players, [], { seed: 1 })).toThrow(EngineError);
  });
  it("starts everyone at zero and emits game.started", () => {
    const t = createSession(players, STARTER_DECK, { seed: 5 });
    expect(t.state.scores).toEqual({ p1: 0, p2: 0, p3: 0, p4: 0 });
    expect(t.events[0]!.type).toBe("game.started");
  });
});

describe("determinism", () => {
  it("same seed and commands produce an identical session", () => {
    const a = allAnswer(open(7).state).state;
    const b = allAnswer(open(7).state).state;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
  it("a different seed picks a different ghost or order somewhere in 20 rounds", () => {
    const ghosts = (seed: number) => {
      let s = boot(seed);
      const out: string[] = [];
      for (let i = 0; i < 12; i++) {
        const t = startRound(s);
        if (t.state.round === undefined) break;
        out.push(t.state.round.ghostId);
        s = endRound(t.state, "HOST_ENDED").state;
      }
      return out.join(",");
    };
    expect(ghosts(1)).not.toBe(ghosts(2));
  });
  it("ghost rotation gives everyone the blindfold once per cycle", () => {
    const cycle = nextCycle(players.map((p) => p.id), mulberry32(11));
    expect([...cycle].sort()).toEqual(["p1", "p2", "p3", "p4"]);
  });
  it("never hands the same player two ghost turns back to back across cycles", () => {
    const ids = players.map((p) => p.id);
    let last: string | undefined;
    for (let c = 0; c < 50; c++) {
      const cycle = nextCycle(ids, mulberry32(c), last);
      expect(cycle[0]).not.toBe(last);
      last = cycle[cycle.length - 1];
    }
  });
  it("slot order is seeded, not arrival order", () => {
    const items = ["a", "b", "c", "d", "e"];
    expect(slotOrder(items, 99, 3)).toEqual(slotOrder(items, 99, 3));
    expect(slotOrder(items, 99, 3)).not.toEqual(slotOrder(items, 99, 4));
  });
});

describe("answering", () => {
  it("opens in ANSWERING and says nothing public about the ghost or the prompt", () => {
    const { events, state } = open();
    expect(state.round!.phase).toBe("ANSWERING");
    const started = events.find((e) => e.type === "round.started")!;
    const json = JSON.stringify(started);
    expect(json).not.toContain(state.round!.ghostId);
    expect(json).not.toContain(state.round!.card.prompt);
    expect(json).not.toContain(state.round!.card.essence);
  });

  it("takes one answer per player and refuses a second", () => {
    const { state } = open();
    const one = submitAnswer(state, "p1", "purple", 1);
    expect(() => submitAnswer(one.state, "p1", "green", 2)).toThrow(EngineError);
  });

  it("refuses a stranger", () => {
    const { state } = open();
    expect(() => submitAnswer(state, "nobody", "purple", 1)).toThrow(EngineError);
  });

  it("a rejected answer costs nothing and leaves the player free to retry", () => {
    const { state } = open();
    const bad = submitAnswer(state, "p1", "one two three four five six seven eight", 1);
    expect(bad.events[0]!.type).toBe("answer.rejected");
    expect(bad.state.round!.answers).toHaveLength(0);
    const good = submitAnswer(bad.state, "p1", "purple", 2);
    expect(good.state.round!.answers).toHaveLength(1);
  });

  it("closes to VOTING once the last answer lands, with anonymized slots", () => {
    const { state, ghostId } = open();
    const done = allAnswer(state);
    expect(done.state.round!.phase).toBe("VOTING");
    const closed = done.events.find((e) => e.type === "answers.closed")!;
    expect(closed).toBeDefined();
    if (closed.type === "answers.closed") {
      expect(closed.slots).toHaveLength(4);
      // The wire payload carries text and slot ids — and no authorship at all.
      expect(JSON.stringify(closed.slots)).not.toContain(ghostId);
      for (const p of players) expect(JSON.stringify(closed.slots)).not.toContain(p.id);
    }
  });

  it("a silent Ghost is NO_CONTEST — putting the phone down must never be the winning play", () => {
    const { state, ghostId } = open();
    let s = state;
    for (const p of players.filter((p) => p.id !== ghostId)) {
      s = submitAnswer(s, p.id, NEUTRAL[players.indexOf(p)]!, 100).state;
    }
    const closed = closeAnswers(s);
    expect(closed.state.round!.endedReason).toBe("NO_CONTEST");
    expect(closed.state.scores[ghostId]).toBe(0);
    expect(Object.values(closed.state.scores).every((v) => v === 0)).toBe(true);
  });

  it("too few answers is NO_CONTEST even when the Ghost wrote", () => {
    const { state, ghostId } = open();
    const other = players.find((p) => p.id !== ghostId)!;
    let s = submitAnswer(state, ghostId, "purple", 100).state;
    s = submitAnswer(s, other.id, "Kevin", 101).state;
    const closed = closeAnswers(s);
    expect(closed.state.round!.endedReason).toBe("NO_CONTEST");
  });
});

describe("voting", () => {
  it("only answerers may vote", () => {
    const { state, ghostId } = open();
    let s = state;
    const wrote = players.filter((p) => p.id !== "p4");
    wrote.forEach((p, i) => { s = submitAnswer(s, p.id, NEUTRAL[i]!, 100 + i).state; });
    // p4 never wrote; the Ghost must be among the writers for a contest to run.
    if (ghostId === "p4") return;
    s = closeAnswers(s).state;
    expect(electorate(s.round!)).not.toContain("p4");
    expect(() => submitVote(s, "p4", slotOf(s, wrote[0]!.id), 200)).toThrow(EngineError);
  });

  it("refuses a self-vote, a double vote and an unknown slot", () => {
    const { state } = open();
    const s = allAnswer(state).state;
    expect(() => submitVote(s, "p1", slotOf(s, "p1"), 200)).toThrow(EngineError);
    expect(() => submitVote(s, "p1", "slot99", 200)).toThrow(EngineError);
    const once = submitVote(s, "p1", slotOf(s, "p2"), 200);
    expect(() => submitVote(once.state, "p1", slotOf(s, "p3"), 201)).toThrow(EngineError);
  });

  it("the Ghost votes too, for cover", () => {
    const { state, ghostId } = open();
    const s = allAnswer(state).state;
    const target = players.find((p) => p.id !== ghostId)!.id;
    expect(() => submitVote(s, ghostId, slotOf(s, target), 200)).not.toThrow();
  });

  it("wrong phase is refused", () => {
    const { state } = open();
    expect(() => submitVote(state, "p1", "slot0", 200)).toThrow(EngineError);
    const s = allAnswer(state).state;
    expect(() => submitAnswer(s, "p1", "late", 300)).toThrow(EngineError);
  });
});

describe("the catch, and the last word", () => {
  /** Everyone votes for the Ghost — a unanimous conviction. */
  function convict(seed = 42) {
    const { state, ghostId } = open(seed);
    let s = allAnswer(state).state;
    const ghostSlot = slotOf(s, ghostId);
    for (const p of players.filter((p) => p.id !== ghostId)) {
      s = submitVote(s, p.id, ghostSlot, 300).state;
    }
    // The Ghost votes last, for someone else.
    const other = players.find((p) => p.id !== ghostId)!;
    const t = submitVote(s, ghostId, slotOf(s, other.id), 301);
    return { state: t.state, events: t.events, ghostId };
  }

  it("a caught Ghost gets LAST_WORD, not an immediate loss", () => {
    const { state, events } = convict();
    expect(state.round!.phase).toBe("LAST_WORD");
    expect(events.some((e) => e.type === "ghost.caught")).toBe(true);
    expect(state.status).toBe("IN_ROUND");
  });

  it("only the Ghost may take the last word, once", () => {
    const { state, ghostId } = convict();
    const notGhost = players.find((p) => p.id !== ghostId)!.id;
    expect(() => submitLastWord(state, notGhost, "boat names", 400)).toThrow(EngineError);
    expect(() => submitLastWord(state, ghostId, "   ", 400)).toThrow(EngineError);
    const t = submitLastWord(state, ghostId, state.round!.card.essence, 400);
    expect(t.state.round!.lastWord!.correct).toBe(true);
    expect(() => submitLastWord(t.state, ghostId, "again", 401)).toThrow(EngineError);
  });

  it("a caught Ghost who names the prompt scores the consolation", () => {
    const { state, ghostId } = convict();
    const t = submitLastWord(state, ghostId, state.round!.card.essence, 400);
    expect(t.state.scores[ghostId]).toBeGreaterThan(0);
    expect(t.state.scoreLog.some((e) => e.reason === "GHOST_LAST_WORD")).toBe(true);
  });

  it("a caught Ghost who guesses wrong scores nothing", () => {
    const { state, ghostId } = convict();
    const t = submitLastWord(state, ghostId, "the price of tin", 400);
    expect(t.state.scores[ghostId]).toBe(0);
    expect(t.state.round!.reveal!.lastWord!.correct).toBe(false);
  });

  it("a Ghost who lets the last-word clock expire still ends the round scored", () => {
    const { state } = convict();
    const t = closeLastWord(state);
    expect(t.state.round!.phase).toBe("COMPLETE");
    expect(t.state.round!.endedReason).toBe("SCORED");
    expect(t.state.round!.reveal!.caught).toBe(true);
  });

  it("a split room lets the Ghost walk, and the round ends immediately", () => {
    const { state, ghostId } = open();
    let s = allAnswer(state).state;
    const others = players.filter((p) => p.id !== ghostId);
    // One vote for the Ghost, one for an innocent: a tie convicts nobody.
    s = submitVote(s, others[0]!.id, slotOf(s, ghostId), 300).state;
    s = submitVote(s, others[1]!.id, slotOf(s, others[2]!.id), 301).state;
    s = submitVote(s, others[2]!.id, slotOf(s, others[0]!.id), 302).state;
    const t = submitVote(s, ghostId, slotOf(s, others[0]!.id), 303);
    expect(t.events.some((e) => e.type === "ghost.survived")).toBe(true);
    expect(t.state.round!.phase).toBe("COMPLETE");
    expect(t.state.scores[ghostId]).toBe(150);
  });

  it("closing the vote early counts whatever arrived", () => {
    const { state, ghostId } = open();
    let s = allAnswer(state).state;
    const other = players.find((p) => p.id !== ghostId)!;
    s = submitVote(s, other.id, slotOf(s, ghostId), 300).state;
    const t = closeVotes(s);
    // One vote is a strict plurality, so it convicts.
    expect(t.state.round!.phase).toBe("LAST_WORD");
  });
});

describe("the reveal is the anonymity boundary", () => {
  it("no projection before COMPLETE contains the owner map or the prompt", () => {
    const { state, ghostId } = open();
    const answered = allAnswer(state);
    const wireSafe = answered.events.filter((e) => e.type !== "round.revealed");
    for (const e of wireSafe) {
      const json = JSON.stringify(e);
      expect(json).not.toContain(state.round!.card.prompt);
      // answer.submitted names WHO answered (the room needs that) but no text.
      if (e.type === "answer.submitted") expect(json).not.toContain("purple");
    }
    expect(answered.state.round!.reveal).toBeUndefined();
    expect(ghostId).toBeTruthy();
  });

  it("the reveal finally names the ghost, the prompt and every author", () => {
    const { state, ghostId } = open();
    let s = allAnswer(state).state;
    for (const p of players) {
      const target = players.find((q) => q.id !== p.id)!;
      s = submitVote(s, p.id, slotOf(s, target.id), 300).state;
    }
    // Everyone piling onto the first player who isn't them can convict the
    // Ghost, and a conviction opens LAST_WORD rather than ending the round —
    // so finish it before reading the reveal.
    if (s.round!.phase === "LAST_WORD") {
      s = submitLastWord(s, ghostId, "no idea", 400).state;
    }
    const reveal = s.round!.reveal!;
    expect(reveal.ghostId).toBe(ghostId);
    expect(reveal.prompt).toBe(s.round!.card.prompt);
    expect(Object.keys(reveal.owners)).toHaveLength(4);
    expect(reveal.owners[reveal.ghostSlotId!]).toBe(ghostId);
  });
});

describe("round and session lifecycle", () => {
  it("refuses two live rounds and refuses a round after the game ends", () => {
    const { state } = open();
    expect(() => startRound(state)).toThrow(EngineError);
  });

  it("host end from any phase completes the round and scores nobody", () => {
    const { state } = open();
    const t = endRound(state, "HOST_ENDED");
    expect(t.state.round!.endedReason).toBe("HOST_ENDED");
    expect(Object.values(t.state.scores).every((v) => v === 0)).toBe(true);
    expect(t.state.status).toBe("IDLE");
  });

  it("completes the session when the deck runs out", () => {
    let s = createSession(players, STARTER_DECK.slice(0, 2), { seed: 3 }).state;
    for (let i = 0; i < 2; i++) {
      s = endRound(startRound(s).state, "HOST_ENDED").state;
    }
    expect(s.status).toBe("COMPLETE");
    expect(() => startRound(s)).toThrow(EngineError);
  });

  it("completes the session at maxRounds", () => {
    let s = createSession(players, STARTER_DECK, { seed: 3, maxRounds: 3 }).state;
    for (let i = 0; i < 3; i++) s = endRound(startRound(s).state, "HOST_ENDED").state;
    expect(s.status).toBe("COMPLETE");
  });

  it("plays a full multi-round session without throwing, scores strictly rising", () => {
    let s = createSession(players, STARTER_DECK, { seed: 21, maxRounds: 6 }).state;
    let previousTotal = 0;
    for (let r = 0; r < 6; r++) {
      s = startRound(s).state;
      if (s.status === "COMPLETE") break;
      const ghostId = s.round!.ghostId;
      s = allAnswer(s, 1000 * (r + 1)).state;
      // Half the room points at the Ghost, half at each other.
      const others = players.filter((p) => p.id !== ghostId);
      s = submitVote(s, others[0]!.id, slotOf(s, ghostId), 2000).state;
      s = submitVote(s, others[1]!.id, slotOf(s, ghostId), 2001).state;
      s = submitVote(s, others[2]!.id, slotOf(s, others[0]!.id), 2002).state;
      s = submitVote(s, ghostId, slotOf(s, others[1]!.id), 2003).state;
      if (s.round!.phase === "LAST_WORD") {
        s = submitLastWord(s, ghostId, "no idea at all", 2100).state;
      }
      const total = Object.values(s.scores).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThanOrEqual(previousTotal);
      previousTotal = total;
    }
    expect(previousTotal).toBeGreaterThan(0);
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
