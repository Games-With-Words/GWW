/**
 * Say Less cards. The first consumer of the forge.
 *
 * The gate here is strict on purpose: a bad card doesn't produce a bad line,
 * it breaks a round. A forbidden list that accidentally contains the secret's
 * own words makes the card unplayable — the Speaker cannot legally say
 * anything. That check is the reason this file exists.
 */

import { normalize, tokenize, type Card } from "@gww/say-less";
import type { ContentSpec, GateResult } from "../spec.js";

/** Categories are fixed by the game manifest — the model does not invent them. */
export const CARD_CATEGORIES = [
  "Movies",
  "Family",
  "Music",
  "Pop Culture",
  "Food",
  "Places",
  "Everyday Life",
] as const;

const SHAPE = `{
  "secret": "Air guitar",
  "aliases": ["air guitar solo"],
  "category": "Music",
  "forbidden": ["instrument", "pretend", "rock", "invisible"],
  "budget": 3,
  "difficulty": 3,
  "revealLine": "Zero strings attached."
}`;

const BRIEF = [
  "You write cards for Say Less, a party game played out loud by friends and",
  "family in one room. One player (the Speaker) sees the secret and must get",
  "the room to say it using as few words as possible. Fewer words scores more.",
  "",
  "A GREAT card is something everyone in a mixed-age room instantly recognizes",
  "once they hear it — a movie everybody has seen, a family ritual, an everyday",
  "object, a universal small indignity. Concrete beats clever. If it needs",
  "specialist knowledge, it is a bad card.",
  "",
  "Field rules:",
  "- secret: 1 to 3 words. A thing, title, or moment. Never a full sentence.",
  "- aliases: 0 to 3 accepted alternates (plurals, 'the' forms, common nicknames).",
  "- category: EXACTLY one of " + CARD_CATEGORIES.join(", ") + ".",
  "- forbidden: 3 to 5 single words a Speaker would obviously reach for first.",
  "  They must NOT contain any word from the secret or its aliases — the card",
  "  has to stay playable. Block the obvious neighbours, not the answer itself.",
  "- budget: clue word allowance, 1 to 7. Easy and concrete gets 5. Abstract",
  "  gets 3. Only give 1 to something a single word can nail.",
  "- difficulty: 1 warm-up, 2 easy, 3 tricky, 4 finale.",
  "- revealLine: one short, dry, affectionate joke shown when the round ends.",
  "  Under 14 words. Roast the moment, never a person.",
].join("\n");

interface RawCard {
  secret?: unknown;
  aliases?: unknown;
  category?: unknown;
  forbidden?: unknown;
  budget?: unknown;
  difficulty?: unknown;
  revealLine?: unknown;
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === "string");

export const sayLessCards: ContentSpec<Card> = {
  id: "say-less-cards",
  version: "1",
  tag: "CARD",
  payload: "json",
  brief: BRIEF,
  shape: SHAPE,

  user({ seed, avoid }) {
    // A short sample of what exists is enough to steer away from repeats;
    // pasting hundreds of secrets would crowd out the brief.
    const sample = avoid.slice(-40);
    const avoidLine = sample.length > 0
      ? `\n\nAlready in the deck — pick something in a DIFFERENT area entirely:\n${sample.join(", ")}.`
      : "";
    return (
      `Write ONE new Say Less card. Random seed: ${seed}. ` +
      `Surprise me: vary the category and the register from anything obvious.` +
      avoidLine
    );
  },

  gate(raw: unknown): GateResult<Card> {
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "not an object" };
    const c = raw as RawCard;

    if (typeof c.secret !== "string") return { ok: false, reason: "secret missing" };
    const secret = c.secret.trim();
    const secretWords = tokenize(secret);
    if (secretWords.length < 1 || secretWords.length > 3) {
      return { ok: false, reason: `secret must be 1-3 words, got ${secretWords.length}: "${secret}"` };
    }

    const aliases = c.aliases === undefined ? [] : c.aliases;
    if (!isStringArray(aliases)) return { ok: false, reason: "aliases must be strings" };
    if (aliases.length > 3) return { ok: false, reason: `too many aliases (${aliases.length})` };

    if (typeof c.category !== "string" || !CARD_CATEGORIES.includes(c.category as typeof CARD_CATEGORIES[number])) {
      return { ok: false, reason: `category not in the manifest list: ${String(c.category)}` };
    }

    if (!isStringArray(c.forbidden)) return { ok: false, reason: "forbidden must be strings" };
    const forbidden = c.forbidden.map((f) => f.trim()).filter((f) => f.length > 0);
    if (forbidden.length < 3 || forbidden.length > 5) {
      return { ok: false, reason: `forbidden must have 3-5 words, got ${forbidden.length}` };
    }
    if (forbidden.some((f) => tokenize(f).length !== 1)) {
      return { ok: false, reason: `forbidden entries must be single words: ${forbidden.join(", ")}` };
    }
    // THE important check: a forbidden list containing the answer's own words
    // leaves the Speaker with no legal clue at all.
    const answerTokens = new Set([secret, ...aliases].flatMap((s) => tokenize(s)));
    const collision = forbidden.find((f) => answerTokens.has(tokenize(f)[0] ?? ""));
    if (collision !== undefined) {
      return { ok: false, reason: `forbidden word "${collision}" is part of the answer — card unplayable` };
    }
    if (new Set(forbidden.map((f) => normalize(f))).size !== forbidden.length) {
      return { ok: false, reason: "duplicate forbidden words" };
    }

    if (typeof c.budget !== "number" || !Number.isInteger(c.budget) || c.budget < 1 || c.budget > 7) {
      return { ok: false, reason: `budget must be an integer 1-7, got ${String(c.budget)}` };
    }
    if (c.difficulty !== 1 && c.difficulty !== 2 && c.difficulty !== 3 && c.difficulty !== 4) {
      return { ok: false, reason: `difficulty must be 1-4, got ${String(c.difficulty)}` };
    }

    let revealLine: string | undefined;
    if (c.revealLine !== undefined) {
      if (typeof c.revealLine !== "string") return { ok: false, reason: "revealLine must be a string" };
      const rl = c.revealLine.trim().replace(/^["'“‘]+|["'”’]+$/g, "");
      if (tokenize(rl).length > 14) return { ok: false, reason: `revealLine too long: "${rl}"` };
      if (rl.length > 0) revealLine = rl;
    }

    // Content-addressed id: the same secret always yields the same card id,
    // so a pack can be regenerated without churning ids.
    const slug = normalize(secret).replace(/\s+/g, "-").slice(0, 32);
    return {
      ok: true,
      item: {
        id: `sl-gen-${slug}`,
        secret,
        aliases: aliases.map((a) => a.trim()).filter((a) => a.length > 0),
        category: c.category,
        forbidden: forbidden.map((f) => f.toLowerCase()),
        budget: c.budget,
        difficulty: c.difficulty,
        ...(revealLine !== undefined ? { revealLine } : {}),
      },
    };
  },

  key(card) {
    return normalize(card.secret);
  },
};
