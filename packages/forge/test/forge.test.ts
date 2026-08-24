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

/** A card as FIELD BLOCK VALUES — plain text, exactly as the model writes it. */
const goodCard: Record<string, string> = {
  secret: "Air guitar",
  aliases: "air guitar solo",
  category: "Music",
  forbidden: "instrument\npretend\nrock\ninvisible",
  budget: "3",
  difficulty: "3",
  revealLine: "Zero strings attached.",
};

/** Render field values the way the sentinel lesson teaches. */
function asBlocks(f: Record<string, string>): string {
  return Object.entries(f).map(([k, v]) => `<<<FIELD ${k}>>>\n${v}\n<<<END>>>`).join("\n");
}

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
    const body = typeof p === "string"
      ? `<<<LINE>>>\n${p}\n<<<END>>>`
      : asBlocks(p as Record<string, string>);
    const text = `Weighing a few angles first.\n${body}`;
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
    const r = sayLessCards.gate({ ...goodCard, forbidden: "guitar\npretend\nrock" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("unplayable");
  });

  it("rejects a forbidden word hiding inside an alias", () => {
    const r = sayLessCards.gate({ ...goodCard, aliases: "karaoke night", forbidden: "karaoke\npretend\nrock" });
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
    expect(sayLessCards.gate({ ...goodCard, forbidden: "air travel\npretend\nrock" }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, forbidden: "one\ntwo" }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, forbidden: "a\nb\nc\nd\ne\nf" }).ok).toBe(false);
  });

  it("rejects out-of-range budget and difficulty", () => {
    expect(sayLessCards.gate({ ...goodCard, budget: "0" }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, budget: "9" }).ok).toBe(false);
    expect(sayLessCards.gate({ ...goodCard, difficulty: "5" }).ok).toBe(false);
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

describe("sentinel extraction — field blocks, nothing to parse", () => {
  it("reads the field blocks and ignores every word of deliberation", () => {
    const text = `Let me weigh a couple of angles first.\n${asBlocks(goodCard)}\nThat should land.`;
    const r = payloadFromCompletion(sayLessCards, text, "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.secret).toBe("Air guitar");
  });

  it("reads them out of the thinking channel when content is empty", () => {
    expect(payloadFromCompletion(sayLessCards, "", asBlocks(goodCard)).ok).toBe(true);
  });

  it("returns no_block when the model wrote values with no markers at all", () => {
    const r = payloadFromCompletion(sayLessCards, "secret: Air guitar, category: Music", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_block");
  });

  it("NAMES the missing field instead of failing with a parse error", () => {
    const { budget: _drop, ...partial } = goodCard;
    const r = payloadFromCompletion(sayLessCards, asBlocks(partial), "");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("incomplete");
      expect(r.missing).toEqual(["budget"]);
    }
  });

  it("lets a rewritten set replace an earlier one — the last block wins", () => {
    // The model changed its mind. Under a JSON payload this was the live
    // failure: a skeleton block first, the real answer second, first one read.
    const text = `${asBlocks({ ...goodCard, secret: "First attempt" })}\nactually, better:\n${asBlocks(goodCard)}`;
    const r = payloadFromCompletion(sayLessCards, text, "");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.secret).toBe("Air guitar");
  });

  it("names an unterminated block rather than blaming the content", () => {
    const r = payloadFromCompletion(sayLessCards, "<<<FIELD secret>>>\nAir guitar", "");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("unterminated");
  });

  it("falls through to thinking when the content blocks are incomplete", () => {
    const { budget: _d, ...partial } = goodCard;
    const r = payloadFromCompletion(sayLessCards, asBlocks(partial), asBlocks(goodCard));
    expect(r.ok).toBe(true);
  });

  it("survives the punctuation that used to shatter a JSON payload", () => {
    // Quotes, braces, apostrophes, commas — all harmless between markers now.
    const spicy = {
      ...goodCard,
      secret: "Mom's \"famous\" dip",
      revealLine: "It's {mostly} mayo, and nobody minds, truly.",
    };
    const r = payloadFromCompletion(sayLessCards, asBlocks(spicy), "");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.item.secret).toBe('Mom\'s "famous" dip');
      expect(r.item.revealLine).toBe("It's {mostly} mayo, and nobody minds, truly.");
    }
  });

  it("tolerates a model that bullets or quotes its multi-value lines", () => {
    const r = payloadFromCompletion(
      sayLessCards,
      asBlocks({ ...goodCard, forbidden: '- instrument\n* "pretend"\n- rock' }),
      "",
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.item.forbidden).toEqual(["instrument", "pretend", "rock"]);
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
    const bad = { ...goodCard, forbidden: "guitar\npretend\nrock" };
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

  it("puts the format reminder on the USER turn, where every model reads it", async () => {
    // gemma4:26b ignored a system-only lesson and replied in markdown.
    let seen: { role: string; content: string }[] = [];
    const spy = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = (JSON.parse(String(init?.body)) as { messages: typeof seen }).messages;
      return new Response(JSON.stringify({ choices: [{ message: { content: asBlocks(goodCard) } }] }), { status: 200 });
    }) as typeof fetch;
    await generateOne(sayLessCards, cfg(), { seed: 1, avoid: [] }, spy);
    const user = seen.find((m) => m.role === "user")!;
    expect(user.content).toContain("REQUIRED OUTPUT FORMAT");
    expect(user.content).toContain("<<<FIELD secret>>>");
    expect(user.content).toContain("ONE item only, not several");
  });

  it("corrects a model that answered in markdown instead of parsing its prose", async () => {
    const markdown = "*Secret:* Disco Ball\n*   Dance\n*   Mirror\n*Budget:* 4";
    let call = 0;
    const stubborn = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      call += 1;
      const msgs = (JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] }).messages;
      if (call === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: markdown } }] }), { status: 200 });
      }
      // The retry must replay the bad reply and demand the format again.
      expect(msgs.some((m) => m.role === "assistant" && m.content.includes("Disco Ball"))).toBe(true);
      expect(msgs[msgs.length - 1]!.content).toContain("not the required format");
      return new Response(JSON.stringify({ choices: [{ message: { content: asBlocks(goodCard) } }] }), { status: 200 });
    }) as typeof fetch;

    const res = await generateBatch(sayLessCards, cfg(), 1, { fetcher: stubborn, maxAttempts: 1 });
    expect(res.accepted).toHaveLength(1);
    expect(call).toBe(2);
  });

  it("gives up on a model that ignores the format twice — no markdown parsing", async () => {
    const markdown = "*Secret:* Disco Ball\n*   Dance";
    const hopeless = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: markdown } }] }), { status: 200 })) as typeof fetch;
    const res = await generateBatch(sayLessCards, cfg(), 1, { fetcher: hopeless, maxAttempts: 1 });
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected[0]!.failure.kind).toBe("no_block");
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
