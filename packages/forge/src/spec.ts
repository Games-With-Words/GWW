/**
 * A ContentSpec declares one kind of generated content: what to ask for, how
 * the model must hand it back, and what makes an item good enough to keep.
 *
 * HARD INVARIANT: the forge is OFFLINE. Nothing in this package is imported by
 * the gameplay path. Content is generated on our schedule, gated, written to
 * versioned packs on disk, and only then read by the running game. No player
 * ever waits on a model.
 */

/** A generated item that passed its gate, plus where it came from. */
export interface Provenance {
  specId: string;
  specVersion: string;
  model: string;
  /** ISO date of the run that produced the pack. */
  generatedAt: string;
  /** Hash of the exact system prompt used — changes when the brief changes. */
  promptHash: string;
}

export type GateResult<T> = { ok: true; item: T } | { ok: false; reason: string };

export interface ContentSpec<T> {
  /** Stable identifier; also the pack directory name. */
  id: string;
  /** Bump when the brief or gate changes — recorded in every pack. */
  version: string;
  /** The sentinel tag the model wraps its payload in. */
  tag: string;
  /** Does the payload arrive as JSON, or as plain speakable text? */
  payload: "json" | "text";
  /** Teaches the job. The sentinel lesson is appended automatically. */
  brief: string;
  /** The shape the model should emit inside the block (shown in the prompt). */
  shape: string;
  /** One request's user message. `avoid` lists keys already in the packs. */
  user(ctx: { seed: number; avoid: string[] }): string;
  /** Judge a parsed payload. Rejections carry a reason and cost nothing. */
  gate(raw: unknown): GateResult<T>;
  /** Dedupe identity — normalized, compared across every existing pack. */
  key(item: T): string;
}

/**
 * The sentinel lesson, shared by every spec.
 *
 * This is the contract that fixed the voice pipeline: the model thinks for as
 * long as it likes, then closes a block to say DONE. We read the block and
 * nothing else. No tail-grabbing, no guessing which sentence was the answer.
 */
export function sentinelLesson(tag: string, shape: string, payload: "json" | "text"): string {
  const body = payload === "json"
    ? "Between the markers: ONE complete JSON object and nothing else. Strict " +
      "JSON — every key double-quoted, no comments, no trailing commas, no " +
      "markdown fences, no prose."
    : "Between the markers: only the finished text. No quotes, no label, no " +
      "alternatives, no notes.";
  return [
    "",
    "=== HOW TO ANSWER: SENTINEL BLOCKS ===",
    "Your reply is read by a machine that does NOT guess. It ignores everything",
    "you write except one clearly marked block, so think as long as you like,",
    "weigh options, change your mind — none of it leaks into the result.",
    "",
    "A sentinel block is an opening marker on its own line, the payload, then a",
    "closing marker on its own line:",
    "",
    `<<<${tag}>>>`,
    shape,
    "<<<END>>>",
    "",
    "Rules:",
    `1. Emit exactly ONE <<<${tag}>>> block, and emit it LAST — it is how you say DONE.`,
    `2. ${body}`,
    "3. Both markers sit alone on their own lines, spelled exactly as shown.",
    "4. Anything outside the block is discarded — deliberate freely above it.",
    "5. Write the block only when it is COMPLETE. Do not open the markers and",
    "   then think — an unclosed or half-written block is thrown away. Finish",
    "   deciding first, then write the whole thing at once.",
  ].join("\n");
}

/** The full system prompt for a spec: its brief, then the sentinel lesson. */
export function systemPrompt(spec: ContentSpec<unknown>): string {
  return `${spec.brief}\n${sentinelLesson(spec.tag, spec.shape, spec.payload)}`;
}
