/**
 * Deterministic clue validation and guess matching (spec §04 core round + rule boundaries).
 * Everything here is a pure function. No model, no I/O, no clock.
 */

import { tokenize, normalize } from "./normalize.js";
import type { Card, ClueVerdict } from "./types.js";

/** Phrases that signal a sounds-like / spelling loophole (spec §04: hard-rejected). */
const LOOPHOLE_PHRASES = [
  "rhymes with",
  "sounds like",
  "starts with",
  "ends with",
  "first letter",
  "last letter",
  "spelled",
  "spelt",
  "letters",
  "initials",
];

/** Minimum token length considered for the "obvious substring" rule. */
const SUBSTRING_MIN = 4;

function answerTokens(card: Card): Set<string> {
  const set = new Set<string>();
  for (const t of tokenize(card.secret)) set.add(t);
  for (const alias of card.aliases) for (const t of tokenize(alias)) set.add(t);
  return set;
}

function forbiddenTokens(card: Card): Set<string> {
  const set = new Set<string>();
  for (const f of card.forbidden) for (const t of tokenize(f)) set.add(t);
  return set;
}

/**
 * Validate a clue against a card and budget.
 * Order of checks matters and is part of rules_version say-less/1:
 * EMPTY -> OVER_BUDGET -> ANSWER/ALIAS token -> FORBIDDEN -> OBVIOUS_SUBSTRING
 * -> SOUNDS_LIKE loophole -> INITIALS heuristic (SUSPICIOUS) -> ACCEPTED.
 */
export function validateClue(card: Card, clue: string, budget: number): ClueVerdict {
  const tokens = tokenize(clue);
  const normalized = tokens.join(" ");

  if (tokens.length === 0) {
    return { status: "REJECTED", reason: "EMPTY", detail: "Clue contains no words." };
  }
  if (tokens.length > budget) {
    return {
      status: "REJECTED",
      reason: "OVER_BUDGET",
      detail: `Clue is ${tokens.length} words; budget is ${budget}.`,
    };
  }

  const answers = answerTokens(card);
  const secretSet = new Set(tokenize(card.secret));
  const forbidden = forbiddenTokens(card);

  for (const t of tokens) {
    if (secretSet.has(t)) {
      return { status: "REJECTED", reason: "ANSWER_TOKEN", detail: `"${t}" is part of the answer.` };
    }
    if (answers.has(t)) {
      return { status: "REJECTED", reason: "ALIAS_TOKEN", detail: `"${t}" is part of an accepted alias.` };
    }
    if (forbidden.has(t)) {
      return { status: "REJECTED", reason: "FORBIDDEN_TERM", detail: `"${t}" is forbidden on this card.` };
    }
  }

  // Obvious substring: clue token contains (or is contained by) an answer token, both length >= 4.
  for (const t of tokens) {
    if (t.length < SUBSTRING_MIN) continue;
    for (const a of answers) {
      if (a.length < SUBSTRING_MIN) continue;
      if (t.includes(a) || a.includes(t)) {
        return {
          status: "REJECTED",
          reason: "OBVIOUS_SUBSTRING",
          detail: `"${t}" is an obvious fragment of the answer.`,
        };
      }
    }
  }

  const joined = normalized;
  for (const phrase of LOOPHOLE_PHRASES) {
    if (joined.includes(phrase)) {
      return {
        status: "REJECTED",
        reason: "SOUNDS_LIKE_LOOPHOLE",
        detail: `"${phrase}" is a spelling/sound loophole.`,
      };
    }
  }

  // Initials heuristic: two or more single-letter tokens matching the answer's
  // initials in order -> SUSPICIOUS (room vote decides; spec §04: party retains final authority).
  const singles = tokens.filter((t) => t.length === 1 && /\p{Letter}/u.test(t));
  if (singles.length >= 2) {
    const initials = tokenize(card.secret).map((w) => w[0]);
    const inOrder = singles.every((s, i) => initials[i] === s);
    if (inOrder && singles.length <= initials.length) {
      return {
        status: "SUSPICIOUS",
        reason: "Single letters matching the answer's initials.",
        normalized,
        wordCount: tokens.length,
      };
    }
  }

  return { status: "ACCEPTED", normalized, wordCount: tokens.length };
}

/** Deterministic guess matching: exact or predeclared alias after normalization (spec §04 step 7). */
export function matchGuess(card: Card, guess: string): boolean {
  const g = normalize(guess);
  if (g.length === 0) return false;
  if (g === normalize(card.secret)) return true;
  return card.aliases.some((a) => normalize(a) === g);
}
