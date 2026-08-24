/**
 * Deck assembly: the starter deck plus every forged pack on disk.
 *
 * This is the ONLY place the generated content meets the game, and it is pure
 * file reading — no model, no network. @gww/say-less stays zero-I/O; the forge
 * owns the filesystem.
 */

import { STARTER_DECK, type Card, normalize } from "@gww/say-less";
import { readPackItems } from "./pack.js";
import { sayLessCards } from "./specs/say-less-cards.js";

/**
 * The full deck. Starter cards first (they are the hand-authored floor), then
 * every packed card that isn't already present by secret. Duplicates lose to
 * whatever came first, so a pack can never shadow a hand-authored card.
 */
export function loadDeck(base?: string): Card[] {
  const deck: Card[] = [...STARTER_DECK];
  const seen = new Set(deck.map((c) => normalize(c.secret)));
  for (const card of readPackItems<Card>(sayLessCards.id, base)) {
    const key = normalize(card.secret);
    if (seen.has(key)) continue;
    seen.add(key);
    deck.push(card);
  }
  return deck;
}
