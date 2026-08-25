/**
 * WCAG contrast, COMPUTED from the stylesheet.
 *
 * This game is played by mixed ages in bad lighting, at real distance from a
 * television. Contrast is a functional requirement here, not a preference, and
 * "looks fine on my laptop" is how it silently stops being true.
 *
 * The palette shipped three genuine failures: white on the pink fill was 3.35,
 * and the brand red reads 4.11 as text — both below AA. They were invisible in
 * review because nobody multiplies luminances by hand. So the ratios are parsed
 * out of :root and recomputed on every run.
 *
 * AA: 4.5 for normal text, 3.0 for large (>=18.66px bold or >=24px).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/style.css"), "utf8");

/** Pull the real values out of :root so the test can never drift from them. */
function tokens(): Record<string, string> {
  const root = /:root\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
  const out: Record<string, string> = {};
  for (const m of root.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
    out[m[1]!] = m[2]!;
  }
  return out;
}

const T = tokens();

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "").slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
}

function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const t = (name: string): string => {
  const v = T[name];
  if (v === undefined) throw new Error(`:root is missing --${name}`);
  return v;
};

describe("the palette parses", () => {
  it("finds every token the UI depends on", () => {
    for (const name of ["bg", "card", "stage-lift", "ink", "dim", "accent", "hot", "go", "onfill", "line"]) {
      expect(T[name], `--${name}`).toMatch(/^#[0-9a-fA-F]{6,8}$/);
    }
  });
});

describe("normal-size text clears AA (4.5) on every ground it sits on", () => {
  // Anything that can render at body size or smaller. --dim is the one that
  // matters most: it was a lavender grey on violet, used at 0.75rem, inside a
  // vignette. Metadata nobody could read is metadata that isn't there.
  const grounds = [["bg", t("bg")], ["card", t("card")], ["riser", t("stage-lift")]] as const;
  const inks = [["ink", t("ink")], ["dim", t("dim")], ["hot", t("hot")], ["go", t("go")]] as const;

  for (const [gName, ground] of grounds) {
    for (const [iName, ink] of inks) {
      it(`${iName} on ${gName}`, () => {
        expect(ratio(ink, ground), `${ink} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("text ON a saturated fill", () => {
  it("white on the red fill clears AA", () => {
    // 4.79. The reason the red is a FILL and never body copy.
    expect(ratio(t("onfill"), t("accent"))).toBeGreaterThanOrEqual(4.5);
  });

  it("dark ink on the green clears AA", () => {
    expect(ratio("#0b0b0b", t("go"))).toBeGreaterThanOrEqual(4.5);
  });

  it("documents WHY the brand red is never used as text", () => {
    // This is the failure the palette is built around. If someone "fixes" this
    // by brightening --accent, the fill/white pairing has to be rechecked —
    // hence asserting the fact rather than hiding it.
    expect(ratio(t("accent"), t("bg"))).toBeLessThan(4.5);
    // ...and --hot exists precisely to cover that case.
    expect(ratio(t("hot"), t("bg"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("the stylesheet obeys its own rule", () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");

  it("never sets the brand red as a text colour", () => {
    // --accent is a fill. --hot is the type-safe red. Mixing them up is the
    // exact regression this whole palette exists to prevent.
    expect(code).not.toMatch(/color:\s*var\(--accent\)/);
  });

  it("never puts white text on the red as a hardcoded literal", () => {
    // Fills must go through --onfill so the pairing stays checkable.
    const reds = [...code.matchAll(/background:\s*var\(--(accent|pop)\)[^;}]*;[^}]*?color:\s*(#[0-9a-f]{3,6})/gi)];
    for (const m of reds) {
      expect(["#fff", "#ffffff"], `hardcoded ${m[2]} on a red fill`).not.toContain(m[2]!.toLowerCase());
    }
  });

  it("has no violet left in it — that was the stock-palette tell", () => {
    // The old ramp: #0b0b13, #1a1a2b, #2c2c46, #9a95c9, #15152233, #22224039.
    //
    // This check was WRONG first time and passed a deliberate regression: it
    // also required `b < 120`, so it caught the dark violets and sailed past
    // #9a95c9, the lavender that was doing the most damage (it was the colour
    // of every piece of secondary copy). Blue dominance is the signal; how dark
    // the colour happens to be is not part of it.
    const violets = [...code.matchAll(/#([0-9a-f]{6})\b/gi)].map((m) => m[1]!.toLowerCase())
      .filter((h) => {
        const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
        return b! > r! + 16 && b! > g! + 16;
      });
    expect(violets).toEqual([]);
  });
});
