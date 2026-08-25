import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { L0_INTRO_LINES, validateLine, VoiceService, type VoiceConfig } from "../src/voice.js";

function cfg(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    aiasUrl: "https://aiassist.test",
    apiKey: "aai_test",
    lineModel: "muse-local:latest",
    ttsModel: "chatterbox-turbo",
    voice: "default",
    cacheDir: mkdtempSync(join(tmpdir(), "gww-voice-")),
    dailyMax: 3,
    ...overrides,
  };
}

/** muse answers the way the system prompt teaches her: thinking, then a block. */
function museSays(line: string): string {
  return `Weighing a couple of angles here before I commit.\n<<<LINE>>>\n${line}\n<<<END>>>`;
}

function fakeFetch(line: string, audioBytes = 4096): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: museSays(line) } }] }), { status: 200 });
    }
    if (u.includes("/audio/speech")) {
      return new Response(new Uint8Array(audioBytes).fill(1), { status: 200, headers: { "content-type": "audio/wav" } });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
}

describe("validateLine — the deterministic gate before a render is spent", () => {
  it("accepts a normal line and strips wrapping quotes", () => {
    expect(validateLine('"Welcome to the room, you beautiful disasters!"')).toBe(
      "Welcome to the room, you beautiful disasters!",
    );
  });
  it("rejects too short, too long, and junk", () => {
    expect(validateLine("Hi there")).toBeUndefined();
    expect(validateLine("word ".repeat(40))).toBeUndefined();
    expect(validateLine("check out https://spam.example now folks")).toBeUndefined();
    expect(validateLine("{json: true} says the model sometimes ok")).toBeUndefined();
    expect(validateLine("12 34 56 78")).toBeUndefined();
  });
  it("takes the LAST line of a rambling answer — local models narrate, then answer", () => {
    expect(validateLine("Sure! Here is a fun opening line:\nWelcome to game night my friends!")).toBe(
      "Welcome to game night my friends!",
    );
  });

  it("accepts a complete thought without a period and finishes it", () => {
    expect(validateLine("Speaker's clue just landed, so drop the dramatic pause and start guessing fast")).toBe(
      "Speaker's clue just landed, so drop the dramatic pause and start guessing fast.",
    );
  });

  it("no longer second-guesses a finished thought by its last word", () => {
    /**
     * DELIBERATE REVERSAL (Mark, 2026-08-25: "<<<END>>> is the contract").
     *
     * This test used to assert the opposite — that a line ending on a function
     * word was rejected as a cut-off fragment. That heuristic killed a real line
     * in live play: "...at a prompt you never saw bring it on" is a complete
     * sentence, and "on" was in the banned list.
     *
     * Only text from a CLOSED sentinel block reaches this gate, and a truncated
     * completion is refused earlier by the finish_reason check — so completion is
     * proven structurally and guessing at it from grammar can only be wrong.
     * The cost of the reversal, stated honestly: a genuinely trailing line inside
     * a properly closed block now gets voiced. The model declared it done.
     */
    expect(validateLine("...at a prompt you never saw bring it on")).toBe(
      "...at a prompt you never saw bring it on.",
    );
    expect(validateLine("Okay the speaker just got their secret word so everyone else")).toBe(
      "Okay the speaker just got their secret word so everyone else.",
    );
  });

  it("still refuses lines that are unspeakable rather than unfinished", () => {
    // What the gate is actually for, now that it stopped judging grammar.
    expect(validateLine("too short")).toBeUndefined();
    expect(validateLine("word ".repeat(40))).toBeUndefined();
    expect(validateLine("go to https://example.com now everyone")).toBeUndefined();
    expect(validateLine("1 2 3 4 5")).toBeUndefined();
  });

  it("names the rule that refused a line", async () => {
    const { checkLine } = await import("../src/voice.js");
    expect(checkLine("too short")).toMatchObject({ ok: false, reason: "TOO_SHORT" });
    expect(checkLine("word ".repeat(40))).toMatchObject({ ok: false, reason: "TOO_LONG" });
    expect(checkLine("{json: true} came back again ok")).toMatchObject({ ok: false, reason: "MARKUP" });
    expect(checkLine("1 2 3 4 5")).toMatchObject({ ok: false, reason: "NO_LETTERS" });
    expect(checkLine("A perfectly good hosting line for tonight")).toMatchObject({ ok: true });
  });

  it("strips think-blocks before judging the line", () => {
    expect(validateLine("<think>the user wants a party line, keep it short</think>Phones up, chaos out — welcome to Say Less!")).toBe(
      "Phones up, chaos out — welcome to Say Less!",
    );
  });
});

describe("VoiceService", () => {
  it("falls back to L0 captions when nothing is cached — the party never waits", () => {
    const v = new VoiceService(cfg(), fakeFetch("unused"));
    const intro = v.pickIntro();
    expect(L0_INTRO_LINES).toContain(intro.text);
    expect(intro.audioFile).toBeUndefined();
  });

  it("is disabled without an API key and says so", async () => {
    const v = new VoiceService(cfg({ apiKey: undefined }), fakeFetch("unused"));
    expect(v.enabled).toBe(false);
    expect((await v.replenishOnce()).status).toBe("disabled");
  });

  it("replenishes: muse line -> chatterbox wav -> cached and pickable", async () => {
    const v = new VoiceService(cfg(), fakeFetch("Welcome to the room, let the chaos commence tonight!"));
    const r = await v.replenishOnce();
    expect(r.status).toBe("ok");
    const intro = v.pickIntro();
    expect(intro.text).toBe("Welcome to the room, let the chaos commence tonight!");
    expect(intro.audioFile).toMatch(/^[a-f0-9]{16}\.wav$/);
    expect(v.audioPath(intro.audioFile!)).toBeDefined();
  });

  it("reads a STREAMING muse and hangs up on the closing sentinel", async () => {
    /**
     * The streaming path end to end: muse deliberates, closes the block, then
     * keeps talking. We must take the line and stop reading — and crucially the
     * scratchpad tail must never reach the TTS call.
     */
    const encoder = new TextEncoder();
    const frame = (o: Record<string, unknown>): string =>
      `data: ${JSON.stringify({ choices: [{ delta: o }] })}\n\n`;
    const frames = [
      frame({ thinking: "weighing a couple of angles here" }),
      frame({ content: "<<<LINE>>>\nRoom wins the moment now name that invisible prompt\n<<<END>>>" }),
      frame({ content: "\nHmm actually let me reconsider everything I just said" }),
    ];
    let ttsInput: string | undefined;
    const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("chat/completions")) {
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(c) {
            if (i >= frames.length) { c.close(); return; }
            c.enqueue(encoder.encode(frames[i]!));
            i += 1;
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      ttsInput = JSON.parse(String(init?.body)).input;
      return new Response(new Uint8Array(400), { status: 200 });
    };
    const v = new VoiceService(cfg(), fetcher as unknown as typeof fetch);
    const r = await v.replenishOnce();
    expect(r.status).toBe("ok");
    expect(ttsInput).toBe("Room wins the moment now name that invisible prompt.");
    expect(ttsInput).not.toContain("reconsider");
  });

  it("still handles a server that ignores stream:true and sends one JSON body", async () => {
    // The fallback every other test in this file exercises implicitly.
    const v = new VoiceService(cfg(), fakeFetch("A perfectly ordinary non streamed hosting line."));
    expect((await v.replenishOnce()).status).toBe("ok");
  });

  it("dedupes identical lines instead of re-rendering them", async () => {
    const v = new VoiceService(cfg(), fakeFetch("Same exact welcome greeting every single time folks!"));
    expect((await v.replenishOnce()).status).toBe("ok");
    expect((await v.replenishOnce()).status).toBe("duplicate");
    expect(v.generatedToday()).toBe(1);
  });

  it("enforces the daily budget — max N renders, then budget_exhausted", async () => {
    let i = 0;
    const lines = [
      "Fresh welcome number one for the lovely room tonight!",
      "Fresh welcome number two, even better than the first!",
      "Fresh welcome number three, the trilogy concludes tonight!",
      "Fresh welcome number four should never be rendered tonight!",
    ];
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: museSays(lines[Math.min(i++, 3)]!) } }] }), { status: 200 });
      }
      return new Response(new Uint8Array(4096).fill(1), { status: 200 });
    }) as typeof fetch;

    const v = new VoiceService(cfg({ dailyMax: 3 }), f);
    expect((await v.replenishOnce()).status).toBe("ok");
    expect((await v.replenishOnce()).status).toBe("ok");
    expect((await v.replenishOnce()).status).toBe("ok");
    expect((await v.replenishOnce()).status).toBe("budget_exhausted");
    expect(v.generatedToday()).toBe(3);
  });

  it("a rejected line costs no render; a failed TTS caches nothing", async () => {
    const v1 = new VoiceService(cfg(), fakeFetch("hm"));
    // Was "line_rejected" for every failure; the status now names the rule so a
    // log line distinguishes "muse misbehaved" from "our gate did".
    expect((await v1.replenishOnce()).status).toBe("line_rejected_too_short");
    expect(v1.generatedToday()).toBe(0);

    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: museSays("A perfectly good line that will fail to render tonight!") } }] }), { status: 200 });
      }
      return new Response("no operators", { status: 503 });
    }) as typeof fetch;
    const v2 = new VoiceService(cfg(), f);
    expect((await v2.replenishOnce()).status).toBe("tts_failed_503");
    expect(v2.pickIntro().audioFile).toBeUndefined();
  });

  it("refuses an answer muse never wrapped — no block, no render", async () => {
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "A fine sounding line with no sentinel block at all." } }] }), { status: 200 });
      }
      return new Response(new Uint8Array(4096).fill(1), { status: 200 });
    }) as typeof fetch;
    const v = new VoiceService(cfg(), f);
    // No block at all is a DIFFERENT failure from a block we refused.
    expect((await v.replenishOnce()).status).toBe("line_no_block");
    expect(v.generatedToday()).toBe(0);
  });

  it("refuses a truncated completion outright — a cut stream never closed its block", async () => {
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "<<<LINE>>>\nHalf a thought that got cut off mid" } }] }), { status: 200 });
      }
      return new Response(new Uint8Array(4096).fill(1), { status: 200 });
    }) as typeof fetch;
    const v = new VoiceService(cfg(), f);
    expect((await v.replenishOnce()).status).toBe("line_truncated");
    expect(v.generatedToday()).toBe(0);
  });

  it("reads the block out of the thinking channel when content is empty", async () => {
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "", thinking: museSays("Ris found her voice inside the reasoning stream tonight!") } }] }), { status: 200 });
      }
      return new Response(new Uint8Array(4096).fill(1), { status: 200 });
    }) as typeof fetch;
    const v = new VoiceService(cfg(), f);
    const r = await v.replenishOnce();
    expect(r.status).toBe("ok");
    expect(r.text).toBe("Ris found her voice inside the reasoning stream tonight!");
  });

  it("quarantines lines the retired parser wrote — kept on disk, never spoken", async () => {
    const { writeFileSync } = await import("node:fs");
    const c = cfg();
    // A bank as it exists tonight: junk mined from muse's scratchpad (untagged)
    // beside a line extracted from a real sentinel block.
    writeFileSync(join(c.cacheDir, "lines.json"), JSON.stringify({
      entries: [
        { hash: "a".repeat(16), text: "Which to choose? Let's randomize with seed. Seed 178753538", file: `${"a".repeat(16)}.wav`, createdAt: Date.now(), source: "muse", cue: "intro" },
        { hash: "b".repeat(16), text: "I'll produce one line.", file: `${"b".repeat(16)}.wav`, createdAt: Date.now(), source: "muse", cue: "clue" },
        { hash: "c".repeat(16), text: "A trustworthy line that came from a sentinel block.", file: `${"c".repeat(16)}.wav`, createdAt: Date.now(), source: "muse", cue: "outro", parser: "sentinel" },
      ],
    }));
    writeFileSync(join(c.cacheDir, `${"c".repeat(16)}.wav`), new Uint8Array(4096).fill(1));

    const v = new VoiceService(c, fakeFetch("unused"));
    // The scratchpad lines can never be spoken again.
    expect(L0_INTRO_LINES).toContain(v.pickIntro().text);
    expect(v.pickLine("clue").audioFile).toBeUndefined();
    // The trustworthy one survives, audio and all.
    expect(v.pickLine("outro").text).toBe("A trustworthy line that came from a sentinel block.");
    expect(v.pickLine("outro").audioFile).toBeDefined();
    // Budget isn't held hostage by renders that produced nothing speakable.
    expect(v.generatedToday()).toBe(1);
    // NOTHING was deleted — the manifest on disk is byte-for-byte untouched.
    const { readFileSync } = await import("node:fs");
    const onDisk = JSON.parse(readFileSync(join(c.cacheDir, "lines.json"), "utf8")) as { entries: unknown[] };
    expect(onDisk.entries).toHaveLength(3);
  });

  it("audioPath refuses anything but content-addressed names", () => {
    const v = new VoiceService(cfg(), fakeFetch("unused"));
    expect(v.audioPath("../../etc/passwd")).toBeUndefined();
    expect(v.audioPath("lines.json")).toBeUndefined();
  });
});

// ---- Ris's cue bank: every hosting moment has a floor and a cache lane ----
import { CUES, L0_CUE_LINES } from "../src/voice.js";
import { describe as cdesc, expect as cexp, it as cit } from "vitest";

cdesc("cue bank", () => {
  cit("every cue has hand-written L0 lines — captions can never go silent", () => {
    for (const cue of CUES) cexp(L0_CUE_LINES[cue].length).toBeGreaterThan(2);
  });

  cit("pickLine falls back to L0 text for an empty cache, per cue", () => {
    const v = new VoiceService({ ...cfg(), apiKey: undefined });
    for (const cue of CUES) {
      const line = v.pickLine(cue);
      cexp(L0_CUE_LINES[cue]).toContain(line.text);
      cexp(line.audioFile).toBeUndefined();
    }
  });

  cit("replenish fills the thinnest cue and tags the entry", async () => {
    const fetcher = fakeFetch("A perfectly fresh hosting line for the moment.");
    const v = new VoiceService(cfg(), fetcher as unknown as typeof fetch);
    const r = await v.replenishOnce();
    cexp(r.status).toBe("ok");
    cexp(CUES).toContain(r.cue!);
    const line = v.pickLine(r.cue!);
    cexp(line.audioFile).toBeDefined();
  });
});

// ---- sentinel blocks: the model declares DONE, we never guess ----
import { lineFromCompletion, LINE_TAG } from "../src/voice.js";
import { describe as tdesc, expect as texp, it as tit } from "vitest";

const block = (line: string) => `<<<${LINE_TAG}>>>\n${line}\n<<<END>>>`;

tdesc("lineFromCompletion (sentinel blocks)", () => {
  tit("takes the block out of the answer channel", () => {
    texp(lineFromCompletion(block("Welcome to game night, where friendship goes to be tested!")))
      .toBe("Welcome to game night, where friendship goes to be tested!");
  });

  tit("ignores every word of deliberation around the block", () => {
    const content =
      "Let me weigh a few angles. Option A is about the clock, option B roasts the silence.\n" +
      "I'll produce one line. Which to choose? Let's randomize with seed 178753538.\n" +
      block("Time's up and the word walks free, smug as ever.") +
      "\nThat should land well.";
    texp(lineFromCompletion(content)).toBe("Time's up and the word walks free, smug as ever.");
  });

  tit("finds the block in the thinking channel when content is empty", () => {
    const thinking =
      "Write tonight's line. Random seed: 178753.\nWe need EXACTLY ONE fresh line.\n" +
      block("Phones up, the clue just landed and the clock is unimpressed.");
    texp(lineFromCompletion("", thinking))
      .toBe("Phones up, the clue just landed and the clock is unimpressed.");
  });

  tit("prefers the answer channel over the thinking channel", () => {
    texp(lineFromCompletion(block("The real answer wins every single time here."), block("The scratchpad answer loses.")))
      .toBe("The real answer wins every single time here.");
  });

  tit("returns nothing when no block was ever closed — no garbage renders", () => {
    texp(lineFromCompletion(
      "Write tonight's opening line. Random seed: 178753.\nWhich to choose? Let's randomize with seed. Seed 178753538",
    )).toBeUndefined();
    texp(lineFromCompletion("We need a line here.\nI'll produce one line.")).toBeUndefined();
    // The live regression: reasoning text reached the WAV because the parser
    // mined a thinking blob. With sentinels, an unclosed block yields nothing.
    texp(lineFromCompletion("", "I'll produce one line.")).toBeUndefined();
  });

  tit("still gates the block contents — muse can't smuggle junk through", () => {
    texp(lineFromCompletion(block("too short"))).toBeUndefined();
    texp(lineFromCompletion(block("Go read https://example.com for the rules of tonight."))).toBeUndefined();
  });

  tit("finishes a complete thought that forgot its period", () => {
    texp(lineFromCompletion(block("Speaker's clue just landed, so drop the pause and start guessing fast")))
      .toBe("Speaker's clue just landed, so drop the pause and start guessing fast.");
  });
});
