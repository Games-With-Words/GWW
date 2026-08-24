/**
 * Ris's hosting lines — the forge's second consumer, and the reason this is a
 * pipeline instead of a deck script.
 *
 * The live voice service already writes lines one at a time in the background.
 * That was built to keep a show running; it is not how you author a script.
 * Forging a pack offline means every line is reviewed by a human before Ris
 * ever says it, and the runtime just picks from a vetted bank.
 */

import { normalize, tokenize } from "@gww/say-less";
import type { ContentSpec, GateResult } from "../spec.js";

/** The hosting moments, mirroring the voice service's cue bank. */
export type Cue = "intro" | "round" | "clue" | "timeout" | "correct" | "outro";
export const CUES: Cue[] = ["intro", "round", "clue", "timeout", "correct", "outro"];

export interface RisLine {
  cue: Cue;
  text: string;
}

const CUE_BRIEFS: Record<Cue, string> = {
  intro: "welcoming the room and kicking off a game of Say Less",
  round: "announcing a new round: the Speaker just got a secret word, everyone else should get ready to guess",
  clue: "announcing that the Speaker's clue just landed and the guessers should go fast",
  timeout: "time ran out and NOBODY guessed the word — a playful sting",
  correct: "someone just guessed the secret word correctly — celebrate it",
  outro: "signing off at the end of the game — send the room off laughing",
};

/** Words that mean the model is describing its task instead of hosting. */
const META = /\b(seed|randomi[sz]|option|draft|candidate|i'll|i will|let me|the user|rules?:|under \d+ words)\b/i;

export function risLines(cue: Cue): ContentSpec<RisLine> {
  return {
    id: `ris-lines-${cue}`,
    version: "1",
    tag: "LINE",
    payload: "text",
    brief: [
      "You are Ris, the host of Games With Words — a private, in-person party",
      "game played by friends and family in one room. You are warm, quick, and a",
      "little mischievous. You roast the MOMENT, never a person.",
      "",
      `Write ONE line for this moment: ${CUE_BRIEFS[cue]}.`,
      "",
      "Rules: 4 to 25 words; plain speakable text; no emojis, no quotation marks,",
      "no stage directions, no names. It has to land out loud, on the first hearing.",
    ].join("\n"),
    shape: "the finished line, exactly as it should be spoken",

    user({ seed, avoid }) {
      const sample = avoid.slice(-15);
      const avoidLine = sample.length > 0
        ? `\n\nAlready written — go somewhere new:\n${sample.map((s) => `- ${s}`).join("\n")}`
        : "";
      return `Write one fresh ${cue} line. Random seed: ${seed}.${avoidLine}`;
    },

    gate(raw: unknown): GateResult<RisLine> {
      if (typeof raw !== "string") return { ok: false, reason: "not text" };
      let text = raw.trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
      // A block should hold one line; if the model padded it, keep the last.
      const parts = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      if (parts.length > 0) text = parts[parts.length - 1]!;
      const words = tokenize(text);
      if (words.length < 4 || words.length > 25) {
        return { ok: false, reason: `line must be 4-25 words, got ${words.length}: "${text}"` };
      }
      if (/https?:|[<>{}]/.test(text)) return { ok: false, reason: "contains markup or a url" };
      if (META.test(text)) return { ok: false, reason: `reads as deliberation, not hosting: "${text}"` };
      if (!/[.!?…]$/.test(text)) text = `${text}.`;
      return { ok: true, item: { cue, text } };
    },

    key(line) {
      return normalize(line.text);
    },
  };
}
