import { describe, it, expect } from "vitest";
import { normalize, tokenize, countWords } from "../src/normalize.js";
import { validateClue, matchGuess } from "../src/rules.js";
import type { Card } from "../src/types.js";

const jurassic: Card = {
  id: "t1",
  secret: "Jurassic Park",
  aliases: ["Jurassic", "Jurassic Park movie"],
  category: "Movies",
  forbidden: ["dinosaur", "movie", "island", "park"],
  budget: 5,
  difficulty: 2,
};

describe("normalize policy v1", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalize("Café CRÈME")).toBe("cafe creme");
  });
  it("hyphens split into two words", () => {
    expect(countWords("twenty-two")).toBe(2);
  });
  it("apostrophes collapse to one word", () => {
    expect(countWords("don't")).toBe(1);
    expect(tokenize("don't")[0]).toBe("dont");
  });
  it("emoji and punctuation count zero", () => {
    expect(countWords("wow!!! 🎉🎉")).toBe(1);
  });
  it("digit runs are one word", () => {
    expect(countWords("in 1993 exactly")).toBe(3);
  });
});

describe("validateClue — spec §04 rule boundaries", () => {
  it("accepts the canonical example clue", () => {
    const v = validateClue(jurassic, "Scientists regret opening prehistoric zoo", 5);
    expect(v.status).toBe("ACCEPTED");
    if (v.status === "ACCEPTED") expect(v.wordCount).toBe(5);
  });
  it("rejects over budget", () => {
    const v = validateClue(jurassic, "Scientists deeply regret opening a prehistoric zoo", 5);
    expect(v).toMatchObject({ status: "REJECTED", reason: "OVER_BUDGET" });
  });
  it("rejects answer token", () => {
    expect(validateClue(jurassic, "Jurassic era zoo", 5)).toMatchObject({
      status: "REJECTED",
      reason: "ANSWER_TOKEN",
    });
  });
  it("rejects forbidden term", () => {
    expect(validateClue(jurassic, "Scary dinosaur place", 5)).toMatchObject({
      status: "REJECTED",
      reason: "FORBIDDEN_TERM",
    });
  });
  it("rejects obvious substring", () => {
    expect(validateClue(jurassic, "Jurassically bad idea", 5)).toMatchObject({
      status: "REJECTED",
      reason: "OBVIOUS_SUBSTRING",
    });
  });
  it("rejects sounds-like loopholes", () => {
    expect(validateClue(jurassic, "rhymes with classic lark", 5)).toMatchObject({
      status: "REJECTED",
      reason: "SOUNDS_LIKE_LOOPHOLE",
    });
  });
  it("flags initials as SUSPICIOUS, not auto-rejected — the party decides", () => {
    const v = validateClue(jurassic, "j p", 5);
    expect(v.status).toBe("SUSPICIOUS");
  });
  it("rejects empty clue", () => {
    expect(validateClue(jurassic, "  !!! ", 5)).toMatchObject({ status: "REJECTED", reason: "EMPTY" });
  });
  it("does not false-positive on innocent short words", () => {
    // "part" contains "par" but neither is an answer token; "spark" vs "park" IS a substring hit.
    expect(validateClue(jurassic, "sparks flying everywhere", 5).status).toBe("REJECTED");
    expect(validateClue(jurassic, "prehistoric theme attraction", 5).status).toBe("ACCEPTED");
  });
});

describe("matchGuess — deterministic exact + alias", () => {
  it("matches exact secret case-insensitively", () => {
    expect(matchGuess(jurassic, "jurassic park")).toBe(true);
  });
  it("matches predeclared alias", () => {
    expect(matchGuess(jurassic, "Jurassic")).toBe(true);
  });
  it("does not match near-misses — ambiguity routes to review, never silent trust", () => {
    expect(matchGuess(jurassic, "jurassic world")).toBe(false);
    expect(matchGuess(jurassic, "")).toBe(false);
  });
});

// ---- fuzzy correctness: forgiving typos WITHOUT making words interchangeable ----
import { describe as fdesc, expect as fexp, it as fit } from "vitest";
import { matchGuess as fmatch, editBudget, editDistance, singular } from "../src/rules.js";
import type { Card as FCard } from "../src/types.js";

const card = (secret: string, aliases: string[] = []): FCard => ({
  id: "t", secret, aliases, category: "Family",
  forbidden: ["a", "b", "c"], budget: 3, difficulty: 2,
});

fdesc("fuzzy guess matching", () => {
  fit("still accepts everything the exact matcher accepted", () => {
    fexp(fmatch(card("Jurassic Park"), "jurassic park")).toBe(true);
    fexp(fmatch(card("Jurassic Park"), "  JURASSIC   PARK  ")).toBe(true);
    fexp(fmatch(card("Don't Look Up"), "dont look up")).toBe(true);
    fexp(fmatch(card("Café"), "cafe")).toBe(true);
    fexp(fmatch(card("Titanic", ["the Titanic"]), "the titanic")).toBe(true);
  });

  fit("forgives the typo that used to lose a round", () => {
    fexp(fmatch(card("Jurassic Park"), "jurassic parc")).toBe(true);
    fexp(fmatch(card("Thanksgiving"), "thanksgivng")).toBe(true);
    fexp(fmatch(card("Karaoke"), "karoake")).toBe(true);
  });

  fit("forgives singular and plural in both directions", () => {
    fexp(fmatch(card("Wet socks"), "wet sock")).toBe(true);
    fexp(fmatch(card("Leftover"), "leftovers")).toBe(true);
    fexp(fmatch(card("Inside jokes"), "inside joke")).toBe(true);
    fexp(fmatch(card("Box"), "boxes")).toBe(true);
  });

  fit("REFUSES to make short words interchangeable — the reason for length scaling", () => {
    // A flat distance of 2 would accept every one of these. All must fail.
    fexp(fmatch(card("Dip"), "tip")).toBe(false);
    fexp(fmatch(card("Dip"), "top")).toBe(false);
    fexp(fmatch(card("Cat"), "hat")).toBe(false);
    fexp(fmatch(card("Cake"), "lake")).toBe(false);
    fexp(fmatch(card("Wine"), "wife")).toBe(false);
  });

  fit("refuses a genuinely different answer of any length", () => {
    fexp(fmatch(card("Jurassic Park"), "jurassic world")).toBe(false);
    fexp(fmatch(card("Thanksgiving"), "christmas")).toBe(false);
    fexp(fmatch(card("Road trip"), "road rage")).toBe(false);
  });

  fit("refuses a guess with the wrong number of words", () => {
    fexp(fmatch(card("Air guitar"), "guitar")).toBe(false);
    fexp(fmatch(card("Karaoke"), "karaoke night")).toBe(false);
    fexp(fmatch(card("Air guitar"), "")).toBe(false);
  });

  fit("applies the same tolerance to aliases", () => {
    fexp(fmatch(card("Group chat", ["the group chat"]), "the groop chat")).toBe(true);
  });

  fit("gives a token tolerance only when its neighbours corroborate it", () => {
    // Uncorroborated (single-word answer): short words must be exact.
    fexp(editBudget("dip", false)).toBe(0);
    fexp(editBudget("cake", false)).toBe(0);
    fexp(editBudget("karaoke", false)).toBe(1);
    fexp(editBudget("thanksgiving", false)).toBe(2);
    // Corroborated: the rest of the phrase matched exactly, so a slip is a typo.
    fexp(editBudget("park", true)).toBe(1);
    fexp(editBudget("cake", true)).toBe(1);
  });

  fit("refuses two wrong words — that is a different answer, not a typo", () => {
    fexp(fmatch(card("Group chat"), "groop chit")).toBe(false);
  });

  fit("does not let a long phrase's budget rescue a genuinely wrong word", () => {
    // "jurassic park" has a 2-edit budget, but a wrong second word blows past it.
    fexp(fmatch(card("Jurassic Park"), "jurassic shark")).toBe(false);
    fexp(fmatch(card("Group chat"), "group chair")).toBe(false);
  });

  fit("measures edit distance and bails out early past the cap", () => {
    fexp(editDistance("parc", "park", 2)).toBe(1);
    fexp(editDistance("same", "same", 2)).toBe(0);
    fexp(editDistance("kitten", "sitting", 3)).toBe(3);
    // Over the cap returns cap+1, not the true distance — early exit.
    fexp(editDistance("abc", "xyzxyz", 1)).toBe(2);
  });

  fit("strips plurals without mangling words that just end in s", () => {
    fexp(singular("socks")).toBe("sock");
    fexp(singular("boxes")).toBe("box");
    fexp(singular("parties")).toBe("party");
    fexp(singular("glass")).toBe("glass");
    fexp(singular("bus")).toBe("bus");
  });
});
