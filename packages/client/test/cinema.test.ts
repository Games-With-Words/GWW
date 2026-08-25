/**
 * The Theater Cut had NO tests, and that is how three defects lived in it:
 * a reduced-motion path that truncated the reveal to 0.8s, a credits roll that
 * rendered clipped and unreadable with motion off, and a reveal that dropped
 * the one piece of data the whole room had just voted on.
 *
 * The DOM lives behind an overlay() that appends to <body>, so what is asserted
 * here is the contract: the pure crown logic, and the source/CSS invariants
 * that are invisible in review and only fail in someone's living room.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { crownHtml, doubleWinner, fitBigType, scenes, type Crown } from "../src/cinema.js";

const src = readFileSync(join(import.meta.dirname, "../src/cinema.ts"), "utf8");

/**
 * The source with comments removed.
 *
 * A grep cannot tell code from prose ABOUT code — the comment explaining the
 * old `Math.min` truncation matched the assertion looking for it, so the test
 * failed on its own documentation. Assert against the code.
 */
const code = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const css = readFileSync(join(import.meta.dirname, "../src/style.css"), "utf8");
const main = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");

/**
 * ALL the reduced-motion blocks, joined.
 *
 * There is more than one in the stylesheet, so matching only the first is how
 * a test like this passes while asserting nothing about the rules that matter.
 */
const reducedMotionCss = (): string =>
  (css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? []).join("\n");

/** Resolve a var() or literal against :root, then measure the pair. */
function crownContrast(rule: string): number {
  const root = /:root\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
  const token = (n: string): string =>
    new RegExp(`--${n}:\\s*(#[0-9a-fA-F]{3,8})`).exec(root)?.[1] ?? "#000000";
  const resolve = (v: string): string =>
    v.startsWith("var(") ? token(v.slice(6, -1)) : v;
  const fill = resolve(/background:\s*(var\([^)]+\)|#[0-9a-fA-F]{3,6})/.exec(rule)?.[1] ?? "#000");
  const ink = resolve(/color:\s*(var\([^)]+\)|#[0-9a-fA-F]{3,6})/.exec(rule)?.[1] ?? "#fff");
  const lum = (hex: string): number => {
    const h = hex.replace("#", "").slice(0, 6);
    const ch = (c: number): number => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * ch(r!) + 0.7152 * ch(g!) + 0.0722 * ch(b!);
  };
  const [a, b] = [lum(fill), lum(ink)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

const crown = (over: Partial<Crown> = {}): Crown => ({
  category: "FUNNIEST",
  text: "a haunted lute",
  who: "Dana",
  votes: 3,
  ...over,
});

describe("the crown — what the room voted for, on the television", () => {
  it("makes the GUESS the headline, not the award name", () => {
    // The guess is why anyone stands up. A person in the room wrote it.
    const html = crownHtml(crown());
    expect(html).toContain("a haunted lute");
    expect(html).toMatch(/cine-crown-text[^>]*>\s*a haunted lute/);
  });

  it("names the author and the vote count", () => {
    expect(crownHtml(crown({ votes: 4 }))).toContain("Dana · 4 votes");
    expect(crownHtml(crown({ votes: 1 }))).toContain("1 vote");
  });

  it("escapes a guess — players type the content of this screen", () => {
    const html = crownHtml(crown({ text: '<img src=x onerror="alert(1)">' }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&#60;img");
  });

  it("sends the two awards to OPPOSITE sides", () => {
    expect(crownHtml(crown({ category: "FUNNIEST" }))).toContain("cine-crown funny");
    expect(crownHtml(crown({ category: "CLOSEST" }))).toContain("cine-crown close");
  });
});

describe("taking both awards", () => {
  it("is called out when ONE person swept it", () => {
    expect(doubleWinner([
      crown({ category: "FUNNIEST", who: "Dana" }),
      crown({ category: "CLOSEST", who: "Dana" }),
    ])).toBe("Dana");
  });

  it("is NOT called out when a tie crowned several people", () => {
    // Two people who each won both is not a moment, it is a coincidence.
    expect(doubleWinner([
      crown({ category: "FUNNIEST", who: "Dana" }),
      crown({ category: "FUNNIEST", who: "Jo" }),
      crown({ category: "CLOSEST", who: "Dana" }),
      crown({ category: "CLOSEST", who: "Jo" }),
    ])).toBeUndefined();
  });

  it("is NOT called out when different people took each award", () => {
    expect(doubleWinner([
      crown({ category: "FUNNIEST", who: "Dana" }),
      crown({ category: "CLOSEST", who: "Jo" }),
    ])).toBeUndefined();
  });

  it("handles a round with no ballot at all", () => {
    expect(doubleWinner([])).toBeUndefined();
  });
});

/**
 * Render a scene for real and hand back the markup it put on the board.
 *
 * overlay() needs very little: createElement, className, innerHTML and a
 * body.append. Stubbing that much beats grepping the source, because it proves
 * the crowns actually reach the screen rather than merely being referenced.
 * AudioContext is left undefined on purpose — audio() catches and no-ops, which
 * is also a check that the visuals never depend on sound.
 */
function renderScene(run: () => void): string {
  const appended: { innerHTML: string; className: string }[] = [];
  const node = () => ({
    innerHTML: "", className: "",
    classList: { add: () => undefined },
    remove: () => undefined,
  });
  const g = globalThis as Record<string, unknown>;
  const prev = g["document"];
  g["document"] = {
    createElement: node,
    body: { append: (n: { innerHTML: string; className: string }) => appended.push(n) },
  };
  try {
    run();
  } finally {
    g["document"] = prev;
  }
  return appended.map((n) => n.innerHTML).join("\n");
}

describe("display type fits the box, whatever a game is called", () => {
  /**
   * REGRESSION (live playtest, 2026-08-25): the board announced a Ghostwriter
   * round as "GHOSTWRI…". Measured in a real browser with the real fonts, the
   * title ran 1,737px into a 710px box; "SAY LESS" measured 710px into 710px,
   * so the type scale had been fitted to the flagship name to the pixel.
   *
   * Layout cannot be measured in this harness, so what is asserted is the
   * contract that makes the layout right: wrapping is allowed, and the fitter
   * budgets LINES (a width-only check passes happily while wrapped type breaks
   * mid-word across four lines).
   */
  it("lets every display class wrap instead of overflowing its box", () => {
    for (const cls of [".attract-title", ".cine-title", ".cine-word"]) {
      const rule = new RegExp(`\\${cls} \\{[\\s\\S]*?\\}`).exec(css)?.[0] ?? "";
      expect(rule, `${cls} rule not found`).not.toBe("");
      expect(rule).toContain("overflow-wrap: break-word");
      expect(rule).toContain("max-width: 100%");
    }
  });

  it("budgets LINES, not just width — wrapped text never overflows width", () => {
    const fn = /export function fitBigType[\s\S]*?\n}/.exec(src)?.[0] ?? "";
    expect(fn).not.toBe("");
    // Line measurement is the whole point.
    expect(fn).toMatch(/lineHeight/);
    expect(fn).toMatch(/getBoundingClientRect/);
    expect(fn).toMatch(/MAX_MARQUEE_LINES/);
    // And it must be bounded — no unbounded shrink loop on a strange layout.
    expect(code(fn)).toMatch(/step < \d+/);
  });

  it("degrades instead of throwing when it cannot measure", () => {
    // cinema is "a layer, never a dependency" — proven by calling it with junk.
    expect(() => fitBigType(undefined as unknown as ParentNode)).not.toThrow();
    expect(() => fitBigType({} as unknown as ParentNode)).not.toThrow();
  });

  it("runs AFTER the scene is in the document, and on the attract marquee", () => {
    // scrollWidth is meaningless before layout; measuring too early is exactly
    // how the bug shipped.
    expect(code(src)).toMatch(/document\.body\.append\(node\);\s*[\s\S]{0,200}?fitBigType\(node\)/);
    expect(code(main)).toMatch(/fitBigType\(head\)/);
  });

  it("never hardcodes a game name in the title card", () => {
    const call = /scenes\.title\([^)]*\)/.exec(code(main))?.[0] ?? "";
    expect(call).toContain("currentView()");
    expect(call).not.toMatch(/say\s*less/i);
  });
});

describe("the board actually receives the crowns", () => {
  it("puts the winning GUESS on the board, not just a name", () => {
    // The whole point. This data existed in the same event tick and never
    // reached the one screen the entire room is looking at.
    const html = renderScene(() =>
      scenes.reveal("Air guitar", "Zero strings attached.", "Dana", [
        crown({ category: "FUNNIEST", text: "a haunted lute", who: "Jo", votes: 4 }),
        crown({ category: "CLOSEST", text: "invisible shredding", who: "Dana", votes: 2 }),
      ]),
    );
    expect(html).toContain("AIR GUITAR");
    expect(html).toContain("a haunted lute");
    expect(html).toContain("Jo · 4 votes");
    expect(html).toContain("invisible shredding");
    expect(html).toContain("FUNNIEST");
    expect(html).toContain("CLOSEST");
  });

  it("still crowns the room's pick when NOBODY guessed it", () => {
    // The deflating beat. A wipeout round has to end in a laugh, and that is
    // exactly the round where the funniest guess matters most.
    const html = renderScene(() =>
      scenes.reveal("Air guitar", undefined, undefined, [
        crown({ text: "a haunted lute", who: "Jo", votes: 5 }),
      ]),
    );
    expect(html).toContain("nobody got it");
    expect(html).toContain("a haunted lute");
  });

  it("says so out loud when one person took both", () => {
    const html = renderScene(() =>
      scenes.reveal("Air guitar", undefined, "Dana", [
        crown({ category: "FUNNIEST", who: "Dana" }),
        crown({ category: "CLOSEST", who: "Dana" }),
      ]),
    );
    expect(html).toContain("TOOK BOTH");
  });

  it("renders the old shape untouched when there was no ballot", () => {
    // Under four players the ballot never runs, and the reveal must still work.
    const html = renderScene(() => scenes.reveal("Air guitar", "A line.", "Dana"));
    expect(html).toContain("AIR GUITAR");
    expect(html).not.toContain("cine-crown");
    expect(html).not.toContain("TOOK BOTH");
  });

  it("joins the award winner to the ballot TEXT at the call site", () => {
    // The winners arrive as slotId + playerId + votes, because the ballot is
    // anonymous until the reveal. Without this join there is no headline.
    expect(main).toMatch(/function crownsFor/);
    expect(main).toMatch(/round\.ballot\?\.find\(\(b\) => b\.slotId === slotId\)/);
    expect(main).toContain("crownsFor(after)");
  });

  it("holds the scene longer when there are crowns to show", () => {
    expect(code(src)).toMatch(/crowns\.length > 0 \? \d{4} : 4200/);
  });
});

describe("reduced motion removes MOVEMENT, never information", () => {
  it("does not cut a scene's lifetime short", () => {
    // The bug: `Math.min(ms, 800)` gave a player who asked for less motion
    // 0.8s to read what everyone else got five seconds for.
    expect(code(src)).not.toContain("Math.min(ms, 800)");
    expect(code(src)).not.toMatch(/reducedMotion\(\)\s*\?/);
  });

  it("keeps the crowns on screen with the wipes dropped", () => {
    const block = reducedMotionCss();
    expect(block).toContain(".cine-crown");
    expect(block).toMatch(/clip-path: none/);
    // A wiped-in slab whose clip-path is never animated would stay invisible.
    expect(block).toMatch(/opacity: 1/);
  });

  it("un-clips the credits, which were unreadable", () => {
    // `roll-up` is the ONLY thing positioning the roll, inside a flex-end +
    // overflow-hidden parent. Killing the animation left it off-frame.
    const block = reducedMotionCss();
    expect(block).toMatch(/\.cine-credits \{[^}]*justify-content: flex-start/);
    expect(block).toMatch(/\.cine-roll \{[^}]*transform: none/);
  });

  it("still disables the animations it is meant to disable", () => {
    const block = reducedMotionCss();
    for (const sel of [".cine-title", ".cine-word", ".attract-title", "body.tension"]) {
      expect(block).toContain(sel);
    }
  });
});

describe("the crowns are legible on a television", () => {
  it("sets the guess in the display face at broadcast scale", () => {
    const rule = /\.cine-crown-text \{[\s\S]*?\}/.exec(css)?.[0] ?? "";
    expect(rule).toContain("var(--display)");
    // A guess can be long; it must wrap rather than overflow the frame.
    expect(rule).toMatch(/overflow-wrap: anywhere/);
    expect(rule).toMatch(/font-size: clamp\([^)]*\)/);
  });

  it("gives each award fill a legible ink, whichever way round it is", () => {
    // Both crowns are colour fills carrying type, so the pairing has to clear
    // AA — but WHICH ink is correct depends on the fill. White is right on the
    // red (4.79) and wrong on the green; dark is the reverse. Asserting a
    // literal hex just encodes today's palette, so compute the ratio instead.
    for (const sel of ["funny", "close"]) {
      const rule = new RegExp(`\\.cine-crown\\.${sel} \\{[^}]*\\}`).exec(css)?.[0] ?? "";
      expect(rule, `${sel} rule`).toMatch(/background:\s*var\(--\w[\w-]*\)/);
      expect(rule, `${sel} needs an explicit ink`).toMatch(/color:\s*(var\(--[\w-]+\)|#[0-9a-f]{3,6})/i);
      expect(crownContrast(rule), `${sel} fill/ink contrast`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
