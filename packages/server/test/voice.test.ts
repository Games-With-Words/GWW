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

function fakeFetch(line: string, audioBytes = 4096): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/chat/completions")) {
      return new Response(JSON.stringify({ choices: [{ message: { content: line } }] }), { status: 200 });
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

  it("dedupes identical lines instead of re-rendering them", async () => {
    const v = new VoiceService(cfg(), fakeFetch("Same exact opening line every single time folks!"));
    expect((await v.replenishOnce()).status).toBe("ok");
    expect((await v.replenishOnce()).status).toBe("duplicate");
    expect(v.generatedToday()).toBe(1);
  });

  it("enforces the daily budget — max N renders, then budget_exhausted", async () => {
    let i = 0;
    const lines = [
      "Fresh opening line number one for the lovely room!",
      "Fresh opening line number two, even better than one!",
      "Fresh opening line number three, the trilogy concludes!",
      "Fresh opening line number four should never be rendered!",
    ];
    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: lines[Math.min(i++, 3)] } }] }), { status: 200 });
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
    expect((await v1.replenishOnce()).status).toBe("line_rejected");
    expect(v1.generatedToday()).toBe(0);

    const f = (async (url: RequestInfo | URL) => {
      const u = String(url);
      if (u.includes("/chat/completions")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "A perfectly good line that will fail to render tonight!" } }] }), { status: 200 });
      }
      return new Response("no operators", { status: 503 });
    }) as typeof fetch;
    const v2 = new VoiceService(cfg(), f);
    expect((await v2.replenishOnce()).status).toBe("tts_failed_503");
    expect(v2.pickIntro().audioFile).toBeUndefined();
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
