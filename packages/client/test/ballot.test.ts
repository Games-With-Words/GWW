/**
 * Client-side ballot behaviour.
 *
 * The DOM lives in main.ts and isn't unit-tested, so what's asserted here is
 * the contract the UI is built on: what the reducer keeps, and the CSS/markup
 * invariants that are invisible in review and painful on a phone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initialRoom, reduce } from "../src/state.js";

const css = readFileSync(join(import.meta.dirname, "../src/style.css"), "utf8");
const ts = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");

const ballotState = (over: Record<string, unknown> = {}) => ({
  type: "state",
  data: {
    status: "IN_ROUND", roundIndex: 0, maxRounds: 24, scores: {},
    round: {
      index: 0, speakerId: "sp", budget: 5, phase: "BALLOT", category: "Music",
      clue: "strings", guessCount: 3, guessedPlayerIds: ["a", "b", "c"], guesses: [],
      ballot: [
        { slotId: "slot0", text: "banjo" },
        { slotId: "slot1", text: "a haunted lute" },
        { slotId: "slot2", text: "air guitar" },
      ],
      votedBy: [],
      ...over,
    },
  },
});

describe("ballot state", () => {
  it("keeps the anonymized ballot and never invents an owner", () => {
    const s = reduce(initialRoom("a", false, "LOBBY"), ballotState());
    const round = s.game!.round!;
    expect(round.phase).toBe("BALLOT");
    expect(round.ballot).toHaveLength(3);
    for (const slot of round.ballot!) {
      expect(Object.keys(slot).sort()).toEqual(["slotId", "text"]);
    }
  });

  it("carries votedBy so a phone can grey out what it already cast", () => {
    const s = reduce(initialRoom("a", false, "LOBBY"), ballotState({
      votedBy: [{ voterId: "a", category: "FUNNIEST" }],
    }));
    expect(s.game!.round!.votedBy).toEqual([{ voterId: "a", category: "FUNNIEST" }]);
  });

  it("captions the ballot and the reveal in Ris's voice", () => {
    let s = initialRoom("a", false, "LOBBY");
    s = reduce(s, { type: "event", data: { type: "ballot.opened", roundIndex: 0 } });
    expect(s.caption).toMatch(/vote on your phones/i);
    s = reduce(s, { type: "event", data: { type: "round.revealed", roundIndex: 0 } });
    expect(s.caption).toMatch(/who wrote what/i);
  });

  it("does NOT announce a correct guess mid-round — it would bias CLOSEST", () => {
    let s = initialRoom("a", false, "LOBBY");
    s = reduce(s, { type: "event", data: { type: "guess.accepted", roundIndex: 0 } });
    // No caption crowing about a correct answer before the room has voted.
    expect(s.caption ?? "").not.toMatch(/YES|that's it/i);
  });
});

describe("ballot UI invariants", () => {
  it("keeps vote buttons thumb-sized", () => {
    const rule = /button\.vote \{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(rule).toMatch(/min-height:\s*5\dpx/);
    expect(rule).toMatch(/min-width:\s*5\dpx/);
  });

  it("gives the Speaker only the FUNNIEST button — they know the answer", () => {
    // The closest button is rendered behind an isSpeaker check.
    expect(ts).toMatch(/isSpeaker \? "" : `<button class="vote close"/);
  });

  it("disables a category once cast rather than letting the server error", () => {
    expect(ts).toContain('${castF ? " disabled" : ""}');
    expect(ts).toContain('${castC ? " disabled" : ""}');
  });

  it("shows who has answered WITHOUT showing what, while guessing", () => {
    const fn = /function answeredSoFar[\s\S]*?\n}/.exec(ts)?.[0] ?? "";
    expect(fn).toContain("guessedPlayerIds");
    // It must never read the guess values — that is the spoiler.
    expect(fn).not.toContain(".value");
  });
});
