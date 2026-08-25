/**
 * Mobile invariants. These are CSS rules whose absence is invisible in review
 * and painful on a phone, so they get asserted instead of remembered.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/style.css"), "utf8");
// Say Less's composer and inputs moved to src/games/say-less.ts in the
// multi-game split; the audio suites below still read main.ts, where Ris lives.
const ts = readFileSync(join(import.meta.dirname, "../src/games/say-less.ts"), "utf8");

describe("mobile invariants", () => {
  it("never lets an input fall below 16px — iOS zooms in on focus and never back out", () => {
    const rule = /input\[type="text"\][\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("max(16px");
    // No bare font-size under 16px anywhere in an input rule.
    expect(rule).not.toMatch(/font(-size)?:\s*(1[0-5]px|0?\.\d+rem)/);
  });

  it("pins the composer so a player never scrolls to find the input mid-round", () => {
    const rule = /\.composer\s*\{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("position: sticky");
    expect(rule).toContain("safe-area-inset-bottom");
  });

  it("applies the composer to both the clue and the guess forms", () => {
    expect(ts.match(/class="card stack composer"/g)).toHaveLength(2);
  });

  it("tells the phone keyboard what its action key does", () => {
    // Every text input the player types into should declare an intent.
    const inputs = ts.match(/<input[^>]*type="text"[^>]*>/g) ?? [];
    expect(inputs.length).toBeGreaterThan(0);
    for (const i of inputs) expect(i).toMatch(/enterkeyhint=/);
  });

  it("keeps touch targets thumb-sized and kills the double-tap delay", () => {
    const rule = /button, \.btn \{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("min-height: 48px");
    expect(rule).toContain("touch-action: manipulation");
  });

  it("un-pins the composer on the board — a TV has no keyboard", () => {
    expect(css).toContain("#app.board .composer { position: static");
  });

  it("declares a viewport that respects the notch", () => {
    const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
    expect(html).toContain("viewport-fit=cover");
    expect(html).toContain("width=device-width");
  });
});

// ---- Ris's voice: the silent failure that cost us a live game -------------
describe("audio playback never fails silently", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");

  it("does NOT swallow a blocked play()", () => {
    // The original was `.play().catch(() => undefined)` — cached WAVs, a
    // working API, no sound, and nothing anywhere saying why.
    expect(src).not.toContain("play().catch(() => undefined)");
    expect(src).toMatch(/console\.warn\(`\[ris\] playback blocked/);
  });

  it("primes ONE audio element on a real user gesture", () => {
    // A fresh `new Audio()` per line is subject to autoplay policy every time.
    expect(src).toContain("const risAudio = new Audio()");
    expect(src).toContain('addEventListener("pointerdown", unlockAudio');
    expect(src).toContain('addEventListener("keydown", unlockAudio');
  });

  it("tells the room when the browser is refusing, instead of just being quiet", () => {
    expect(src).toContain("Ris can't speak");
    expect(src).toMatch(/function audioNotice/);
  });
});

// ---- Ris's voice: the silent failure that killed a live game -------------
describe("audio never fails silently", () => {
  const src = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");

  it("does NOT swallow a blocked play()", () => {
    // Was `.play().catch(() => undefined)`: cached WAVs, healthy API, no sound,
    // and nothing anywhere saying why.
    expect(src).not.toContain("play().catch(() => undefined)");
    expect(src).toMatch(/console\.warn\(`\[ris\] playback blocked/);
  });

  it("primes ONE element with a REAL sound — an empty src throws, it does not unlock", () => {
    expect(src).toContain("const risAudio = new Audio()");
    expect(src).toContain("SILENT_WAV");
    expect(src).toContain("risAudio.src = SILENT_WAV");
  });

  it("gives the board its own start button, because nothing else ever taps it", () => {
    // The board is built to be untouched, so it never earns audio permission.
    // A scripted click cannot substitute: browsers require a trusted event.
    expect(src).toContain("Tap to start the show");
    expect(src).toMatch(/unlockAudio\(\);[\s\S]{0,120}socket\?\.send\(\{ type: "game\.start" \}\)/);
  });

  it("says so on screen when the browser is still refusing", () => {
    expect(src).toContain("Ris can't speak");
  });
});
