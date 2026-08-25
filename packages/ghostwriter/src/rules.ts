/**
 * Ghostwriter rule checks. Pure, deterministic, no clocks.
 *
 * Everything here is a check a player at the table cannot police themselves,
 * either because they can't see the information (is this a duplicate of an
 * answer already in?) or because policing it would require them to know the
 * prompt (did that answer give the game away?).
 */

import { countWords, findTellingTerm, matchesEssence, normalize } from "./normalize.js";
import type { AnswerRecord, AnswerVerdict, PromptCard } from "./types.js";

/**
 * Validate one answer.
 *
 * Order matters and is deliberate: EMPTY, then TOO_LONG, then TOO_TELLING, then
 * DUPLICATE. The player should hear the most fixable complaint first, and
 * TOO_TELLING before DUPLICATE because a telling answer is a leak and a
 * duplicate is merely dull.
 */
export function validateAnswer(
  card: PromptCard,
  text: string,
  existing: readonly AnswerRecord[],
  maxWords: number,
  isGhost: boolean,
): AnswerVerdict {
  const normalized = normalize(text);
  const wordCount = countWords(text);

  if (wordCount === 0) {
    return { status: "REJECTED", reason: "EMPTY", detail: "An answer needs at least one word." };
  }
  if (wordCount > maxWords) {
    return {
      status: "REJECTED",
      reason: "TOO_LONG",
      detail: `${wordCount} words — the limit is ${maxWords}. Short answers keep the Ghost alive.`,
    };
  }

  /**
   * The Ghost is exempt from TOO_TELLING, and that is not a loophole.
   *
   * The check exists to stop a player who HAS the prompt from copying it onto
   * the public board, which would end the round instantly. A Ghost who lands on
   * a telling term has not leaked anything — they guessed the subject blind,
   * which is the single most impressive thing that can happen in this game. It
   * should win, loudly, not get thrown back with an error.
   */
  if (!isGhost) {
    const term = findTellingTerm(text, card.telling);
    if (term !== undefined) {
      return {
        status: "REJECTED",
        reason: "TOO_TELLING",
        detail: `"${term}" would hand the prompt to the Ghost. Say it sideways.`,
      };
    }
  }

  if (existing.some((a) => a.normalized === normalized)) {
    return {
      status: "REJECTED",
      reason: "DUPLICATE",
      detail: "Someone already wrote that. Hiding behind a copy isn't a bluff.",
    };
  }

  return { status: "ACCEPTED", normalized, wordCount };
}

/** Did the caught Ghost name the prompt's subject? */
export function matchLastWord(card: PromptCard, text: string): boolean {
  return matchesEssence(text, card.essence, card.aliases);
}

/**
 * Count votes per slot.
 *
 * Returns every slot that received at least one vote, highest first, ties broken
 * by slotId so the order is stable across replays.
 */
export function tallyVotes(
  votes: readonly { slotId: string }[],
  owners: Readonly<Record<string, string>>,
): { slotId: string; playerId: string; votes: number }[] {
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.slotId, (counts.get(v.slotId) ?? 0) + 1);
  return [...counts.entries()]
    .map(([slotId, n]) => ({ slotId, playerId: owners[slotId] ?? "", votes: n }))
    .sort((a, b) => (b.votes - a.votes) || a.slotId.localeCompare(b.slotId));
}

/**
 * Was the Ghost caught?
 *
 * The Ghost must hold a STRICT plurality of the vote to go down: most votes, and
 * not tied with anyone. A tie means the room argued and split, and a split room
 * has not caught anybody — the Ghost walks. This is a deliberate bias toward the
 * Ghost surviving, for two reasons. It keeps the blindfold seat desirable, and a
 * near-miss ("we HAD you") is a better story at the table than a coin-flip
 * conviction. The whole party then watches the reveal to find out how close they
 * were, which is the beat this game exists for.
 */
export function isCaught(
  tally: readonly { slotId: string; votes: number }[],
  ghostSlotId: string | undefined,
): boolean {
  if (ghostSlotId === undefined || tally.length === 0) return false;
  const top = tally[0]!;
  if (top.slotId !== ghostSlotId) return false;
  const runnerUp = tally[1];
  return runnerUp === undefined || runnerUp.votes < top.votes;
}

/**
 * The innocent player who drew the most suspicion from THE ROOM, if any did.
 *
 * Paid because being wrongly suspected is funny and takes skill — an innocent
 * answer weird enough to look blind is doing the Ghost's job by accident. Ties
 * pay nobody: a single villain per round, or none.
 *
 * CRITICAL: the tally passed here must EXCLUDE the Ghost's own vote. Found in a
 * live smoke run, not by a unit test — a player caught the Ghost, collected 100,
 * and then collected the framed bonus too, because the Ghost's one deflection
 * vote had landed on her and made her the "most suspected innocent" by default.
 *
 * The Ghost voting is misdirection, not the room's judgment. Letting it award a
 * bonus means the Ghost picks who gets 40 points on their way down, which is a
 * strategy nobody at the table would ever guess exists.
 */
export function framedPlayer(
  roomTally: readonly { slotId: string; playerId: string; votes: number }[],
  ghostSlotId: string | undefined,
): string | undefined {
  const innocent = roomTally.filter((t) => t.slotId !== ghostSlotId && t.votes > 0 && t.playerId !== "");
  if (innocent.length === 0) return undefined;
  const top = innocent[0]!;
  const next = innocent[1];
  if (next !== undefined && next.votes === top.votes) return undefined;
  return top.playerId;
}
