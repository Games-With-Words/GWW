import { describe, it, expect } from "vitest";
import { countWords, matchesEssence, findTellingTerm, normalize, tokenize, contentTokens } from "../src/normalize.js";
import { validateAnswer, matchLastWord, tallyVotes, isCaught, framedPlayer } from "../src/rules.js";
import type { AnswerRecord, PromptCard } from "../src/types.js";

const boats: PromptCard = {
  id: "t1",
  prompt: "What's the worst possible name for a boat?",
  essence: "bad boat names",
  aliases: ["terrible boat names", "naming a boat"],
  category: "Mixed Chaos",
  telling: ["boat", "ship", "yacht", "cat"],
  difficulty: 1,
};

const none: AnswerRecord[] = [];

describe("text policy v1 — matches Say Less where it must", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalize("Café CRÈME")).toBe("cafe creme");
  });
  it("hyphens split into two words", () => {
    expect(countWords("twenty-two")).toBe(2);
  });
  it("apostrophes collapse in place", () => {
    expect(countWords("don't")).toBe(1);
    expect(tokenize("don't")[0]).toBe("dont");
  });
  it("emoji count zero", () => {
    expect(countWords("wow!!! 🎉🎉")).toBe(1);
  });
  it("digit runs are one word", () => {
    expect(countWords("in 1993 exactly")).toBe(3);
  });
  it("drops stopwords for subject comparison", () => {
    expect(contentTokens("the worst of the boat names")).toEqual(["boat", "names"]);
  });
});

describe("validateAnswer", () => {
  it("accepts a short answer", () => {
    const v = validateAnswer(boats, "The Codfather", none, 6, false);
    expect(v.status).toBe("ACCEPTED");
    if (v.status === "ACCEPTED") expect(v.wordCount).toBe(2);
  });
  it("rejects empty and whitespace-only", () => {
    expect(validateAnswer(boats, "", none, 6, false).status).toBe("REJECTED");
    const v = validateAnswer(boats, "  !!! ", none, 6, false);
    expect(v.status === "REJECTED" && v.reason).toBe("EMPTY");
  });
  it("rejects over the word ceiling", () => {
    const v = validateAnswer(boats, "one two three four five six seven", none, 6, false);
    expect(v.status === "REJECTED" && v.reason).toBe("TOO_LONG");
  });
  it("rejects an answer that would hand the prompt to the Ghost", () => {
    const v = validateAnswer(boats, "sinking boat", none, 6, false);
    expect(v.status === "REJECTED" && v.reason).toBe("TOO_TELLING");
  });
  it("lets the GHOST say a telling term — that is them winning, not leaking", () => {
    const v = validateAnswer(boats, "sinking boat", none, 6, true);
    expect(v.status).toBe("ACCEPTED");
  });
  it("rejects a duplicate of an answer already in", () => {
    const existing: AnswerRecord[] = [
      { playerId: "p1", text: "The Codfather", normalized: "the codfather", at: 1 },
    ];
    const v = validateAnswer(boats, "the CODFATHER!", existing, 6, false);
    expect(v.status === "REJECTED" && v.reason).toBe("DUPLICATE");
  });
  it("reports TOO_TELLING before DUPLICATE — a leak outranks a dull answer", () => {
    const existing: AnswerRecord[] = [{ playerId: "p1", text: "big boat", normalized: "big boat", at: 1 }];
    const v = validateAnswer(boats, "big boat", existing, 6, false);
    expect(v.status === "REJECTED" && v.reason).toBe("TOO_TELLING");
  });
});

describe("findTellingTerm — whole tokens only", () => {
  it("does not fire on a word that merely contains the term", () => {
    // "cat" is a telling term here; "catastrophe" must not trip it.
    expect(findTellingTerm("total catastrophe", boats.telling)).toBeUndefined();
  });
  it("matches a multi-word term as a contiguous phrase", () => {
    expect(findTellingTerm("a used car lot", ["used car"])).toBe("used car");
    expect(findTellingTerm("car used badly", ["used car"])).toBeUndefined();
  });
});

describe("matchLastWord", () => {
  it("accepts the essence itself", () => {
    expect(matchLastWord(boats, "bad boat names")).toBe(true);
  });
  it("accepts a subset that still names the subject", () => {
    expect(matchLastWord(boats, "boat names")).toBe(true);
  });
  it("accepts a predeclared alias", () => {
    expect(matchLastWord(boats, "naming a boat")).toBe(true);
  });
  it("ignores stopwords and word order", () => {
    expect(matchLastWord(boats, "the names of boats... bad ones")).toBe(false);
    expect(matchLastWord(boats, "names boat bad")).toBe(true);
  });
  it("refuses a different subject that shares a word", () => {
    expect(matchLastWord(boats, "boat insurance premiums")).toBe(false);
  });
  it("refuses empty and stopword-only guesses", () => {
    expect(matchLastWord(boats, "")).toBe(false);
    expect(matchLastWord(boats, "the of a")).toBe(false);
  });
  it("is not a substring test — a prefix must not pay out", () => {
    const cat: PromptCard = { ...boats, essence: "art", aliases: [] };
    expect(matchesEssence("party", cat.essence, cat.aliases)).toBe(false);
    expect(matchesEssence("art", cat.essence, cat.aliases)).toBe(true);
  });
});

describe("tally and conviction", () => {
  const owners = { slot0: "ghost", slot1: "p2", slot2: "p3", slot3: "p4" };

  it("orders by votes then slotId, stably", () => {
    const t = tallyVotes(
      [{ slotId: "slot2" }, { slotId: "slot1" }, { slotId: "slot2" }],
      owners,
    );
    expect(t.map((x) => x.slotId)).toEqual(["slot2", "slot1"]);
    expect(t[0]!.playerId).toBe("p3");
  });

  it("catches the Ghost on a strict plurality", () => {
    const t = tallyVotes([{ slotId: "slot0" }, { slotId: "slot0" }, { slotId: "slot1" }], owners);
    expect(isCaught(t, "slot0")).toBe(true);
  });

  it("lets the Ghost walk on a TIE — a split room has convicted nobody", () => {
    const t = tallyVotes([{ slotId: "slot0" }, { slotId: "slot1" }], owners);
    expect(isCaught(t, "slot0")).toBe(false);
  });

  it("lets the Ghost walk when someone else led the vote", () => {
    const t = tallyVotes([{ slotId: "slot1" }, { slotId: "slot1" }, { slotId: "slot0" }], owners);
    expect(isCaught(t, "slot0")).toBe(false);
  });

  it("catches nobody when no votes came in", () => {
    expect(isCaught([], "slot0")).toBe(false);
    expect(isCaught(tallyVotes([{ slotId: "slot1" }], owners), undefined)).toBe(false);
  });

  it("pays the most-suspected innocent, and nobody on a tie", () => {
    const clear = tallyVotes([{ slotId: "slot1" }, { slotId: "slot1" }, { slotId: "slot2" }], owners);
    expect(framedPlayer(clear, "slot0")).toBe("p2");
    const tied = tallyVotes([{ slotId: "slot1" }, { slotId: "slot2" }], owners);
    expect(framedPlayer(tied, "slot0")).toBeUndefined();
  });

  it("never frames the Ghost", () => {
    const t = tallyVotes([{ slotId: "slot0" }, { slotId: "slot0" }], owners);
    expect(framedPlayer(t, "slot0")).toBeUndefined();
  });
});
