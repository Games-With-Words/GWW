/**
 * The SSE reader, tested against fabricated streams — no network, no model.
 *
 * The behaviour that matters is the hang-up: muse spends thousands of characters
 * of scratchpad after she has already closed the block, and the whole point of
 * streaming is to stop reading there. A test that only checked the assembled text
 * would pass whether or not we ever hung up, so the assertions below check what
 * was NOT read.
 */

import { describe, expect, it, vi } from "vitest";
import { readSseCompletion } from "../src/voice.js";

/** Build a stream from frames, recording how many were actually pulled. */
function sse(frames: string[]): { stream: ReadableStream<Uint8Array>; pulled: () => number } {
  let pulled = 0;
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= frames.length) { controller.close(); return; }
      pulled += 1;
      controller.enqueue(encoder.encode(frames[i]!));
      i += 1;
    },
  });
  return { stream, pulled: () => pulled };
}

const delta = (o: Record<string, unknown>): string =>
  `data: ${JSON.stringify({ choices: [{ delta: o }] })}\n\n`;

describe("readSseCompletion", () => {
  it("assembles content across frames", async () => {
    const { stream } = sse([
      delta({ content: "Phones up, " }),
      delta({ content: "chaos out." }),
      "data: [DONE]\n\n",
    ]);
    const out = await readSseCompletion(stream);
    expect(out.content).toBe("Phones up, chaos out.");
    expect(out.stoppedEarly).toBe(false);
    expect(out.events).toBe(3);
  });

  it("keeps the thinking channel separate from the answer", async () => {
    const { stream } = sse([
      delta({ thinking: "weighing two angles" }),
      delta({ reasoning_content: " and a third" }),
      delta({ content: "the line itself" }),
    ]);
    const out = await readSseCompletion(stream);
    expect(out.thinking).toBe("weighing two angles and a third");
    expect(out.content).toBe("the line itself");
  });

  it("HANGS UP at the closing sentinel and never reads the scratchpad after it", async () => {
    const onEnd = vi.fn();
    const { stream, pulled } = sse([
      delta({ content: "Let me try a few angles.\n" }),
      delta({ content: "<<<LINE>>>\nRoom wins, now name that invisible prompt\n<<<END>>>" }),
      // Everything below is what muse says AFTER she is done. We must not pay
      // for any of it — in live logs this was 3,400 characters.
      delta({ content: "\nActually wait, let me reconsider the whole thing" }),
      delta({ content: " ...and here is another 3000 characters of deliberation" }),
      "data: [DONE]\n\n",
    ]);
    const out = await readSseCompletion(stream, onEnd);

    expect(out.stoppedEarly).toBe(true);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(out.content).toContain("<<<END>>>");
    expect(out.content).not.toContain("reconsider");
    // Two frames pulled, three left on the floor.
    expect(pulled()).toBe(2);
  });

  it("hangs up when the block closes inside the thinking channel", async () => {
    const { stream } = sse([
      delta({ thinking: "<<<LINE>>>\nTime's up and the word walks free\n<<<END>>>" }),
      delta({ thinking: " more deliberation nobody needs" }),
    ]);
    const out = await readSseCompletion(stream);
    expect(out.stoppedEarly).toBe(true);
    expect(out.thinking).not.toContain("nobody needs");
  });

  it("survives frames split mid-JSON across chunk boundaries", async () => {
    // A real socket does not respect frame edges.
    const whole = delta({ content: "a clean line arrives anyway" });
    const cut = Math.floor(whole.length / 2);
    const { stream } = sse([whole.slice(0, cut), whole.slice(cut)]);
    const out = await readSseCompletion(stream);
    expect(out.content).toBe("a clean line arrives anyway");
  });

  it("ignores keep-alives, comments and unparsable data", async () => {
    const { stream } = sse([
      ": ping\n\n",
      "data: not json at all\n\n",
      delta({ content: "still fine" }),
    ]);
    const out = await readSseCompletion(stream);
    expect(out.content).toBe("still fine");
  });

  it("reports a truncating finish_reason so the caller can refuse the fragment", async () => {
    const { stream } = sse([
      delta({ content: "half a thought that never" }),
      `data: ${JSON.stringify({ choices: [{ finish_reason: "length", delta: {} }] })}\n\n`,
    ]);
    const out = await readSseCompletion(stream);
    expect(out.finishReason).toBe("length");
    expect(out.stoppedEarly).toBe(false);
  });

  it("reports zero events when the endpoint did not really stream", async () => {
    // The signal the caller uses to fall back to plain JSON parsing.
    const { stream } = sse([]);
    const out = await readSseCompletion(stream);
    expect(out.events).toBe(0);
    expect(out.content).toBe("");
  });
});

/**
 * THE BLOG BUG. Found live, 2026-08-25.
 *
 * Every blog tick reported "missing SLUG, DESCRIPTION, KEYWORDS, BODY" with
 * about 67 characters of content — and TITLE was conspicuously NOT missing,
 * because 67 characters is the length of a title block. The reader saw the
 * `<<<END>>>` that closes TITLE, concluded the model was done, and hung up on
 * a post that had four blocks still to write.
 *
 * The blog even carried a comment saying "no early hang-up here". The hang-up
 * was believed to live in the voice caller; it lived in the shared reader that
 * both of them import. A default that is correct for a one-block payload is
 * silently destructive for any other, so the stop condition now belongs to the
 * caller that knows the shape.
 */
describe("multi-block payloads", () => {
  const blocks = (...tags: string[]): string[] =>
    tags.map((t) => delta({ content: `<<<${t}>>>\n${t.toLowerCase()} value\n<<<END>>>\n` }));

  const allFive = (c: string): boolean =>
    ["TITLE", "SLUG", "DESCRIPTION", "KEYWORDS", "BODY"].every((t) => {
      const open = c.indexOf(`<<<${t}>>>`);
      return open !== -1 && c.indexOf("<<<END>>>", open) !== -1;
    });

  it("REPRODUCES the bug: the default stops after the first block", async () => {
    const { stream } = sse([...blocks("TITLE", "SLUG", "DESCRIPTION", "KEYWORDS", "BODY"), "data: [DONE]\n\n"]);
    const out = await readSseCompletion(stream);
    expect(out.stoppedEarly).toBe(true);
    expect(out.content).toContain("<<<TITLE>>>");
    // Exactly the live symptom: four blocks never arrive.
    expect(out.content).not.toContain("<<<BODY>>>");
    expect(allFive(out.content)).toBe(false);
  });

  it("reads all five when the CALLER says what done means", async () => {
    const { stream } = sse([...blocks("TITLE", "SLUG", "DESCRIPTION", "KEYWORDS", "BODY"), "data: [DONE]\n\n"]);
    const out = await readSseCompletion(stream, { isDone: (c) => allFive(c) });
    for (const t of ["TITLE", "SLUG", "DESCRIPTION", "KEYWORDS", "BODY"]) {
      expect(out.content, `missing ${t}`).toContain(`<<<${t}>>>`);
    }
    expect(allFive(out.content)).toBe(true);
  });

  it("still hangs up once the LAST block closes — the saving is kept", async () => {
    // The reason streaming exists here: muse keeps deliberating after she is
    // done, and we should not pay to read it.
    const { stream, pulled } = sse([
      ...blocks("TITLE", "SLUG", "DESCRIPTION", "KEYWORDS", "BODY"),
      delta({ content: "...and now several thousand characters of scratchpad." }),
      delta({ content: "still going." }),
      "data: [DONE]\n\n",
    ]);
    const onEnd = vi.fn();
    const out = await readSseCompletion(stream, { isDone: (c) => allFive(c), onEnd });
    expect(out.stoppedEarly).toBe(true);
    expect(onEnd).toHaveBeenCalledOnce();
    expect(out.content).not.toContain("scratchpad");
    expect(pulled()).toBe(5);
  });

  it("keeps the one-block default intact for the voice line", async () => {
    // Voice wants exactly this behaviour, and it must not regress.
    const { stream, pulled } = sse([
      delta({ content: "<<<LINE>>>\nPhones up.\n<<<END>>>" }),
      delta({ content: " deliberation nobody reads" }),
      "data: [DONE]\n\n",
    ]);
    const out = await readSseCompletion(stream);
    expect(out.stoppedEarly).toBe(true);
    expect(out.content).not.toContain("deliberation");
    expect(pulled()).toBe(1);
  });

  it("accepts a bare callback, the way voice.ts already calls it", async () => {
    const onEnd = vi.fn();
    const { stream } = sse([delta({ content: "<<<LINE>>>\nx\n<<<END>>>" }), "data: [DONE]\n\n"]);
    await readSseCompletion(stream, onEnd);
    expect(onEnd).toHaveBeenCalledOnce();
  });
});
