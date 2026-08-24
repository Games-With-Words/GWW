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
import { formatReminder, systemPrompt, type ContentSpec, type GateResult } from "./spec.js";

export interface ForgeConfig {
  aiasUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Sampling temperature — high, because variety is the whole point. */
  temperature: number;
  /**
   * Generation ceiling. Omitting max_tokens is NOT unlimited — it hands the
   * ceiling to the server's default, which is smaller than a thinking model
   * needs. Muse was being cut mid-thought ("Hmm random seed ") before she ever
   * reached her blocks. So we set it high, explicitly, and own the number.
   */
  maxTokens: number;
}

export function forgeConfigFromEnv(): ForgeConfig {
  return {
    aiasUrl: process.env["AIAS_URL"] ?? "https://aiassist.net",
    apiKey: process.env["AIAS_API_KEY"],
    model: process.env["GWW_FORGE_MODEL"] ?? "muse-local:latest",
    temperature: Number(process.env["GWW_FORGE_TEMP"] ?? 1.0),
    maxTokens: Number(process.env["GWW_FORGE_MAX_TOKENS"] ?? 16384),
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

interface StreamResult {
  content: string;
  thinking: string;
  finishReason: string | undefined;
  /** True when we closed the connection ourselves because the payload was done. */
  earlyStop: boolean;
}

/**
 * Read an SSE chat-completion stream to the end — or until the model has
 * closed every block we need, whichever comes first.
 *
 * Why streaming: a 16k-token deliberation takes minutes, and a non-streamed
 * request sits idle for all of it. The proxy killed those with a 504. With a
 * stream, bytes keep moving and nothing idles out.
 *
 * Why early stop: the closing markers ARE the model saying DONE. Once every
 * required block is closed there is nothing left to wait for, so we stop
 * reading and free the GPU instead of letting it ramble to the token ceiling.
 * This is not eager parsing — we never judge a block until it is closed.
 *
 * Also handles a NON-streamed body, so a server that ignores stream:true (and
 * every test fixture) still works.
 */
export async function readStream<T>(
  res: Response,
  spec: ContentSpec<T>,
  onToken?: (chars: number) => void,
): Promise<StreamResult> {
  const ct = res.headers.get("content-type") ?? "";
  const raw = await res.text();

  // Not an SSE stream? Parse it as a single completion object.
  if (!ct.includes("event-stream") && !raw.startsWith("data:")) {
    const body = JSON.parse(raw) as {
      choices?: {
        finish_reason?: string;
        message?: { content?: string; thinking?: string; reasoning_content?: string };
        text?: string;
      }[];
    };
    const c = body.choices?.[0];
    return {
      content: c?.message?.content ?? c?.text ?? "",
      thinking: c?.message?.thinking ?? c?.message?.reasoning_content ?? "",
      finishReason: c?.finish_reason,
      earlyStop: false,
    };
  }
  return accumulateSse(raw, spec, onToken);
}

/** Fold SSE `data:` frames into the two channels. */
export function accumulateSse<T>(
  raw: string,
  spec: ContentSpec<T>,
  onToken?: (chars: number) => void,
): StreamResult {
  let content = "";
  let thinking = "";
  let finishReason: string | undefined;
  let earlyStop = false;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") break;
    let frame: {
      choices?: {
        finish_reason?: string;
        delta?: { content?: string; thinking?: string; reasoning_content?: string };
        message?: { content?: string; thinking?: string; reasoning_content?: string };
      }[];
    };
    try {
      frame = JSON.parse(payload) as typeof frame;
    } catch {
      continue; // a partial frame; the next one carries the rest
    }
    const c = frame.choices?.[0];
    const d = c?.delta ?? c?.message;
    if (d?.content !== undefined) content += d.content;
    if (d?.thinking !== undefined) thinking += d.thinking;
    if (d?.reasoning_content !== undefined) thinking += d.reasoning_content;
    if (c?.finish_reason !== undefined && c.finish_reason !== null) finishReason = c.finish_reason;
    onToken?.(content.length + thinking.length);
    if (payloadComplete(spec, content, thinking)) {
      earlyStop = true;
      break;
    }
  }
  return { content, thinking, finishReason, earlyStop };
}

/** Has the model closed everything we asked for? Closed blocks only. */
export function payloadComplete<T>(spec: ContentSpec<T>, content: string, thinking: string): boolean {
  for (const channel of [content, thinking]) {
    if (channel.length === 0) continue;
    if (spec.payload === "text") {
      if (extractBlocks(channel, spec.tag).length > 0) return true;
      continue;
    }
    const seen = new Set(extractTaggedBlocks(channel, spec.tag).map((b) => b.arg));
    const required = spec.required ?? [];
    if (required.length > 0 && required.every((f) => seen.has(f))) return true;
  }
  return false;
}

/** One generation attempt. No token cap — the model thinks as long as it needs. */
export async function generateOne<T>(
  spec: ContentSpec<T>,
  cfg: ForgeConfig,
  ctx: { seed: number; avoid: string[]; onToken?: (chars: number) => void },
  fetcher: typeof fetch = fetch,
  /** A failed prior reply, replayed so the model can be corrected in-turn. */
  correction?: { badReply: string },
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
          // The reminder rides on the USER turn, where every model weights it.
          { role: "user", content: `${spec.user(ctx)}\n${formatReminder(spec)}` },
          // A model that answered in prose gets shown its own reply and told
          // to convert it — cheaper and more honest than parsing markdown.
          ...(correction !== undefined
            ? [
                { role: "assistant", content: correction.badReply.slice(0, 4000) },
                {
                  role: "user",
                  content:
                    "That was not the required format. Do not explain, do not " +
                    "apologise, do not write markdown or bullets. Take ONE item " +
                    "from what you just wrote and re-emit it as the sentinel " +
                    `blocks only.\n${formatReminder(spec)}`,
                },
              ]
            : []),
        ],
        temperature: cfg.temperature,
        // RAISE the ceiling, do not remove it. Removing it means the server
        // default applies, and that default cut muse off mid-deliberation.
        max_tokens: cfg.maxTokens,
        num_predict: cfg.maxTokens,
        // STREAM. A 16k-token think takes minutes, and a non-streamed request
        // sits idle that whole time — the proxy gave up with a 504. Streaming
        // keeps bytes flowing, so nothing times out, and the model tells us
        // it's DONE by closing its blocks. Mark called this from the start.
        stream: true,
      }),
    });
  } catch (err) {
    return { ok: false, failure: { kind: "threw", detail: err instanceof Error ? err.message : String(err) } };
  }
  if (!res.ok) return { ok: false, failure: { kind: "http", status: res.status } };

  let stream: StreamResult;
  try {
    stream = await readStream(res, spec, ctx.onToken);
  } catch (err) {
    return { ok: false, failure: { kind: "threw", detail: err instanceof Error ? err.message : String(err) } };
  }
  if (stream.finishReason === "length") return { ok: false, failure: { kind: "truncated" } };

  const { content, thinking } = stream;
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
    /** Streaming heartbeat — total chars received so far on this attempt. */
    onTick?: (chars: number) => void;
    /** Called the moment an item passes — lets the caller persist as it goes. */
    onAccept?: (item: T) => void;
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
    // Heartbeat: a 16k think is minutes of silence otherwise. Show it living.
    let ticked = 0;
    const onToken = (chars: number): void => {
      if (chars - ticked < 400) return;
      ticked = chars;
      opts.onTick?.(chars);
    };
    let r = await generateOne(spec, cfg, { seed: baseSeed + attempt, avoid: [...avoid], onToken }, fetcher);
    // A gateway hiccup (502/503/504) is transient — the local model is fine,
    // the proxy blinked. Try once more before spending the attempt.
    if (!r.ok && r.failure.kind === "http" && r.failure.status >= 502) {
      log(`  [${attempt}] gateway ${r.failure.status} — retrying once`);
      r = await generateOne(spec, cfg, { seed: baseSeed + attempt, avoid: [...avoid], onToken }, fetcher);
    }
    // One corrective round when the model answered in prose. Teach the format,
    // never parse around it — that road led to the JSON repair pile.
    if (!r.ok && r.failure.kind === "no_block" && r.raw !== undefined && r.raw.length > 0) {
      log(`  [${attempt}] no blocks — showing it its own reply and asking again`);
      r = await generateOne(spec, cfg, { seed: baseSeed + attempt, avoid: [...avoid], onToken }, fetcher, {
        badReply: r.raw,
      });
    }
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
    // Persist NOW. A long run must survive a Ctrl-C without losing work.
    opts.onAccept?.(r.item);
    // Show the WHOLE item, not just its key — the operator is reviewing
    // content as it lands, and a key tells them nothing about quality.
    log(`  [${attempt}] accepted (${accepted.length}/${want}):`);
    log(spec.preview !== undefined ? spec.preview(r.item) : `  ${key}`);
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
