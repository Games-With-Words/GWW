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

/**
 * How many edits a token may absorb, given whether the REST of the phrase
 * corroborates it.
 *
 * This is the crux, and it took a failing test to find. "park"/"parc" and
 * "cake"/"lake" are information-theoretically IDENTICAL — one edit, four
 * characters each. No distance rule can accept one and reject the other.
 *
 * What separates them is context. In "jurassic parc" the other word matches
 * EXACTLY, which is strong evidence of a typo rather than a different answer.
 * A bare "lake" for "Cake" has nothing corroborating it, so it must be exact.
 *
 * Hence: a token in a multi-word answer earns tolerance from its neighbours.
 * A lone token earns it only from its own length, where a typo becomes
 * unambiguous ("thanksgivng" is nobody's idea of a different word).
 */
export function editBudget(token: string, corroborated: boolean): number {
  if (corroborated) return Math.max(1, Math.floor(token.length / 4));
  if (token.length >= 8) return 2;
  if (token.length >= 5) return 1;
  return 0;
}

/**
 * Damerau-Levenshtein (optimal string alignment), bailing out past `max`.
 *
 * NOT plain Levenshtein, and the difference decides real rounds: a
 * TRANSPOSITION is the most common human typo, and plain Levenshtein charges
 * 2 for it. "karoake" is one swap from "karaoke" but would score 2 edits,
 * failing a budget of 1. Counting a swap as one edit matches how people
 * actually mistype.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  // Three rolling rows: OSA needs the row before last to see a swap.
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row: number[] = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        prev[j]! + 1,        // deletion
        row[j - 1]! + 1,     // insertion
        prev[j - 1]! + cost, // substitution
      );
      // Transposition: the previous two characters are swapped.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2]! + 1);
      }
      row[j] = v;
      if (v < best) best = v;
    }
    // Every remaining path costs at least `best`; give up early.
    if (best > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length]!;
}

/** Strip a trailing plural so "sock" and "socks" are the same word. */
export function singular(token: string): string {
  if (token.length > 3 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 3 && (token.endsWith("ses") || token.endsWith("xes") || token.endsWith("zes")
    || token.endsWith("ches") || token.endsWith("shes"))) return token.slice(0, -2);
  // Needs 4+ characters: stripping the s off "bus" or "gas" invents a word.
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/**
 * Is `guess` close enough to `answer` to be the same thing?
 *
 * Plurals fold first, then tokens are compared position by position. AT MOST
 * ONE token may differ — two wrong words is a different answer, not a typo —
 * and that one token is judged against a budget that depends on whether its
 * neighbours matched exactly.
 *
 * A differing token count fails outright, so a dropped or added word
 * ("guitar" for "Air guitar") never matches.
 */
function closeEnough(guess: string, answer: string): boolean {
  const g = tokenize(guess).map(singular);
  const a = tokenize(answer).map(singular);
  if (g.length === 0 || g.length !== a.length) return false;

  const differing: number[] = [];
  for (let i = 0; i < a.length; i++) if (g[i] !== a[i]) differing.push(i);
  if (differing.length === 0) return true;
  // Two or more wrong words is a different answer. Only a single slip is a typo.
  if (differing.length > 1) return false;

  const i = differing[0]!;
  const want = a[i]!;
  const got = g[i]!;
  const corroborated = a.length > 1; // every other token matched exactly
  const budget = editBudget(want, corroborated);
  return budget > 0 && editDistance(got, want, budget) <= budget;
}

/**
 * Deterministic guess matching (spec §04 step 7), now FORGIVING.
 *
 * Exact-after-normalize stays the first check, so previous behaviour is a
 * strict subset. Beyond it: singular/plural tolerance, then length-scaled
 * edit distance per token.
 *
 * Why: exact matching made the room argue with the software. "Jurassic Parc"
 * and "Wet sock" were both scored wrong, which is indefensible at a party.
 * Correctness stays machine-judged — no human adjudication, fully replayable
 * from the event log — it is just no longer brittle.
 */
export function matchGuess(card: Card, guess: string): boolean {
  const g = normalize(guess);
  if (g.length === 0) return false;
  // Exact first: cheapest, and it preserves the old contract exactly.
  if (g === normalize(card.secret)) return true;
  if (card.aliases.some((a) => normalize(a) === g)) return true;
  // Then forgiving, against the secret and every alias.
  if (closeEnough(g, card.secret)) return true;
  return card.aliases.some((a) => closeEnough(g, a));
}
