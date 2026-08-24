/**
 * The generator: asks a model for one item, extracts it from a sentinel block,
 * runs it through the spec's gate. Offline only — see spec.ts for the invariant.
 *
 * Transport is PIN, server-to-server with the aai_ key, same as the voice
 * pipeline. Model is configurable so muse-local and gemma4 can be compared on
 * an identical spec without touching code.
 */

import { createHash } from "node:crypto";
import { extractBlocks, extractTaggedBlocks } from "sentinel-blocks";
import { systemPrompt, type ContentSpec, type GateResult } from "./spec.js";

export interface ForgeConfig {
  aiasUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Sampling temperature — high, because variety is the whole point. */
  temperature: number;
}

export function forgeConfigFromEnv(): ForgeConfig {
  return {
    aiasUrl: process.env["AIAS_URL"] ?? "https://aiassist.net",
    apiKey: process.env["AIAS_API_KEY"],
    model: process.env["GWW_FORGE_MODEL"] ?? "muse-local:latest",
    temperature: Number(process.env["GWW_FORGE_TEMP"] ?? 1.0),
  };
}

export function promptHash(spec: ContentSpec<unknown>): string {
  return createHash("sha256").update(systemPrompt(spec)).digest("hex").slice(0, 12);
}

/** Why an attempt produced nothing. Every one of these is logged, never silent. */
export type Failure =
  | { kind: "http"; status: number }
  | { kind: "truncated" }
  | { kind: "no_block" }
  | { kind: "unterminated" }
  | { kind: "incomplete"; missing: string[] }
  | { kind: "gated"; reason: string }
  | { kind: "duplicate"; key: string }
  | { kind: "threw"; detail: string };

export type Attempt<T> = { ok: true; item: T } | { ok: false; failure: Failure; raw?: string };

/**
 * Pull the payload out of a completion.
 *
 * The request is NOT streamed — we already hold the whole completion before
 * this runs. What matters is WHICH blocks to read.
 *
 * For field specs there is no parse step at all: each value arrives in its own
 * named block, so there are no quotes to escape, no braces to balance, and
 * nothing that can throw. The last block for a given field wins, because the
 * prompt tells the model that rewriting the set replaces it.
 *
 * (This replaced a JSON payload. muse emitted a skeleton "{" block and a real
 * one, we read the first, and got "Expected property name at position 2".
 * Mark's call: it only ever needed to be parseable inside the blocks.)
 */
export function payloadFromCompletion<T>(
  spec: ContentSpec<T>,
  content: string,
  thinking: string,
): GateResult<T> {
  const open = `<<<${spec.tag}`;
  let sawOpen = false;
  let lastReason = "no_block";

  for (const channel of [content, thinking]) {
    if (channel.length === 0) continue;
    if (channel.includes(open)) sawOpen = true;

    if (spec.payload === "text") {
      const blocks = extractBlocks(channel, spec.tag);
      for (let i = blocks.length - 1; i >= 0; i--) {
        const r = spec.gate(blocks[i]!);
        if (r.ok) return r;
        lastReason = r.reason;
      }
      continue;
    }

    // Field blocks: collect them, last write per field wins.
    const tagged = extractTaggedBlocks(channel, spec.tag);
    if (tagged.length === 0) continue;
    const values: Record<string, string> = {};
    for (const { arg, content: v } of tagged) {
      if (arg.length === 0) continue;
      values[arg] = v.trim();
    }
    const missing = (spec.required ?? []).filter((f) => (values[f] ?? "").length === 0);
    if (missing.length > 0) {
      lastReason = "incomplete";
      // Keep looking — the other channel may hold the complete set.
      const other = channel === content ? thinking : "";
      if (other.length === 0) return { ok: false, reason: "incomplete", missing };
      continue;
    }
    const r = spec.gate(values);
    if (r.ok) return r;
    lastReason = r.reason;
  }

  if (sawOpen && lastReason === "no_block") return { ok: false, reason: "unterminated" };
  return { ok: false, reason: lastReason };
}

/** Split a multi-value field: one value per line, blank lines dropped. */
export function lines(v: string | undefined): string[] {
  if (v === undefined) return [];
  return v
    .split("\n")
    .map((l) => l.trim().replace(/^[-*\u2022]\s*/, "").replace(/^["'\u201c\u2018]+|["'\u201d\u2019]+$/g, "").trim())
    .filter((l) => l.length > 0);
}

/** One generation attempt. No token cap — the model thinks as long as it needs. */
export async function generateOne<T>(
  spec: ContentSpec<T>,
  cfg: ForgeConfig,
  ctx: { seed: number; avoid: string[] },
  fetcher: typeof fetch = fetch,
): Promise<Attempt<T>> {
  if (cfg.apiKey === undefined || cfg.apiKey.length === 0) {
    return { ok: false, failure: { kind: "threw", detail: "AIAS_API_KEY not set" } };
  }
  let res: Response;
  try {
    res = await fetcher(`${cfg.aiasUrl}/api/v1/pin/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt(spec) },
          { role: "user", content: spec.user(ctx) },
        ],
        temperature: cfg.temperature,
        // NO max_tokens. Capping a thinking model starves the reasoning pass
        // and the answer channel comes back empty. Learned the hard way.
      }),
    });
  } catch (err) {
    return { ok: false, failure: { kind: "threw", detail: err instanceof Error ? err.message : String(err) } };
  }
  if (!res.ok) return { ok: false, failure: { kind: "http", status: res.status } };

  const body = (await res.json()) as {
    choices?: {
      finish_reason?: string;
      message?: { content?: string; thinking?: string; reasoning_content?: string };
      text?: string;
    }[];
  };
  const choice = body.choices?.[0];
  if (choice?.finish_reason === "length") return { ok: false, failure: { kind: "truncated" } };

  const content = choice?.message?.content ?? choice?.text ?? "";
  const thinking = choice?.message?.thinking ?? choice?.message?.reasoning_content ?? "";
  const verdict = payloadFromCompletion(spec, content, thinking);
  if (verdict.ok) return { ok: true, item: verdict.item };

  const raw = content.length > 0 ? content : thinking;
  if (verdict.reason === "no_block") return { ok: false, failure: { kind: "no_block" }, raw };
  if (verdict.reason === "unterminated") return { ok: false, failure: { kind: "unterminated" }, raw };
  if (verdict.reason === "incomplete") {
    return { ok: false, failure: { kind: "incomplete", missing: verdict.missing ?? [] }, raw };
  }
  return { ok: false, failure: { kind: "gated", reason: verdict.reason }, raw };
}

export interface BatchResult<T> {
  accepted: T[];
  rejected: { attempt: number; failure: Failure; raw?: string }[];
}

/**
 * Generate until `want` items pass, or `maxAttempts` is spent. Sequential on
 * purpose: it's a background job, and one local model serving one request at a
 * time gives better lines than four fighting for the GPU.
 */
export async function generateBatch<T>(
  spec: ContentSpec<T>,
  cfg: ForgeConfig,
  want: number,
  opts: {
    avoid?: string[];
    maxAttempts?: number;
    fetcher?: typeof fetch;
    seed?: number;
    onProgress?: (msg: string) => void;
  } = {},
): Promise<BatchResult<T>> {
  const avoid = new Set(opts.avoid ?? []);
  const maxAttempts = opts.maxAttempts ?? want * 3;
  const fetcher = opts.fetcher ?? fetch;
  const log = opts.onProgress ?? (() => {});
  const baseSeed = opts.seed ?? Math.floor(Date.now() / 1000);

  const accepted: T[] = [];
  const rejected: BatchResult<T>["rejected"] = [];

  for (let attempt = 1; attempt <= maxAttempts && accepted.length < want; attempt++) {
    const r = await generateOne(spec, cfg, { seed: baseSeed + attempt, avoid: [...avoid] }, fetcher);
    if (!r.ok) {
      rejected.push({ attempt, failure: r.failure, ...(r.raw !== undefined ? { raw: r.raw } : {}) });
      log(`  [${attempt}] rejected: ${describe(r.failure)}`);
      // For these three the raw text IS the diagnosis — print it NOW, not in a
      // summary the operator may never reach. Ctrl-C cost us a round trip.
      const shape = r.failure.kind;
      if (r.raw !== undefined && (shape === "no_block" || shape === "unterminated" || shape === "incomplete")) {
        log(`       raw tail: ${JSON.stringify(r.raw.slice(-400))}`);
      }
      continue;
    }
    const key = spec.key(r.item);
    if (avoid.has(key)) {
      rejected.push({ attempt, failure: { kind: "duplicate", key } });
      log(`  [${attempt}] duplicate: ${key}`);
      continue;
    }
    avoid.add(key);
    accepted.push(r.item);
    log(`  [${attempt}] accepted: ${key}  (${accepted.length}/${want})`);
  }
  return { accepted, rejected };
}

export function describe(f: Failure): string {
  switch (f.kind) {
    case "http": return `HTTP ${f.status}`;
    case "truncated": return "truncated (finish_reason=length) — check the upstream token limit";
    case "no_block": return "no sentinel block closed";
    case "unterminated": return `opened <<<TAG>>> but never closed it — the model stopped mid-block`;
    case "incomplete": return `missing field block(s): ${f.missing.join(", ")}`;
    case "gated": return `gate: ${f.reason}`;
    case "duplicate": return `duplicate ${f.key}`;
    case "threw": return f.detail;
  }
}
