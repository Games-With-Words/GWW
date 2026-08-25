/**
 * Mobile invariants. These are CSS rules whose absence is invisible in review
 * and painful on a phone, so they get asserted instead of remembered.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(import.meta.dirname, "../src/style.css"), "utf8");
const ts = readFileSync(join(import.meta.dirname, "../src/main.ts"), "utf8");
// Say Less's composer and inputs moved to src/games/say-less.ts in the
// multi-game split; board furniture and Ris still live in main.ts, so the two
// sources are read separately and each assertion points at the file it is about.
const sl = readFileSync(join(import.meta.dirname, "../src/games/say-less.ts"), "utf8");

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
    expect(sl.match(/class="card stack composer"/g)).toHaveLength(2);
  });

  it("tells the phone keyboard what its action key does", () => {
    // Every text input the player types into should declare an intent.
    const inputs = sl.match(/<input[^>]*type="text"[^>]*>/g) ?? [];
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

  it("gives a crawler real content, not an empty div", () => {
    /**
     * Measured against production before this landed: fetching
     * games-with-words.com returned `<div id="app"></div>` and a bundle. No
     * heading, no game names, not one word of copy.
     *
     * Google executes JavaScript, but for a new domain that is a slow
     * best-effort second pass, and every other crawler saw nothing at all. The
     * brand query is three of the commonest words in English — showing up for it
     * with zero text was never going to happen.
     */
    const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
    const shell = /<div id="app"[^>]*>([\s\S]*?)<\/div>\s*<script/.exec(html)?.[1] ?? "";
    expect(shell.length).toBeGreaterThan(600);
    expect(shell).toMatch(/<h1>Games With Words<\/h1>/);
    // Both games, both makers — the arcade IS the credits screen.
    for (const s of ["Say Less", "The Oracle", "Ghost Writer", "Vex"]) {
      expect(shell, `crawler cannot see ${s}`).toContain(s);
    }
    // And a real answer for a browser with JS off.
    expect(html).toContain("<noscript>");
  });

  it("declares the arcade in structured data", () => {
    const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
    const raw = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(raw.length).toBeGreaterThan(0);
    // It has to PARSE. A JSON-LD block with a trailing comma is worth nothing
    // and looks perfectly fine in review.
    const data = JSON.parse(raw) as { "@graph": { "@type": string; name?: string; itemListElement?: unknown[] }[] };
    const types = data["@graph"].map((n) => n["@type"]);
    expect(types).toContain("WebSite");
    expect(types).toContain("ItemList");
    const list = data["@graph"].find((n) => n["@type"] === "ItemList");
    expect(list?.itemListElement).toHaveLength(2);
    // The name is the whole point of the exercise.
    expect(data["@graph"][0]!.name).toBe("Games With Words");
  });

  it("ships a real robots.txt and a valid sitemap", () => {
    /**
     * Both used to 200 with the SPA'S HTML, because the server's static handler
     * falls through to index.html for anything it cannot find — so a crawler
     * asking for robots.txt got a web page, served as text/html.
     */
    const robots = readFileSync(join(import.meta.dirname, "../public/robots.txt"), "utf8");
    expect(robots).not.toContain("<!DOCTYPE");
    expect(robots).toMatch(/^User-agent:/m);
    expect(robots).toMatch(/Sitemap: https:\/\/games-with-words\.com\/sitemap\.xml/);
    // Room URLs carry a token and expire in hours — never worth indexing.
    expect(robots).toMatch(/Disallow: \/api\//);

    const sitemap = readFileSync(join(import.meta.dirname, "../public/sitemap.xml"), "utf8");
    expect(sitemap).not.toContain("<!DOCTYPE html");
    // sitemapS.org — the singular form is a real typo that silently invalidates
    // the whole file, and I made it on the first pass.
    expect(sitemap).toContain("http://www.sitemaps.org/schemas/sitemap/0.9");
    expect(sitemap).toContain("<loc>https://games-with-words.com/</loc>");
  });

  it("has a REAL share card, at the size scrapers expect", () => {
    /**
     * The site had no share metadata at all — a link into a group chat rendered
     * as a bare URL, which for a party game is the worst possible first
     * impression: the whole product is "send this to your friends".
     *
     * The image is rendered from og-card.html in the games' own vendored type
     * rather than generated, because a share preview of a WORD game should show
     * the words. Checked here for real bytes and real dimensions — a 404 og:image
     * is indistinguishable from no og:image, and neither shows up in review.
     */
    const html = readFileSync(join(import.meta.dirname, "../index.html"), "utf8");
    for (const tag of ["og:title", "og:description", "og:image", "og:url", "og:type", "twitter:card"]) {
      expect(html, `missing ${tag}`).toContain(tag);
    }
    // Scrapers do not resolve relative paths.
    expect(html).toMatch(/og:image"\s+content="https:\/\//);
    expect(html).toContain('content="summary_large_image"');

    const jpg = readFileSync(join(import.meta.dirname, "../public/og.jpg"));
    expect(jpg.length).toBeGreaterThan(10_000);

    // Read the real SOF dimensions out of the JPEG rather than trusting the meta.
    let w = 0, h = 0, i = 2;
    while (i < jpg.length - 9) {
      if (jpg[i] !== 0xff) { i += 1; continue; }
      const marker = jpg[i + 1]!;
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        h = jpg.readUInt16BE(i + 5); w = jpg.readUInt16BE(i + 7); break;
      }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      i += 2 + jpg.readUInt16BE(i + 2);
    }
    expect({ w, h }).toEqual({ w: 1200, h: 630 });
    // And the declared size must match the actual file.
    expect(html).toContain('og:image:width" content="1200"');
    expect(html).toContain('og:image:height" content="630"');
  });

  it("does not answer its own hook on the share card", () => {
    // The first render marked which answer was written blind with a red dot,
    // directly under the line asking which one it was.
    const card = readFileSync(join(import.meta.dirname, "../og-card.html"), "utf8");
    expect(card).toContain("written blind");
    expect(card).not.toMatch(/class="row blind"/);
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

/* ---- Broadcast furniture -------------------------------------------------
   The bars were 4vh of black top and bottom of a 16:9 UI on a 16:9 TV —
   letterboxing a format nothing was cropped to. They now carry the clock and
   the standings, which also fixes a layout bug: the scoreboard was rendered
   LAST, at the bottom of a scrolling column, on a screen nobody can touch. */
describe("the board's strips do real work", () => {
  it("pins both strips above the content and out of the way of taps", () => {
    for (const sel of [".tally", ".lowerthird"]) {
      const rule = new RegExp(`\\${sel}[^{]*\\{[\\s\\S]*?\\}`).exec(css)?.[0] ?? "";
      expect(rule, `${sel} rule`).toContain("position: fixed");
      expect(rule).toContain("pointer-events: none");
    }
  });

  it("keeps board content clear of both strips", () => {
    expect(css).toMatch(/#app\.board \{[^}]*padding-top/);
    expect(css).toMatch(/#app\.board \{[^}]*padding-bottom/);
  });

  it("renders the standings as furniture, not as the last thing in a scroll", () => {
    expect(ts).toMatch(/function boardFurniture/);
    expect(ts).toMatch(/for \(const strip of boardFurniture\(s\)\) app\.append\(strip\)/);
    // The lower third is phase-aware: votes while voting, who's locked in while
    // guessing, standings otherwise.
    expect(ts).toContain("lt-label");
    expect(ts).toMatch(/STANDINGS/);
  });

  it("does not lose the room's scroll position when it re-renders", () => {
    /**
     * REGRESSION (live playtest, 2026-08-25): "I scroll down to reveal the QR and
     * the page auto scrolls me back to top".
     *
     * Measured in a browser: a layout flush taken while the page is half-built
     * (fitBigType measuring the marquee before the QR card is appended) clamps
     * the scroll from 534px to 157px, because the document is momentarily far
     * shorter than the offset. Chrome's scroll anchoring hides it; Safari has no
     * scroll anchoring, so on a board it stays where it was clamped.
     *
     * Three defences, all asserted here because none of them is visible in a
     * screenshot: hold the height across the rebuild, restore the offset after,
     * and stop rebuilding for a text change at all.
     */
    expect(ts).toMatch(/app\.style\.minHeight = `\$\{pinnedHeight\}px`/);
    expect(ts).toMatch(/app\.style\.minHeight = ""/);
    expect(ts).toMatch(/window\.scrollTo\(0, keepScroll\)/);
    // The restore must be conditional on staying on the same screen — moving
    // between screens should start at the top.
    expect(ts).toMatch(/sameView\s*&&/);
  });

  it("rotates the attract line without rebuilding the page", () => {
    // It used to call render() every five seconds, which is a full DOM rebuild
    // to change one sentence — the same reason tickClock edits only the clock.
    const fn = /function tickAttract[\s\S]*?\n}/.exec(ts)?.[0] ?? "";
    expect(fn).not.toBe("");
    expect(fn).toContain("textContent");
    expect(fn).not.toContain("render()");
    // And the interval must call the surgical version, not the nuke.
    const timer = /attractTimer = setInterval\([\s\S]*?\}, 5000\)/.exec(ts)?.[0] ?? "";
    expect(timer).toContain("tickAttract()");
    expect(timer).not.toMatch(/\brender\(\)/);
  });

  it("never hardcodes a game name in the cinema — the board announces the room's game", () => {
    /**
     * REGRESSION (live playtest, 2026-08-25): a Ghostwriter room opened with the
     * title card "INTERCHAINED LLC LABS presents SAY LESS", and the end-of-game
     * credits would have credited The Oracle for someone else's game.
     *
     * Asserted at the source because the cinema takes strings as arguments — no
     * runtime state distinguishes a right title from a wrong one, so the only
     * place to catch a literal is where it is written.
     */
    const cinemaCalls = ts.match(/scenes\.(title|credits)\([^)]*\)/g) ?? [];
    expect(cinemaCalls.length).toBeGreaterThan(0);
    for (const call of cinemaCalls) {
      expect(call).not.toMatch(/say\s*less/i);
      expect(call).not.toMatch(/The Oracle/);
      // Whatever it passes must come from the registered view or the manifest.
      expect(call).toMatch(/currentView\(\)|tile\?|\bcredit\b/);
    }
  });

  it("puts the arcade on the attract screen, not one game's name", () => {
    const attract = /const marquee[\s\S]{0,200}/.exec(ts)?.[0] ?? "";
    expect(attract).toContain("GAMES WITH WORDS");
    expect(attract).toContain("currentView()");
  });

  it("still un-pins the composer on the board", () => {
    // Guarded separately above too — repeated here because this describe adds
    // new #app.board rules and that literal is easy to disturb.
    expect(css).toContain("#app.board .composer { position: static");
  });

  it("signals the last ten seconds with a state change, not an animated shadow", () => {
    // Was an animated 80px inset box-shadow on <body> plus a saturate() filter
    // on #app, during the exact window guesses stream in and the clock repaints.
    expect(css).not.toContain("pulse-bg");
    expect(css).not.toMatch(/body\.tension #app \{[^}]*filter:/);
    expect(css).toMatch(/body\.tension \.tally \{[\s\S]*?background: var\(--accent\)/);
  });

  it("keeps the red warning when motion is off, dropping only the pulse", () => {
    const rm = (css.match(/@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\n\}/g) ?? []).join("\n");
    expect(rm).toMatch(/body\.tension \.tally \{ animation: none/);
  });
});
