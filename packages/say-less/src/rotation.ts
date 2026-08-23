/**
 * Fair speaker rotation with no immediate repeats (spec §04 core round, step 1).
 * Deterministic: seeded PRNG (mulberry32), so identical seed + players = identical order.
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
 * Produce the next rotation cycle. Guarantees the first speaker of the new cycle
 * is not the last speaker of the previous cycle (no immediate repeat across cycles).
 */
export function nextCycle(playerIds: readonly string[], rng: () => number, lastSpeaker?: string): string[] {
  if (playerIds.length <= 1) return [...playerIds];
  let cycle = seededShuffle(playerIds, rng);
  if (lastSpeaker !== undefined && cycle[0] === lastSpeaker) {
    // Deterministic fix-up: swap head with a rng-chosen later position.
    const j = 1 + Math.floor(rng() * (cycle.length - 1));
    const a = cycle[0]!;
    cycle[0] = cycle[j]!;
    cycle[j] = a;
  }
  return cycle;
}
