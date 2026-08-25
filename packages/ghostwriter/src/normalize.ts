/**
 * Deterministic text policy for Ghostwriter — tokenization, comparison, and the
 * fuzzy match behind the Ghost's last word.
 *
 * Policy v1 (rules_version ghostwriter/1). Steps 1-6 are deliberately identical
 * to Say Less's policy v1: two games in one arcade disagreeing about whether
 * "don't" is one word would be a bug the room can feel, and packs move between
 * forge specs. Step 7 onward is this game's own, because Ghostwriter never
 * compares an answer to a right answer — it compares answers to each other, and
 * a guessed subject to a canonical one.
 *
 *  1. Unicode NFKD, diacritics stripped (café -> cafe).
 *  2. Lowercased.
 *  3. Punctuation, hyphens, slashes, underscores become separators.
 *  4. Apostrophes removed in place — "don't" is ONE word ("dont").
 *  5. Emoji and symbols are stripped and count as ZERO words.
 *  6. Digit runs are single words ("1993" = one word).
 *  7. Duplicate detection compares the normalized token string exactly.
 *  8. Last-word matching is token-set containment or Jaccard >= LAST_WORD_RATIO,
 *     after dropping stopwords. Never a substring test — see below.
 */

const APOSTROPHES = /[’'`ʼ]/g;
const NON_WORD = /[^\p{Letter}\p{Number}]+/gu;

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/\p{Mark}/gu, "");
}

export function tokenize(s: string): string[] {
  const cleaned = stripDiacritics(s).toLowerCase().replace(APOSTROPHES, "");
  return cleaned.split(NON_WORD).filter((t) => t.length > 0);
}

/** Canonical comparison form: lowercase tokens joined by single spaces. */
export function normalize(s: string): string {
  return tokenize(s).join(" ");
}

export function countWords(s: string): number {
  return tokenize(s).length;
}

/**
 * Words carrying no subject information, dropped before matching a last word.
 *
 * Kept small and closed. A big stopword list starts eating real content words
 * and the failure is silent — the Ghost gets credit for naming nothing.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "of", "in", "on", "at", "to", "for", "and", "or", "but",
  "is", "are", "was", "were", "be", "been", "your", "you", "my", "our", "their",
  "it", "its", "this", "that", "these", "those", "about", "with", "most", "worst",
  "best", "what", "whats", "which", "who", "would", "do", "did", "does",
]);

export function contentTokens(s: string): string[] {
  return tokenize(s).filter((t) => !STOPWORDS.has(t));
}

/**
 * How much overlap counts as naming the same subject.
 *
 * Tuned by hand against the starter deck rather than guessed: at 0.5 the Ghost
 * gets "tourist traps" for "overrated tourist attractions" (containment) and
 * "airport food" for "worst airport in the world" is correctly refused. Raising
 * it makes the bonus unwinnable; lowering it pays out for a shared "food".
 */
export const LAST_WORD_RATIO = 0.5;

/**
 * Does the Ghost's stab at the subject count?
 *
 * Deliberately NOT a substring check on raw strings. `"art".includes` logic pays
 * out on "party", and the Ghost bonus is worth real points — a matcher that can
 * be tripped by an accidental prefix is a matcher players will learn to game
 * with one-word answers. Token sets can't be gamed that way.
 */
export function matchesEssence(guess: string, essence: string, aliases: readonly string[]): boolean {
  const g = new Set(contentTokens(guess));
  if (g.size === 0) return false;
  for (const target of [essence, ...aliases]) {
    const t = new Set(contentTokens(target));
    if (t.size === 0) continue;
    // Containment either way: "tourist traps" names "overrated tourist traps",
    // and a Ghost who says MORE than the essence still named it.
    const inG = [...t].every((tok) => g.has(tok));
    const inT = [...g].every((tok) => t.has(tok));
    if (inG || inT) return true;
    let shared = 0;
    for (const tok of g) if (t.has(tok)) shared += 1;
    const union = new Set([...g, ...t]).size;
    if (union > 0 && shared / union >= LAST_WORD_RATIO) return true;
  }
  return false;
}

/**
 * Would this answer hand the prompt to the Ghost?
 *
 * Matches whole tokens against the card's predeclared telling terms, and treats
 * a multi-word term as a contiguous phrase. Whole-token matching is the point:
 * a "cat" term must not fire on "catastrophe", or players get rejected for
 * writing normal sentences and stop trusting the check.
 */
export function findTellingTerm(answer: string, telling: readonly string[]): string | undefined {
  const tokens = tokenize(answer);
  const joined = ` ${tokens.join(" ")} `;
  for (const term of telling) {
    const t = tokenize(term);
    if (t.length === 0) continue;
    if (joined.includes(` ${t.join(" ")} `)) return term;
  }
  return undefined;
}
