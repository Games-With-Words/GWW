/**
 * Deterministic text normalization — the written tokenization policy required by
 * spec §04 rule boundaries ("punctuation, emoji and hyphens require a written
 * deterministic policy before launch"). THIS FILE IS THAT POLICY.
 *
 * Policy v1 (rules_version say-less/1):
 *  1. Unicode NFKD, diacritics stripped (café -> cafe).
 *  2. Lowercased.
 *  3. Hyphens, slashes, underscores and all punctuation become spaces —
 *     "twenty-two" counts as TWO words. Compression is the game.
 *  4. Apostrophes are removed in place — "don't" is ONE word ("dont").
 *  5. Emoji and symbols are stripped and count as ZERO words.
 *  6. Digit runs are single words ("1993" = one word).
 *  7. The word count is the number of resulting whitespace-separated tokens.
 */

const APOSTROPHES = /[’'`ʼ]/g;
const NON_WORD = /[^\p{Letter}\p{Number}]+/gu;

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/\p{Mark}/gu, "");
}

/** Normalize free text to canonical comparison form: lowercase tokens joined by single spaces. */
export function normalize(s: string): string {
  return tokenize(s).join(" ");
}

/** Tokenize per policy v1. */
export function tokenize(s: string): string[] {
  const cleaned = stripDiacritics(s).toLowerCase().replace(APOSTROPHES, "");
  return cleaned.split(NON_WORD).filter((t) => t.length > 0);
}

/** Lexical word count per policy v1. */
export function countWords(s: string): number {
  return tokenize(s).length;
}
