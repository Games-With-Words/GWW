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
