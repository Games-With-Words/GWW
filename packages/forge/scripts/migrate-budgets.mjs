/**
 * One-time correction: say-less-cards spec v1 -> v2 budget rescale.
 *
 * WHY THIS EXISTS
 * Spec v1 gated `budget` on a 1-7 scale, and the engine then ignored the field
 * entirely. v2 makes the field load-bearing on a 6-20 scale, so every card
 * already committed carries a number from the wrong scale — and because the
 * engine takes min(card.budget, cycleCeiling), a v1 card would play at 6 words
 * for the whole game, at every cycle. That is exactly the "nobody wants to make
 * a 1 word clue" complaint, preserved for the 41 forged cards that make up most
 * of the deck.
 *
 * WHY IT IS A SCRIPT AND NOT A HAND EDIT
 * Packs are append-only by design; the forge never rewrites one. This is the
 * documented exception — a unit change, not a content change — so it is done
 * once, in the open, by a rule anyone can re-derive and re-run.
 *
 * WHAT IT TOUCHES
 * `budget` only. Secrets, aliases, categories, forbidden lists, difficulties
 * and reveal lines are left byte-identical, and nothing is ever removed. The
 * new value comes from the card's own difficulty, the same rule the
 * hand-authored starter deck uses: harder secrets need more room to set up.
 *
 * Provenance is stamped rather than overwritten: the pack still says muse wrote
 * it, and now also says these budgets were remapped by machine and not authored
 * at their present values. Idempotent — re-running is a no-op.
 *
 *   node packages/forge/scripts/migrate-budgets.mjs [--write]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = "budget-v1-to-v2";
const NOTE = "budget rescaled from the v1 1-7 range to the v2 6-20 range as 12 + 2*difficulty; no other field altered";
const DIR = process.env["GWW_PACK_DIR"] ?? "packs";
const SPEC = "say-less-cards";
const write = process.argv.includes("--write");

/** The starter deck's rule: 14 for a warm-up, 20 for a finale. */
const budgetFor = (difficulty) => Math.max(6, Math.min(20, 12 + 2 * Number(difficulty)));

const dir = join(DIR, SPEC);
if (!existsSync(dir)) {
  console.error(`no pack directory at ${dir}`);
  process.exit(1);
}

let changedPacks = 0;
let changedCards = 0;

for (const file of readdirSync(dir).filter((f) => /^pack-\d+\.json$/.test(f)).sort()) {
  const path = join(dir, file);
  const pack = JSON.parse(readFileSync(path, "utf8"));
  const applied = pack.provenance?.migrations ?? [];
  if (applied.includes(MIGRATION)) {
    console.log(`${file}: already migrated, skipping`);
    continue;
  }

  let touched = 0;
  for (const card of pack.items ?? []) {
    const next = budgetFor(card.difficulty);
    if (card.budget === next) continue;
    console.log(`  ${card.secret}: budget ${card.budget} -> ${next}  (difficulty ${card.difficulty})`);
    card.budget = next;
    touched++;
  }

  if (touched === 0) {
    console.log(`${file}: nothing to change`);
    continue;
  }

  pack.provenance = {
    ...pack.provenance,
    specVersion: "2",
    migrations: [...applied, MIGRATION],
    migrationNotes: { ...(pack.provenance?.migrationNotes ?? {}), [MIGRATION]: NOTE },
  };

  console.log(`${file}: ${touched} card(s) rescaled`);
  changedPacks++;
  changedCards += touched;
  if (write) writeFileSync(path, `${JSON.stringify(pack, null, 2)}\n`);
}

console.log(
  write
    ? `\nwrote ${changedPacks} pack(s), ${changedCards} card(s) rescaled`
    : `\nDRY RUN — ${changedPacks} pack(s), ${changedCards} card(s) would change. Re-run with --write.`,
);
