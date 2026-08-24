import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Card } from "@gww/say-less";
import {
  sayLessCards,
  risLines,
  payloadFromCompletion,
  generateOne,
  generateBatch,
  writePack,
  readPackItems,
  existingKeys,
  listPacks,
  loadDeck,
  type ForgeConfig,
} from "../src/index.js";

const goodCard = {
  secret: "Air guitar",
  aliases: ["air guitar solo"],
  category: "Music",
  forbidden: ["instrument", "pretend", "rock", "invisible"],
  budget: 3,
  difficulty: 3,
  revealLine: "Zero strings attached.",
};

const cfg = (over: Partial<ForgeConfig> = {}): ForgeConfig => ({
  aiasUrl: "https://aiassist.test",
  apiKey: "aai_test",
  model: "muse-local:latest",
  temperature: 1.0,
  ...over,
});

/** A model that answers the way the sentinel lesson teaches: think, then block. */
function fakeModel(payloads: unknown[], opts: { thinking?: boolean; finish?: string } = {}): typeof fetch {
  let i = 0;
  return (async () => {
    const p = payloads[Math.min(i++, payloads.length - 1)];
    const body = typeof p === "string" ? p : JSON.stringify(p, null, 2);
    const tag = typeof p === "string" ? "LINE" : "CARD";
    const text = `Weighing a few angles first.\n<<<${tag}>>>\n${body}\n<<<END>>>`;
    const message = opts.thinking ? { content: "", thinking: text } : { content: text };
    return new Response(
      JSON.stringify({ choices: [{ ...(opts.finish !== undefined ? { finish_reason: opts.finish } : {}), message }] }),
      { status: 200 },
    );
  }) as typeof fetch;
}

describe("say-less card gate — a bad card breaks a round, not just a line", () => {
  it("accepts a well-formed card and gives it a stable content-addressed id", () => {
    const r = sayLessCards.gate(goodCard);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.item.id).toBe("sl-gen-air-guitar");
    expect(r.item.secret).toBe("Air guitar");
    expect(r.item.forbidden).toEqual(["instrument", "pretend", "rock", "invisible"]);
    // Same secret, same id — regenerating a pack doesn't churn ids.
    const again = sayLessCards.gate({ ...goodCard, revealLine: "Different joke entirely." });
    expect(again.ok && again.item.id).toBe("sl-gen-air-guitar");
  });

  it("REJECTS a forbidden word that is part of the answer — the card would be unplayable", () => {
    const r = sayLessCards.gate({ ...goodCard, forbidden: ["guitar", "pretend", "rock"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("unplayable");
  });

  it("rejects a forbidden word hiding inside an alias", () => {
    const r = sayLessCards.gate({
      ...goodCard,
      aliases: ["karaoke night"],
      forbidden: ["karaoke", "pretend", "rock"],
    });
    expect(r.ok).toBe(false);
  });

  it("rejects secrets that are sentences, not things", () => {
    const r = sayLessCards.gate({ ...goodCard, secret: "That moment when the wifi drops out" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("1-3 words");
  });

  it("rejects a category the manifest doesn't have", () => {
    expect(sayLessCards.gate({ ...goodCard, category: "Cryptozoology" }).ok).toBe(false);
  });

  it("rejects multi-word forbidden entries and the wrong count", () => {
    expect(sayLessCards.gate({ ...goodCard, forbidden: ["air travel", "pretend", "rock"] }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, forbidden: ["one", "two"] }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, forbidden: ["a", "b", "c", "d", "e", "f"] }).ok).toBe(false);
  });

  it("rejects out-of-range budget and difficulty", () => {
    expect(sayLessCards.gate({ ...goodCard, budget: 0 }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, budget: 9 }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, difficulty: 5 }).ok).toBe(false);
  });

  it("rejects a rambling reveal line but accepts a card without one", () => {
    expect(sayLessCards.gate({
      ...goodCard,
      revealLine: "This is a very long reveal line that simply will not stop explaining the joke to everyone present.",
    }).ok).toBe(false);
    const { revealLine: _drop, ...noLine } = goodCard;
    expect(sayLessCards.gate(noLine).ok).toBe(true);
  });

  it("dedupes on the normalized secret, so casing and articles can't sneak a repeat in", () => {
    const a = sayLessCards.gate(goodCard);
    const b = sayLessCards.gate({ ...goodCard, secret: "AIR GUITAR" });
    expect(a.ok && b.ok && sayLessCards.key(a.item) === sayLessCards.key(b.item)).toBe(true);
  });
});

describe("ris line gate", () => {
  const clue = risLines("clue");
  it("accepts a hosting line and finishes its punctuation", () => {
    const r = clue.gate("Phones up, the clue just landed and the clock is unimpressed");
    expect(r.ok && r.item.text).toBe("Phones up, the clue just landed and the clock is unimpressed.");
    expect(r.ok && r.item.cue).toBe("clue");
  });
  it("rejects deliberation dressed up as a line", () => {
    expect(clue.gate("I'll produce one line for this moment.").ok).toBe(false);
    expect(clue.gate("Option A is about the clock, option B roasts the room.").ok).toBe(false);
  });
  it("rejects lines that are too short or too long to land out loud", () => {
    expect(clue.gate("Go now").ok).toBe(false);
    expect(clue.gate(new Array(40).fill("word").join(" ")).ok).toBe(false);
  });
});

describe("sentinel extraction", () => {
  it("reads the block out of the answer channel and ignores the deliberation", () => {
    const text = `Let me think about this.\n<<<CARD>>>\n${JSON.stringify(goodCard)}\n<<<END>>>\nThat works.`;
    const r = payloadFromCompletion(sayLessCards, text, "");
    expect(r.ok).toBe(true);
  });

  it("reads the block out of the thinking channel when content is empty", () => {
    const text = `<<<CARD>>>\n${JSON.stringify(goodCard)}\n<<<END>>>`;
    expect(payloadFromCompletion(sayLessCards, "", text).ok).toBe(true);
  });

  it("returns no_block when the model never closed one", () => {
    const r = payloadFromCompletion(sayLessCards, JSON.stringify(goodCard), "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_block");
  });

  it("survives a code-fenced block — local models sprinkle those in", () => {
    const text = "<<<CARD>>>\n```json\n" + JSON.stringify(goodCard) + "\n```\n<<<END>>>";
    expect(payloadFromCompletion(sayLessCards, text, "").ok).toBe(true);
  });
});

describe("generation", () => {
  it("accepts a card the model wrapped properly", async () => {
    const r = await generateOne(sayLessCards, cfg(), { seed: 1, avoid: [] }, fakeModel([goodCard]));
    expect(r.ok).toBe(true);
  });

  it("refuses a truncated completion — it cannot have closed a block", async () => {
    const r = await generateOne(sayLessCards, cfg(), { seed: 1, avoid: [] }, fakeModel([goodCard], { finish: "length" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe("truncated");
  });

  it("reports a gate failure with its reason instead of swallowing it", async () => {
    const bad = { ...goodCard, forbidden: ["guitar", "pretend", "rock"] };
    const r = await generateOne(sayLessCards, cfg(), { seed: 1, avoid: [] }, fakeModel([bad]));
    expect(r.ok).toBe(false);
    if (!r.ok && r.failure.kind === "gated") expect(r.failure.reason).toContain("unplayable");
    else expect.fail("expected a gate rejection");
  });

  it("stops at the wanted count and records duplicates as rejections", async () => {
    // The model repeats itself; only the first copy can be accepted.
    const res = await generateBatch(sayLessCards, cfg(), 3, {
      fetcher: fakeModel([goodCard]),
      maxAttempts: 4,
    });
    expect(res.accepted).toHaveLength(1);
    expect(res.rejected.every((r) => r.failure.kind === "duplicate")).toBe(true);
  });

  it("honours the avoid list from existing packs", async () => {
    const res = await generateBatch(sayLessCards, cfg(), 1, {
      fetcher: fakeModel([goodCard]),
      avoid: ["air guitar"],
      maxAttempts: 2,
    });
    expect(res.accepted).toHaveLength(0);
  });

  it("works when the model puts everything in the thinking channel", async () => {
    const r = await generateOne(sayLessCards, cfg(), { seed: 1, avoid: [] }, fakeModel([goodCard], { thinking: true }));
    expect(r.ok).toBe(true);
  });

  it("fails clearly without an API key rather than calling anything", async () => {
    const r = await generateOne(sayLessCards, cfg({ apiKey: undefined }), { seed: 1, avoid: [] }, fakeModel([goodCard]));
    expect(r.ok).toBe(false);
  });
});

describe("packs — additive, versioned, never overwritten", () => {
  const card = (secret: string): Card => {
    const r = sayLessCards.gate({ ...goodCard, secret });
    if (!r.ok) throw new Error(r.reason);
    return r.item;
  };

  it("numbers packs in sequence and never touches an earlier one", () => {
    const base = mkdtempSync(join(tmpdir(), "gww-packs-"));
    const first = writePack(sayLessCards, [card("Karaoke")], "muse-local:latest", base);
    expect(first.file).toContain("pack-001.json");
    const before = readFileSync(first.file, "utf8");

    const second = writePack(sayLessCards, [card("Leftovers")], "gemma4", base);
    expect(second.file).toContain("pack-002.json");
    // The earlier pack is byte-for-byte untouched.
    expect(readFileSync(first.file, "utf8")).toBe(before);
    expect(listPacks(sayLessCards.id, base)).toHaveLength(2);
  });

  it("stamps provenance so a bad batch is traceable to its model and prompt", () => {
    const base = mkdtempSync(join(tmpdir(), "gww-packs-"));
    const { file } = writePack(sayLessCards, [card("Karaoke")], "gemma4", base);
    const pack = JSON.parse(readFileSync(file, "utf8")) as { provenance: Record<string, string> };
    expect(pack.provenance.model).toBe("gemma4");
    expect(pack.provenance.specId).toBe("say-less-cards");
    expect(pack.provenance.specVersion).toBe("1");
    expect(pack.provenance.promptHash).toMatch(/^[a-f0-9]{12}$/);
    expect(Date.parse(pack.provenance.generatedAt!)).not.toBeNaN();
  });

  it("reads every pack back in order and reports the keys to avoid", () => {
    const base = mkdtempSync(join(tmpdir(), "gww-packs-"));
    writePack(sayLessCards, [card("Karaoke")], "m", base);
    writePack(sayLessCards, [card("Leftovers")], "m", base);
    expect(readPackItems<Card>(sayLessCards.id, base)).toHaveLength(2);
    expect(existingKeys(sayLessCards, base).sort()).toEqual(["karaoke", "leftovers"]);
  });

  it("reports no packs for an untouched tree instead of throwing", () => {
    const base = join(mkdtempSync(join(tmpdir(), "gww-packs-")), "nothing-here");
    expect(existsSync(base)).toBe(false);
    expect(listPacks(sayLessCards.id, base)).toEqual([]);
    expect(readPackItems(sayLessCards.id, base)).toEqual([]);
  });
});

describe("deck assembly", () => {
  it("keeps the hand-authored starter deck as the floor and appends packs", () => {
    const base = mkdtempSync(join(tmpdir(), "gww-packs-"));
    const starterOnly = loadDeck(base);
    expect(starterOnly.length).toBeGreaterThan(0);

    const r = sayLessCards.gate({ ...goodCard, secret: "Karaoke" });
    if (!r.ok) throw new Error(r.reason);
    writePack(sayLessCards, [r.item], "m", base);

    const merged = loadDeck(base);
    // Karaoke is already a starter card — the pack copy must not shadow it.
    expect(merged).toHaveLength(starterOnly.length);
    expect(merged.filter((c) => c.secret.toLowerCase() === "karaoke")).toHaveLength(1);
    expect(merged.slice(0, starterOnly.length).map((c) => c.id)).toEqual(starterOnly.map((c) => c.id));
  });

  it("grows the deck with genuinely new cards", () => {
    const base = mkdtempSync(join(tmpdir(), "gww-packs-"));
    const n = loadDeck(base).length;
    const fresh = ["Elevator silence", "Sock drawer", "Group photo"].map((s) => {
      const r = sayLessCards.gate({ ...goodCard, secret: s });
      if (!r.ok) throw new Error(r.reason);
      return r.item;
    });
    writePack(sayLessCards, fresh, "m", base);
    expect(loadDeck(base)).toHaveLength(n + 3);
  });
});
