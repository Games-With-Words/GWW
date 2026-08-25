/**
 * Mobile invariants. These are CSS rules whose absence is invisible in review
 * and painful on a phone, so they get asserted instead of remembered.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/style.css"), "utf8");
const ts = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");

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

/* ---- Fonts are ours ------------------------------------------------------
   This stack synthesizes its own score from oscillators specifically to avoid
   a CDN (see cinema.ts), and then rendered its own name through fonts.
   googleapis.com. Worse, the built artifact never requested the display face
   at all, so the live board fell back through a font nobody has to the UI
   font — the most theatrical element in the product was a lie in production.

   A remote font is not just a dependency, it is a board that renders wrong on
   a TV with slow DNS, in the ten seconds when everyone is looking at it. */
describe("fonts are vendored, not fetched", () => {
  const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
  const fontDir = join(import.meta.dirname, "../public/fonts");

  it("never requests a font from a third party", () => {
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
    // Any absolute stylesheet or font URL is suspect; local paths are relative.
    expect(html).not.toMatch(/<link[^>]+href="https?:\/\/[^"]*(font|css)/i);
  });

  it("declares both faces against local files", () => {
    const faces = css.match(/@font-face\s*\{[\s\S]*?\}/g) ?? [];
    expect(faces.length).toBeGreaterThanOrEqual(2);
    for (const f of faces) expect(f).toMatch(/url\("\/fonts\/[^"]+\.woff2"\)/);
  });

  it("ships the files it declares — a rename must not silently fall back", () => {
    const declared = [...css.matchAll(/url\("\/fonts\/([^"]+)"\)/g)].map((m) => m[1]!);
    expect(declared.length).toBeGreaterThan(0);
    for (const file of declared) {
      expect(existsSync(join(fontDir, file)), `missing ${file}`).toBe(true);
    }
  });

  it("ships the OFL license beside them, because the license requires it", () => {
    const licenses = readdirSync(fontDir).filter((f) => /^OFL.*\.txt$/.test(f));
    expect(licenses.length).toBeGreaterThanOrEqual(2);
    for (const l of licenses) {
      expect(readFileSync(join(fontDir, l), "utf8")).toContain("SIL Open Font License");
    }
  });

  it("preloads the display face — it is the first thing anyone sees", () => {
    expect(html).toMatch(/<link rel="preload"[^>]+\/fonts\/[^"]+\.woff2"[^>]*as="font"/);
  });
});
