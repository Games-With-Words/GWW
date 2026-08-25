/**
 * Deterministic randomness: who is the Ghost, and in what order answers appear.
 *
 * Self-contained on purpose. CONTRIBUTING house rule 1 says use the seeded RNG
 * pattern from Say Less's rotation.ts, not import Say Less — a game depending on
 * another game's internals would make the arcade a chain instead of a shelf.
 * Same mulberry32, same Fisher-Yates, no `Math.random()` anywhere in this package.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

/**
 * The next cycle of Ghosts: every player takes the blindfold once per cycle,
 * and never twice in a row across the cycle boundary.
 *
 * Being the Ghost is the good seat — it is the only role with a story to tell
 * afterwards — so "everyone gets it once" is a fairness property, not a chore
 * roster. The no-immediate-repeat fix-up matters more here than it does for a
 * Say Less speaker: two Ghost turns back to back would let one player read the
 * room twice while everyone else waits.
 */
export function nextCycle(playerIds: readonly string[], rng: () => number, lastGhost?: string): string[] {
  if (playerIds.length <= 1) return [...playerIds];
  const cycle = seededShuffle(playerIds, rng);
  if (lastGhost !== undefined && cycle[0] === lastGhost) {
    const j = 1 + Math.floor(rng() * (cycle.length - 1));
    const a = cycle[0]!;
    cycle[0] = cycle[j]!;
    cycle[j] = a;
  }
  return cycle;
}

/**
 * Shuffle answers into board slots.
 *
 * Submission order leaks the Ghost almost as reliably as the text does: writing
 * blind takes longer, so the last answer in is the suspicious one. Ordering by
 * arrival would decide the game before anyone reads a word. Seeded from the
 * session seed and round index — unguessable at the table, identical on replay.
 */
export function slotOrder<T>(items: readonly T[], seed: number, roundIndex: number): T[] {
  return seededShuffle(items, mulberry32((seed ^ (roundIndex * 2654435761)) >>> 0));
}
