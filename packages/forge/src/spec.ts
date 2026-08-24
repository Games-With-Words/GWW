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

export type GateResult<T> =
  | { ok: true; item: T }
  /** `missing` names absent required field blocks — a far better diagnosis
   *  than a generic parse error, and the reason field specs beat JSON. */
  | { ok: false; reason: string; missing?: string[] | undefined };

export interface ContentSpec<T> {
  /** Stable identifier; also the pack directory name. */
  id: string;
  /** Bump when the brief or gate changes — recorded in every pack. */
  version: string;
  /** The sentinel tag the model wraps its payload in. */
  tag: string;
  /**
   * How the payload arrives.
   * - "fields": one named block per field. Nothing to malform — no quotes, no
   *   braces, no commas, so there is no parse step that can fail.
   * - "text": a single block holding one piece of prose.
   */
  payload: "fields" | "text";
  /** Teaches the job. The sentinel lesson is appended automatically. */
  brief: string;
  /** For "fields": the field names, in the order the model should write them. */
  fields?: readonly string[];
  /** For "fields": which of them must be present. Missing ones are named back. */
  required?: readonly string[];
  /** A worked example of the whole payload, shown in the prompt. */
  shape: string;
  /** One request's user message. `avoid` lists keys already in the packs. */
  user(ctx: { seed: number; avoid: string[] }): string;
  /**
   * Judge the payload. For "fields" this receives Record<field, string> with
   * the raw block contents; for "text", the block string.
   */
  gate(raw: unknown): GateResult<T>;
  /** Dedupe identity — normalized, compared across every existing pack. */
  key(item: T): string;
  /**
   * Human-readable rendering for the CLI. The operator is reviewing content,
   * not counting rows — showing only the dedupe key hides the thing being
   * judged. Optional; falls back to the key.
   */
  preview?(item: T): string;
}

/**
 * The sentinel lesson, shared by every spec.
 *
 * This is the contract that fixed the voice pipeline: the model thinks for as
 * long as it likes, then closes a block to say DONE. We read the block and
 * nothing else. No tail-grabbing, no guessing which sentence was the answer.
 */
export function sentinelLesson(spec: {
  tag: string;
  shape: string;
  payload: "fields" | "text";
  fields?: readonly string[] | undefined;
}): string {
  const head = [
    "",
    "=== HOW TO ANSWER: SENTINEL BLOCKS ===",
    "Your reply is read by a machine that does NOT guess. It ignores everything",
    "you write except clearly marked blocks, so think as long as you like, weigh",
    "options, change your mind — none of it leaks into the result.",
    "",
  ];

  if (spec.payload === "text") {
    return [
      ...head,
      "A sentinel block is an opening marker on its own line, the payload, then a",
      "closing marker on its own line:",
      "",
      `<<<${spec.tag}>>>`,
      spec.shape,
      "<<<END>>>",
      "",
      "Rules:",
      `1. Emit exactly ONE <<<${spec.tag}>>> block, and emit it LAST — it is how you say DONE.`,
      "2. Between the markers: only the finished text. No quotes, no label, no",
      "   alternatives, no notes.",
      "3. Both markers sit alone on their own lines, spelled exactly as shown.",
      "4. Anything outside the block is discarded — deliberate freely above it.",
      "5. Write the block only when it is COMPLETE.",
    ].join("\n");
  }

  return [
    ...head,
    "Give each value its OWN named block. A block is an opening marker with the",
    "field name, the value, then a closing marker — each marker alone on its line:",
    "",
    `<<<${spec.tag} fieldname>>>`,
    "the value, exactly as it should be stored",
    "<<<END>>>",
    "",
    "There is no JSON here on purpose. No quotes to escape, no braces to balance,",
    "no commas to forget. Write the value plainly and it arrives intact.",
    "",
    "Emit these blocks, in this order:",
    ...(spec.fields ?? []).map((f) => `  <<<${spec.tag} ${f}>>>`),
    "",
    "Rules:",
    "1. One block per field. A field with several values gets ONE block with one",
    "   value PER LINE — do not comma-separate them.",
    "2. Between the markers: the bare value. No quotes, no field name repeated,",
    "   no explanation, no markdown.",
    "3. Both markers alone on their own lines, spelled exactly as shown.",
    "4. Anything outside the blocks is discarded — deliberate freely above them.",
    "5. Write all the blocks together at the END, once you have decided. If you",
    "   change your mind, write the whole set again; the last set wins.",
    "",
    "Worked example:",
    spec.shape,
  ].join("\n");
}

/**
 * The format reminder appended to EVERY user message.
 *
 * Learned live: gemma4:26b ignored a system-only lesson and replied in markdown
 * bullets ("*Secret:* Disco Ball"), writing several cards at once. muse honours
 * system instructions; other models weight the LAST turn far more heavily. So
 * the contract is restated where it cannot be missed.
 */
export function formatReminder(spec: {
  tag: string;
  payload: "fields" | "text";
  fields?: readonly string[] | undefined;
}): string {
  if (spec.payload === "text") {
    return [
      "",
      "---",
      `Reply with ONE <<<${spec.tag}>>> block and nothing else after it.`,
      "No markdown, no bullets, no headings, no labels.",
    ].join("\n");
  }
  return [
    "",
    "---",
    "REQUIRED OUTPUT FORMAT — reply with exactly these blocks, in this order,",
    "and NOTHING else after them. No markdown, no bullets, no headings, no",
    "asterisks, no numbered lists. Write ONE item only, not several.",
    "",
    ...(spec.fields ?? []).flatMap((f) => [`<<<${spec.tag} ${f}>>>`, `...`, "<<<END>>>"]),
  ].join("\n");
}

/** The full system prompt for a spec: its brief, then the sentinel lesson. */
export function systemPrompt(spec: ContentSpec<unknown>): string {
  return `${spec.brief}\n${sentinelLesson(spec)}`;
}
