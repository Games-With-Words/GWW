/**
 * The Theater Cut — cinematic presentation layer for the BOARD (Mark,
 * 2026-08-23: "I want them to feel like they are at the movies").
 *
 * Score: synthesized live in WebAudio. No audio files, no CDN, no deps —
 * every note is an oscillator we own. Visuals: full-screen overlays appended
 * to <body> so the render loop never wipes them mid-scene.
 *
 * Everything here is presentation. If audio is blocked or reduced-motion is
 * set, the game plays identically — cinema is a layer, never a dependency.
 */

let ctx: AudioContext | undefined;
let master: GainNode | undefined;

/* Reduced motion is handled entirely in CSS. It used to be consulted here, to
   cut a scene's LIFETIME short, which confused "don't move things" with "don't
   let me read things". Motion is a style concern; the timeline is not. */

function audio(): { ctx: AudioContext; master: GainNode } | undefined {
  try {
    if (ctx === undefined) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return { ctx, master: master! };
  } catch {
    return undefined;
  }
}

/** One enveloped tone. Everything below composes these. */
function tone(
  freq: number,
  start: number,
  dur: number,
  opts: { type?: OscillatorType; gain?: number; glideTo?: number } = {},
): void {
  const a = audio();
  if (a === undefined) return;
  const t0 = a.ctx.currentTime + start;
  const osc = a.ctx.createOscillator();
  const g = a.ctx.createGain();
  osc.type = opts.type ?? "sine";
  osc.frequency.setValueAtTime(freq, t0);
  if (opts.glideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(opts.glideTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.25, t0 + Math.min(0.05, dur / 4));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

export const score = {
  /** Deep two-note swell — the lights-down moment. */
  titleDrone(): void {
    tone(55, 0, 2.6, { type: "sawtooth", gain: 0.12 });
    tone(110, 0, 2.6, { type: "sine", gain: 0.18 });
    tone(164.81, 1.0, 1.8, { type: "sine", gain: 0.14 }); // E3 lands like a chord change
  },
  /** Short rising motif when a round opens. */
  roundOpen(): void {
    tone(220, 0, 0.18, { gain: 0.18 });
    tone(277.18, 0.14, 0.18, { gain: 0.18 });
    tone(329.63, 0.28, 0.35, { gain: 0.22 });
  },
  /** Clue lands — a single spotlight note. */
  clue(): void {
    tone(440, 0, 0.5, { type: "triangle", gain: 0.2 });
  },
  /** Countdown pressure tick (called once per second under 10s). */
  tick(urgency: number): void {
    tone(880 + urgency * 40, 0, 0.06, { type: "square", gain: 0.06 });
  },
  /** A guess hits the board. */
  guess(): void {
    tone(523.25, 0, 0.08, { type: "triangle", gain: 0.1 });
  },
  /** Blackout sting before the reveal. */
  sting(): void {
    tone(392, 0, 0.9, { type: "sawtooth", gain: 0.16, glideTo: 98 });
  },
  /** Correct! Triumphant triad. */
  win(): void {
    tone(523.25, 0, 0.5, { gain: 0.2 });
    tone(659.25, 0.08, 0.5, { gain: 0.2 });
    tone(783.99, 0.16, 0.7, { gain: 0.22 });
  },
  /**
   * A crown landing. Index 0 is FUNNIEST, 1 is CLOSEST — a perfect fifth up,
   * so which award just landed is identifiable from the kitchen, by ear.
   */
  crown(i: number): void {
    const root = i === 0 ? 146.83 : 220;
    tone(root, 0, 0.7, { type: "sawtooth", gain: 0.2 });
    tone(root * 4, 0.22, 0.35, { type: "triangle", gain: 0.16 });
  },
  /** End-credits fanfare. */
  fanfare(): void {
    const seq = [392, 523.25, 659.25, 783.99, 1046.5];
    seq.forEach((f, i) => tone(f, i * 0.16, 0.45, { gain: 0.2 }));
    tone(130.81, 0, 1.6, { type: "sawtooth", gain: 0.1 });
  },
};

/* ------------------------------------------------------------- overlays */

function overlay(html: string, className: string, ms: number): void {
  const node = document.createElement("div");
  node.className = `cine ${className}`;
  node.innerHTML = html;
  document.body.append(node);
  // Reduced motion means remove the MOVEMENT, not the time to read. This was
  // `Math.min(ms, 800)`, which handed a player who asked for less motion 0.8
  // seconds to read the answer, the reveal line, the winner and both crowns —
  // information the rest of the room gets five seconds for. The scene now
  // holds for its full life either way; the CSS drops the animation instead.
  setTimeout(() => {
    node.classList.add("out");
    setTimeout(() => node.remove(), 600);
  }, ms);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** One thing the room voted for, ready to be shown on the board. */
export interface Crown {
  category: "FUNNIEST" | "CLOSEST";
  /** The guess itself. This is the headline — it is why anyone stands up. */
  text: string;
  who: string;
  votes: number;
}

/** A name that won BOTH categories, if there is exactly one such person. */
export function doubleWinner(crowns: Crown[]): string | undefined {
  const funny = crowns.filter((c) => c.category === "FUNNIEST").map((c) => c.who);
  const close = crowns.filter((c) => c.category === "CLOSEST").map((c) => c.who);
  const both = funny.filter((n) => close.includes(n));
  // Ties can crown several people; "TOOK BOTH" is only a moment when it is one.
  return both.length === 1 ? both[0] : undefined;
}

export function crownHtml(c: Crown): string {
  const side = c.category === "FUNNIEST" ? "funny" : "close";
  return `<div class="cine-crown ${side}">
    <div class="cine-crown-label">${c.category}</div>
    <div class="cine-crown-text">${esc(c.text)}</div>
    <div class="cine-crown-who">${esc(c.who)} · ${c.votes} vote${c.votes === 1 ? "" : "s"}</div>
  </div>`;
}

export const scenes = {
  /** Lights down. Studio card, then the title slams in. */
  title(gameTitle: string): void {
    score.titleDrone();
    overlay(
      `<div class="cine-studio">INTERCHAINED LLC LABS<span>presents</span></div>
       <div class="cine-title">${esc(gameTitle.toUpperCase())}</div>`,
      "cine-titlecard",
      3200,
    );
  },

  /**
   * Blackout → the answer, huge → who got it → WHAT THE ROOM CROWNED.
   *
   * That last beat did not exist. The whole room votes on which guess was
   * funniest, and the result appeared only on each player's own phone, styled
   * with `.budget` — the same dim grey as the word-count readout. The one
   * moment guaranteed to get people out of a chair was a footnote on a
   * four-inch screen while the television showed a canned line.
   *
   * The crowns now land ON THE BOARD, with the guess itself as the headline and
   * the author's name under it, and they enter from OPPOSITE EDGES: funniest
   * from the left, closest from the right. Same-direction entrances read as a
   * list. Opposite vectors drag the room's eyes across the screen, so people
   * physically turn their heads to follow it.
   */
  reveal(
    secret: string,
    line: string | undefined,
    winner: string | undefined,
    crowns: Crown[] = [],
  ): void {
    score.sting();
    if (winner !== undefined) setTimeout(() => score.win(), 700);
    // One stab per crown, on the beat its slab lands.
    crowns.forEach((_, i) => {
      setTimeout(() => score.crown(i), 1700 + i * 800);
    });
    const double = doubleWinner(crowns);
    overlay(
      `<div class="cine-kicker">THE ANSWER WAS</div>
       <div class="cine-word">${esc(secret.toUpperCase())}</div>
       ${line !== undefined ? `<div class="cine-line">“${esc(line)}”</div>` : ""}
       ${winner !== undefined ? `<div class="cine-winner">${esc(winner)} takes it</div>` : `<div class="cine-winner dim">nobody got it</div>`}
       ${crowns.map(crownHtml).join("")}
       ${double !== undefined ? `<div class="cine-double">${esc(double)} TOOK BOTH</div>` : ""}`,
      "cine-reveal",
      crowns.length > 0 ? 6200 : 4200,
    );
  },

  /** The credits roll. This is the shot people film. */
  credits(cast: { name: string; score: number }[], gameTitle: string, maker: string): void {
    score.fanfare();
    const billing = [...cast].sort((a, b) => b.score - a.score);
    const rows = billing
      .map((c, i) => `<div class="cine-credit${i === 0 ? " top" : ""}"><span>${esc(c.name)}</span><b>${c.score}</b></div>`)
      .join("");
    overlay(
      `<div class="cine-roll">
        <div class="cine-kicker">CAST — in order of glory</div>
        ${rows}
        <div class="cine-credit-gap"></div>
        <div class="cine-credit meta"><span>${esc(gameTitle)}</span><b>a game by ${esc(maker)}</b></div>
        <div class="cine-credit meta"><span>Hosted by</span><b>RIS</b></div>
        <div class="cine-credit meta"><span>Games With Words</span><b>Interchained LLC Labs</b></div>
        <div class="cine-credit meta"><span>the room</span><b>is the game</b></div>
      </div>`,
      "cine-credits",
      14000,
    );
  },
};
