/**
 * Say Less cards. The first consumer of the forge.
 *
 * The gate here is strict on purpose: a bad card doesn't produce a bad line,
 * it breaks a round. A forbidden list that accidentally contains the secret's
 * own words makes the card unplayable — the Speaker cannot legally say
 * anything. That check is the reason this file exists.
 */

import { normalize, tokenize, type Card } from "@gww/say-less";
import { lines } from "../generate.js";
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

export const CARD_FIELDS = [
  "secret", "aliases", "category", "forbidden", "budget", "difficulty", "revealLine",
] as const;

/** Required — a card without these is not a card. aliases and revealLine are optional. */
const CARD_REQUIRED = ["secret", "category", "forbidden", "budget", "difficulty"] as const;

const SHAPE = `<<<FIELD secret>>>
Air guitar
<<<END>>>
<<<FIELD aliases>>>
air guitar solo
<<<END>>>
<<<FIELD category>>>
Music
<<<END>>>
<<<FIELD forbidden>>>
instrument
pretend
rock
invisible
<<<END>>>
<<<FIELD budget>>>
3
<<<END>>>
<<<FIELD difficulty>>>
3
<<<END>>>
<<<FIELD revealLine>>>
Zero strings attached.
<<<END>>>`;

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
  "- aliases: 0 to 3 accepted alternates (plurals, 'the' forms, common nicknames),",
  "  one per line. Leave the block empty if there are none.",
  "- category: EXACTLY one of " + CARD_CATEGORIES.join(", ") + ".",
  "- forbidden: 3 to 5 single words a Speaker would obviously reach for first,",
  "  ONE PER LINE.",
  "  They must NOT contain any word from the secret or its aliases — the card",
  "  has to stay playable. Block the obvious neighbours, not the answer itself.",
  "- budget: clue word allowance, 1 to 7. Easy and concrete gets 5. Abstract",
  "  gets 3. Only give 1 to something a single word can nail.",
  "- difficulty: 1 warm-up, 2 easy, 3 tricky, 4 finale.",
  "- revealLine: one short, dry, affectionate joke shown when the round ends.",
  "  Under 14 words. Roast the moment, never a person.",
].join("\n");

export const sayLessCards: ContentSpec<Card> = {
  id: "say-less-cards",
  version: "1",
  tag: "FIELD",
  payload: "fields",
  fields: CARD_FIELDS,
  required: CARD_REQUIRED,
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
    if (typeof raw !== "object" || raw === null) return { ok: false, reason: "no field blocks" };
    const f = raw as Record<string, string | undefined>;

    // Every value arrives as the plain text the model wrote between markers.
    // Nothing was parsed, so nothing could have been mangled on the way in.
    const secret = (f["secret"] ?? "").trim();
    const secretWords = tokenize(secret);
    if (secretWords.length < 1 || secretWords.length > 3) {
      return { ok: false, reason: `secret must be 1-3 words, got ${secretWords.length}: "${secret}"` };
    }

    const aliases = lines(f["aliases"]).slice(0, 3);

    const category = (f["category"] ?? "").trim();
    if (!CARD_CATEGORIES.includes(category as typeof CARD_CATEGORIES[number])) {
      return { ok: false, reason: `category not in the manifest list: "${category}"` };
    }

    const forbidden = lines(f["forbidden"]).map((x) => x.toLowerCase());
    if (forbidden.length < 3 || forbidden.length > 5) {
      return { ok: false, reason: `forbidden needs 3-5 words, one per line, got ${forbidden.length}` };
    }
    if (forbidden.some((x) => tokenize(x).length !== 1)) {
      return { ok: false, reason: `forbidden entries must be single words: ${forbidden.join(", ")}` };
    }
    // THE important check: a forbidden list containing the answer's own words
    // leaves the Speaker with no legal clue at all.
    const answerTokens = new Set([secret, ...aliases].flatMap((x) => tokenize(x)));
    const collision = forbidden.find((x) => answerTokens.has(tokenize(x)[0] ?? ""));
    if (collision !== undefined) {
      return { ok: false, reason: `forbidden word "${collision}" is part of the answer — card unplayable` };
    }
    if (new Set(forbidden.map((x) => normalize(x))).size !== forbidden.length) {
      return { ok: false, reason: "duplicate forbidden words" };
    }

    const budget = Number((f["budget"] ?? "").trim());
    if (!Number.isInteger(budget) || budget < 1 || budget > 7) {
      return { ok: false, reason: `budget must be an integer 1-7, got "${f["budget"] ?? ""}"` };
    }
    const difficulty = Number((f["difficulty"] ?? "").trim());
    if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3 && difficulty !== 4) {
      return { ok: false, reason: `difficulty must be 1-4, got "${f["difficulty"] ?? ""}"` };
    }

    let revealLine: string | undefined;
    const rl = lines(f["revealLine"])[0];
    if (rl !== undefined) {
      if (tokenize(rl).length > 14) return { ok: false, reason: `revealLine too long: "${rl}"` };
      revealLine = rl;
    }

    // Content-addressed id: the same secret always yields the same card id,
    // so a pack can be regenerated without churning ids.
    const slug = normalize(secret).replace(/\s+/g, "-").slice(0, 32);
    return {
      ok: true,
      item: {
        id: `sl-gen-${slug}`,
        secret,
        aliases,
        category,
        forbidden,
        budget,
        difficulty: difficulty as 1 | 2 | 3 | 4,
        ...(revealLine !== undefined ? { revealLine } : {}),
      },
    };
  },

  key(card) {
    return normalize(card.secret);
  },
};
