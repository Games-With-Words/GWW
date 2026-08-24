/**
 * Mobile invariants. These are CSS rules whose absence is invisible in review
 * and painful on a phone, so they get asserted instead of remembered.
 */
import { readFileSync } from "node:fs";
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
