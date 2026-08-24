/**
 * Packs on disk: versioned, additive, provenanced.
 *
 * A pack is written once and never edited by the forge. New content goes into
 * the next numbered file. Nothing is ever deleted or overwritten — if a pack
 * turns out to be bad, it gets disabled by moving it, by hand, by a human.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContentSpec, Provenance } from "./spec.js";
import { promptHash } from "./generate.js";

export interface Pack<T> {
  provenance: Provenance;
  items: T[];
}

/** Repo-relative root for all packs; overridable for tests and alternate trees. */
export function packRoot(base = process.env["GWW_PACK_DIR"] ?? "packs"): string {
  return base;
}

export function packDir(specId: string, base?: string): string {
  return join(packRoot(base), specId);
}

/** Every pack file for a spec, oldest first. Missing directory means no packs. */
export function listPacks(specId: string, base?: string): string[] {
  const dir = packDir(specId, base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^pack-\d{3}\.json$/.test(f))
    .sort()
    .map((f) => join(dir, f));
}

/** Read every pack for a spec and concatenate the items in pack order. */
export function readPackItems<T>(specId: string, base?: string): T[] {
  const out: T[] = [];
  for (const file of listPacks(specId, base)) {
    try {
      const pack = JSON.parse(readFileSync(file, "utf8")) as Pack<T>;
      if (Array.isArray(pack.items)) out.push(...pack.items);
    } catch {
      // A corrupt pack must never take the game down — skip it loudly.
      console.warn(`[forge] skipping unreadable pack: ${file}`);
    }
  }
  return out;
}

/** The keys already in the packs, so generation can be told what to avoid. */
export function existingKeys<T>(spec: ContentSpec<T>, base?: string): string[] {
  return readPackItems<T>(spec.id, base).map((i) => spec.key(i));
}

function nextPackPath(specId: string, base?: string): string {
  const dir = packDir(specId, base);
  mkdirSync(dir, { recursive: true });
  const used = listPacks(specId, base)
    .map((f) => Number(/pack-(\d{3})\.json$/.exec(f)?.[1] ?? "0"));
  const next = (used.length > 0 ? Math.max(...used) : 0) + 1;
  return join(dir, `pack-${String(next).padStart(3, "0")}.json`);
}

/**
 * Open a pack for INCREMENTAL writing.
 *
 * A 40-card run takes the better part of an hour, and writing only at the end
 * meant a Ctrl-C threw away every accepted card. Learned the hard way: the
 * first good card muse ever wrote ("dmv waiting room") was lost this way.
 *
 * Each add() rewrites the whole file. The files are small, the writes are rare,
 * and the run becomes interruptible at any moment without losing work.
 */
export function openPack<T>(
  spec: ContentSpec<T>,
  model: string,
  base?: string,
): { file: string; add(item: T): void; count(): number } {
  const file = nextPackPath(spec.id, base);
  const pack: Pack<T> = {
    provenance: {
      specId: spec.id,
      specVersion: spec.version,
      model,
      generatedAt: new Date().toISOString(),
      promptHash: promptHash(spec as ContentSpec<unknown>),
    },
    items: [],
  };
  return {
    file,
    add(item: T): void {
      pack.items.push(item);
      writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`);
    },
    count: () => pack.items.length,
  };
}

/** Write a new pack in one shot. Refuses to touch an existing file — additive only. */
export function writePack<T>(
  spec: ContentSpec<T>,
  items: T[],
  model: string,
  base?: string,
): { file: string; count: number } {
  const file = nextPackPath(spec.id, base);
  if (existsSync(file)) throw new Error(`refusing to overwrite an existing pack: ${file}`);
  const pack: Pack<T> = {
    provenance: {
      specId: spec.id,
      specVersion: spec.version,
      model,
      generatedAt: new Date().toISOString(),
      promptHash: promptHash(spec as ContentSpec<unknown>),
    },
    items,
  };
  writeFileSync(file, `${JSON.stringify(pack, null, 2)}\n`);
  return { file, count: items.length };
}
