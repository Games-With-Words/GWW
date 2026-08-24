#!/usr/bin/env node
/**
 * gww-forge — run a content pack offline.
 *
 *   gww-forge say-less-cards 40
 *   gww-forge ris-lines clue 8
 *   gww-forge list
 *
 * Reads AIAS_API_KEY and GWW_FORGE_MODEL from the environment. Prints an
 * accept/reject report and writes a new numbered pack. Never overwrites.
 */

import { forgeConfigFromEnv, generateBatch, describe } from "./generate.js";
import { existingKeys, writePack, readPackItems } from "./pack.js";
import { sayLessCards } from "./specs/say-less-cards.js";
import { CUES, risLines, type Cue } from "./specs/ris-lines.js";
import type { ContentSpec } from "./spec.js";

function resolveSpec(argv: string[]): { spec: ContentSpec<unknown>; rest: string[] } | undefined {
  const [name, ...rest] = argv;
  if (name === "say-less-cards") return { spec: sayLessCards as ContentSpec<unknown>, rest };
  if (name === "ris-lines") {
    const cue = rest[0] as Cue | undefined;
    if (cue === undefined || !CUES.includes(cue)) {
      console.error(`ris-lines needs a cue: ${CUES.join(" | ")}`);
      return undefined;
    }
    return { spec: risLines(cue) as ContentSpec<unknown>, rest: rest.slice(1) };
  }
  return undefined;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  if (argv[0] === "models") {
    // The real endpoint, read off the live OpenAPI spec rather than guessed:
    // /api/v1/pin/network/models, returns { models: string[] }, no auth needed.
    const cfg = forgeConfigFromEnv();
    const url = `${cfg.aiasUrl}/api/v1/pin/network/models`;
    const res = await fetch(url, {
      ...(cfg.apiKey !== undefined && cfg.apiKey.length > 0
        ? { headers: { authorization: `Bearer ${cfg.apiKey}` } }
        : {}),
    });
    if (!res.ok) {
      console.error(`PIN returned HTTP ${res.status} for ${url}`);
      return 1;
    }
    const body = (await res.json()) as { models?: unknown };
    const found = Array.isArray(body.models)
      ? body.models.filter((m): m is string => typeof m === "string").sort()
      : [];
    if (found.length === 0) {
      console.log(JSON.stringify(body).slice(0, 800));
      return 0;
    }
    // Writers first — the -extract and tts entries are a different job.
    const extract = found.filter((m) => /extract|^tts:|verif/.test(m));
    const writers = found.filter((m) => !extract.includes(m));
    console.log("writers (use one of these):");
    for (const m of writers) console.log(`  ${m}`);
    console.log("\nnot writers — extraction/TTS/verifier tunings:");
    for (const m of extract) console.log(`  ${m}`);
    console.log(`\ncurrent: GWW_FORGE_MODEL=${cfg.model}`);
    console.log(`example: GWW_FORGE_MODEL=gemma4:26b node dist/cli.js say-less-cards 40`);
    return 0;
  }

  if (argv.length === 0 || argv[0] === "list") {
    console.log("specs:");
    console.log(`  say-less-cards           (${readPackItems(sayLessCards.id).length} in packs)`);
    for (const cue of CUES) {
      const s = risLines(cue);
      console.log(`  ris-lines ${cue.padEnd(8)}       (${readPackItems(s.id).length} in packs)`);
    }
    console.log("\nusage: node dist/cli.js <spec> [cue] <count>");
    console.log("       node dist/cli.js models     # what PIN serves");
    return 0;
  }

  const resolved = resolveSpec(argv);
  if (resolved === undefined) {
    console.error(`unknown spec "${argv[0]}" — try: gww-forge list`);
    return 1;
  }
  const { spec, rest } = resolved;
  const want = Number(rest[0] ?? 10);
  if (!Number.isInteger(want) || want < 1 || want > 500) {
    console.error(`count must be an integer 1-500, got "${rest[0]}"`);
    return 1;
  }

  const cfg = forgeConfigFromEnv();
  if (cfg.apiKey === undefined || cfg.apiKey.length === 0) {
    console.error("AIAS_API_KEY is not set — the forge cannot reach PIN.");
    return 1;
  }

  const avoid = existingKeys(spec);
  console.log(`forging ${want} x ${spec.id} (v${spec.version}) with ${cfg.model}`);
  console.log(`avoiding ${avoid.length} key(s) already in packs\n`);

  const started = Date.now();
  const { accepted, rejected } = await generateBatch(spec, cfg, want, {
    avoid,
    onProgress: (m) => console.log(m),
  });
  const secs = Math.round((Date.now() - started) / 1000);

  console.log(`\n${accepted.length} accepted, ${rejected.length} rejected, ${secs}s`);
  if (rejected.length > 0) {
    const tally = new Map<string, number>();
    for (const r of rejected) {
      const k = r.failure.kind === "gated" ? `gate: ${r.failure.reason.split(":")[0]}` : r.failure.kind;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    console.log("rejection reasons:");
    for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${n} x ${k}`);
    // Show one full example so a systematic problem is obvious immediately.
    const first = rejected[0]!;
    console.log(`\nfirst rejection in full: ${describe(first.failure)}`);
    if (first.raw !== undefined) console.log(`raw tail: ${JSON.stringify(first.raw.slice(-300))}`);
  }

  if (accepted.length === 0) {
    console.log("\nnothing accepted — no pack written.");
    return 1;
  }
  const { file, count } = writePack(spec, accepted, cfg.model);
  console.log(`\nwrote ${count} item(s) -> ${file}`);
  console.log("review it, then commit it. Nothing is live until it's on disk in git.");
  return 0;
}

main().then((code) => process.exit(code), (err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
