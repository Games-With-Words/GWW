/**
 * The pipeline, with a fake Muse and a controllable clock.
 *
 * With autopublish ON there is no human between the model and a permanent URL on
 * our domain, so this file exists to prove the three gates hold: the quality
 * check, the novelty check, and the cadence. The cadence tests matter most —
 * they are the difference between a blog and a firehose, and they are the part
 * that cannot be verified by looking at one post.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BlogService, blogConfigFromEnv, checkPost, findDraft, draftSystemPrompt,
  DEFAULT_TOPICS, type BlogConfig, type DraftFields,
} from "../src/blog/service.js";

const GOOD_BODY = `An opening paragraph that answers the question immediately and does not warm up at all.

## The first real section

${"Something specific and usable about running a game night with six people. ".repeat(20)}

## The second real section

${"A different specific thing, with a number and a fix in it, about word games. ".repeat(20)}`;

function fields(over: Partial<DraftFields> = {}): DraftFields {
  return {
    title: "How to Host a Game Night That Works",
    slug: "how-to-host-a-game-night-that-works",
    description: "Game nights fail in the minutes before the first round starts. Here are the fixes for the part of the evening nobody plans.",
    keywords: ["game night", "party games"],
    body: GOOD_BODY,
    ...over,
  };
}

/** A completion shaped the way Muse actually replies: thinking, then blocks. */
function completion(f: DraftFields = fields()): string {
  return `Let me think about the angle here. Maybe the setup problem... yes, that one.

<<<TITLE>>>
${f.title}
<<<END>>>

<<<SLUG>>>
${f.slug}
<<<END>>>

<<<DESCRIPTION>>>
${f.description}
<<<END>>>

<<<KEYWORDS>>>
${f.keywords.join(", ")}
<<<END>>>

<<<BODY>>>
${f.body}
<<<END>>>`;
}

function jsonResponse(content: string): Response {
  return {
    ok: true,
    headers: { get: () => "application/json" },
    json: async () => ({ choices: [{ finish_reason: "stop", message: { content } }] }),
  } as unknown as Response;
}

function config(over: Partial<BlogConfig> = {}): BlogConfig {
  return {
    ...blogConfigFromEnv({} as NodeJS.ProcessEnv),
    dir: mkdtempSync(join(tmpdir(), "gww-blogsvc-")),
    apiKey: "test-key",
    adminToken: "secret",
    ...over,
  };
}

/** A service whose clock is a variable and whose Muse is a function. */
function svc(over: Partial<BlogConfig> = {}, reply: () => Response = () => jsonResponse(completion())) {
  // 10:00 local on a Tuesday — inside working hours, so the cadence is not
  // accidentally the thing under test in every case below.
  const clock = { t: new Date(2026, 7, 25, 10, 0, 0).getTime() };
  const calls: string[] = [];
  const service = new BlogService(
    config(over),
    (async (_url: string, init?: RequestInit) => {
      calls.push(String(init?.body ?? ""));
      return reply();
    }) as unknown as typeof fetch,
    () => clock.t,
  );
  return { service, clock, calls };
}

describe("parsing what Muse wrote", () => {
  it("reads five sentinel blocks out of a reply full of deliberation", () => {
    const draft = findDraft(completion(), "");
    expect("missing" in draft).toBe(false);
    expect((draft as DraftFields).title).toBe("How to Host a Game Night That Works");
    expect((draft as DraftFields).keywords).toEqual(["game night", "party games"]);
  });

  it("finds the blocks in the THINKING channel too — muse answers from either", () => {
    const draft = findDraft("", completion());
    expect("missing" in draft).toBe(false);
  });

  it("names exactly which blocks are missing", () => {
    const partial = `<<<TITLE>>>\nA Title Long Enough Here\n<<<END>>>`;
    const draft = findDraft(partial, "");
    expect((draft as { missing: string[] }).missing).toEqual(["SLUG", "DESCRIPTION", "KEYWORDS", "BODY"]);
  });

  it("re-slugifies a slug block that arrived as a sentence", () => {
    const draft = findDraft(completion(fields({ slug: "How To Host A Game Night!" })), "");
    expect((draft as DraftFields).slug).toBe("how-to-host-a-game-night");
  });

  it("strips the quotation marks a model wraps a title in", () => {
    const draft = findDraft(completion(fields({ title: '"How to Host a Game Night"' })), "");
    expect((draft as DraftFields).title).toBe("How to Host a Game Night");
  });
});

describe("the quality gate", () => {
  const limits = { minWords: 500, maxWords: 1400 };

  it("passes a real post", () => {
    expect(checkPost(fields(), limits)).toEqual({ ok: true });
  });

  it("refuses a thin post", () => {
    const r = checkPost(fields({ body: "## A\n\nShort.\n\n## B\n\nAlso short." }), limits);
    expect(r).toMatchObject({ ok: false, reason: "TOO_SHORT" });
  });

  it("refuses a wall of text with no subheadings", () => {
    // Long enough to pass the word floor — otherwise TOO_SHORT fires first and
    // the structure rule is never reached.
    const r = checkPost(fields({ body: "A paragraph about party games. ".repeat(120) }), limits);
    expect(r).toMatchObject({ ok: false, reason: "NO_STRUCTURE" });
  });

  it("refuses a description that would be truncated, and one that is a title restated", () => {
    expect(checkPost(fields({ description: "x".repeat(200) }), limits)).toMatchObject({ reason: "DESCRIPTION_LENGTH" });
    expect(checkPost(fields({ description: "Party games." }), limits)).toMatchObject({ reason: "DESCRIPTION_LENGTH" });
  });

  it("refuses a title too long for a search result", () => {
    expect(checkPost(fields({ title: "How to Host ".repeat(10) }), limits)).toMatchObject({ reason: "TITLE_TOO_LONG" });
  });

  it("catches the model tells", () => {
    for (const tell of ["As an AI language model, I", "In today's fast-paced world,", "Let's delve into"]) {
      const r = checkPost(fields({ body: `${tell} something.\n\n${GOOD_BODY}` }), limits);
      expect(r, tell).toMatchObject({ ok: false, reason: "MODEL_TELL" });
    }
  });

  it("catches a post that drifted off the subject entirely", () => {
    const offTopic = `Tomatoes need sun.\n\n## Soil\n\n${"Compost matters for tomatoes and peppers alike. ".repeat(45)}\n\n## Water\n\n${"Deep watering beats frequent sprinkling for roots. ".repeat(45)}`;
    // Title and description drift too: the gate reads all three on purpose,
    // because a post titled about game night IS about game night.
    const drifted = fields({
      title: "Growing Tomatoes in a Small Backyard",
      description: "Everything about soil, sun and water for a first-time backyard tomato bed that actually produces fruit.",
      body: offTopic,
    });
    expect(checkPost(drifted, limits)).toMatchObject({ ok: false, reason: "OFF_SUBJECT" });
  });

  it("refuses raw HTML in the body — the renderer escapes it, but it reads as code", () => {
    expect(checkPost(fields({ body: `<div>x</div>\n\n${GOOD_BODY}` }), limits)).toMatchObject({ reason: "MARKUP" });
  });

  it("refuses a post with no keywords", () => {
    expect(checkPost(fields({ keywords: [] }), limits)).toMatchObject({ reason: "NO_KEYWORDS" });
  });
});

describe("writing a post end to end", () => {
  it("publishes when everything agrees, and serves it immediately", async () => {
    const { service } = svc();
    const r = await service.writeOnce();
    expect(r.status).toBe("ok");
    const post = service.store.published(r.slug!)!;
    expect(post.source).toBe("muse");
    expect(post.status).toBe("published");
    expect(post.topic).toBe(DEFAULT_TOPICS[0]);
  });

  it("DRAFTS instead of publishing when GO LIVE is off", async () => {
    const { service } = svc({ autopublish: false });
    const r = await service.writeOnce();
    expect(r.status).toBe("drafted");
    expect(service.store.published(r.slug!)).toBeUndefined();
    expect(service.store.count("draft")).toBe(1);
  });

  it("refuses to write the same post twice", async () => {
    const { service } = svc({ minGapMin: 0, jitterMin: 0 });
    expect((await service.writeOnce()).status).toBe("ok");
    // Same completion, so same slug and title: the store must refuse it.
    expect((await service.writeOnce()).status).toBe("duplicate");
    expect(service.store.count()).toBe(1);
  });

  it("keeps a rejected draft out of the store entirely", async () => {
    const { service } = svc({}, () => jsonResponse(completion(fields({ body: "## A\n\ntiny\n\n## B\n\ntiny" }))));
    const r = await service.writeOnce();
    expect(r.status).toBe("gate_rejected");
    expect(r.detail).toMatch(/TOO_SHORT/);
    expect(service.store.count()).toBe(0);
  });

  it("reports a missing block instead of publishing a fragment", async () => {
    const { service } = svc({}, () => jsonResponse("<<<TITLE>>>\nJust a title here now\n<<<END>>>"));
    expect((await service.writeOnce()).status).toBe("no_blocks");
    expect(service.store.count()).toBe(0);
  });

  it("refuses a truncated completion", async () => {
    const { service } = svc({}, () => ({
      ok: true,
      headers: { get: () => "application/json" },
      json: async () => ({ choices: [{ finish_reason: "length", message: { content: completion() } }] }),
    } as unknown as Response));
    expect((await service.writeOnce()).status).toBe("truncated");
  });

  it("survives an HTTP failure and a thrown fetch without crashing", async () => {
    const bad = svc({}, () => ({ ok: false, status: 502, headers: { get: () => "" } } as unknown as Response));
    expect((await bad.service.writeOnce()).status).toBe("request_failed");

    const thrower = new BlogService(
      config(),
      (() => { throw new Error("socket hang up"); }) as unknown as typeof fetch,
    );
    const r = await thrower.writeOnce();
    expect(r.status).toBe("threw");
    expect(r.detail).toBe("socket hang up");
  });

  it("writes nothing at all without a key", async () => {
    const { service } = svc({ apiKey: undefined });
    expect((await service.writeOnce()).status).toBe("no_key");
  });

  it("writes nothing when disabled", async () => {
    const { service } = svc({ enabled: false });
    expect((await service.writeOnce()).status).toBe("disabled");
  });

  it("tells Muse what has already been published, so she picks a new angle", async () => {
    const { service, calls } = svc({ minGapMin: 0, jitterMin: 0 });
    await service.writeOnce();
    await service.writeOnce();
    expect(calls[1]).toContain("How to Host a Game Night That Works");
  });
});

describe("the cadence — the difference between a blog and a firehose", () => {
  it("stops at the daily cap even if the interval keeps firing", async () => {
    // Each attempt returns a DIFFERENT post, so only the cap can stop it.
    let n = 0;
    const { service } = svc({ dailyMax: 3, minGapMin: 0, jitterMin: 0 }, () => {
      n += 1;
      // Genuinely DIFFERENT titles. The first version of this test numbered
      // one title ("...Advice Number 1/2/3"), and the store refused every one
      // after the first as a near-duplicate — correctly. Only the cap should be
      // what stops the loop here.
      const subjects = [
        ["Seating Six People Around One Television", "seating-six-people-around-one-television"],
        ["Teaching Rules Without Losing the Room", "teaching-rules-without-losing-the-room"],
        ["Short Rounds Beat Long Evenings", "short-rounds-beat-long-evenings"],
        ["When a Player Has to Leave Early", "when-a-player-has-to-leave-early"],
        ["Choosing Who Goes First Fairly", "choosing-who-goes-first-fairly"],
        ["Playing With Relatives You Just Met", "playing-with-relatives-you-just-met"],
        ["A Phone at Four Percent Battery", "a-phone-at-four-percent-battery"],
      ];
      const [title, slug] = subjects[(n - 1) % subjects.length]!;
      return jsonResponse(completion(fields({ title: title!, slug: slug! })));
    });
    for (let i = 0; i < 6; i++) await service.writeOnce();
    expect(service.store.count("published")).toBe(3);
    expect((await service.writeOnce()).status).toBe("daily_max");
  });

  it("enforces a minimum gap between posts", async () => {
    const { service, clock } = svc({ minGapMin: 150, jitterMin: 0 });
    expect((await service.writeOnce()).status).toBe("ok");
    clock.t += 60 * 60_000; // one hour later
    expect((await service.writeOnce()).status).toBe("too_soon");
    clock.t += 100 * 60_000; // now past the gap
    expect(service.publishGate().ok).toBe(true);
  });

  it("never publishes in the middle of the night", async () => {
    const { service, clock } = svc({ hours: [8, 23] });
    clock.t = new Date(2026, 7, 25, 3, 30).getTime();
    const r = await service.writeOnce();
    expect(r.status).toBe("quiet_hours");
    // And it did not spend a completion to find that out.
    expect(service.store.count()).toBe(0);
  });

  it("adds jitter, so two posts are never the same distance apart", () => {
    const { service } = svc({ minGapMin: 60, jitterMin: 45 });
    const jitters = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const s = svc({ minGapMin: 60, jitterMin: 45 }).service;
      jitters.add(s.status()["jitterMinutes"] as number);
    }
    // 40 rolls over a 45-minute window: all identical means jitter is a no-op.
    expect(jitters.size).toBeGreaterThan(3);
    expect(service.status()["jitterMinutes"] as number).toBeLessThanOrEqual(45);
  });

  it("drafts rather than discards when the cadence blocks a finished post", async () => {
    // Autopublish off means the pre-flight gate does not apply, so a post is
    // written and kept. That draft is the backlog the tick later releases.
    const { service } = svc({ autopublish: false });
    await service.writeOnce();
    expect(service.store.count("draft")).toBe(1);
    const published = service.publish(service.store.list({ includeDrafts: true })[0]!.slug);
    expect(published?.status).toBe("published");
  });

  it("says out loud what is currently blocking publication", async () => {
    const { service } = svc({ minGapMin: 180, jitterMin: 0 });
    await service.writeOnce();
    const status = service.status();
    expect(status["canPublishNow"]).toBe(false);
    expect(String(status["blockedBy"])).toMatch(/too_soon/);
    expect(status["publishedToday"]).toBe(1);
  });
});

describe("the topic queue", () => {
  it("works through the queue instead of writing the same topic forever", async () => {
    const { service } = svc({ minGapMin: 0, jitterMin: 0, topics: ["topic one", "topic two", "topic three"] });
    expect(service.nextTopic()).toBe("topic one");
    expect(service.nextTopic()).toBe("topic two");
  });

  it("skips a topic that already has a post", async () => {
    const { service } = svc({ minGapMin: 0, jitterMin: 0, topics: ["alpha topic", "beta topic"] });
    await service.writeOnce(); // covers "alpha topic"
    expect(service.nextTopic()).toBe("beta topic");
  });

  it("accepts a topic on demand, for the write-about-this knob", async () => {
    const { service } = svc();
    const r = await service.writeOnce("something I specifically want");
    expect(service.store.get(r.slug!)?.topic).toBe("something I specifically want");
  });
});

describe("the knobs", () => {
  it("turns GO LIVE on and off at runtime", () => {
    const { service } = svc({ autopublish: false });
    expect(service.knobs.autopublish).toBe(false);
    service.tune({ autopublish: true });
    expect(service.knobs.autopublish).toBe(true);
  });

  it("applies the same floors the env parser does — the API cannot go below them", () => {
    const { service } = svc();
    service.tune({ intervalMin: 1, dailyMax: 0, minWords: 10 });
    expect(service.knobs.intervalMin).toBe(5);
    expect(service.knobs.dailyMax).toBe(1);
    expect(service.knobs.minWords).toBe(150);
  });

  it("ignores an empty topic list rather than emptying the queue", () => {
    const { service } = svc();
    const before = service.knobs.topics.length;
    service.tune({ topics: [] });
    expect(service.knobs.topics).toHaveLength(before);
  });

  it("reports only what it actually applied", () => {
    const { service } = svc();
    const applied = service.tune({ dailyMax: 5 });
    expect(applied).toEqual({ dailyMax: 5 });
  });

  it("authorizes only the exact bearer token, and nothing when none is set", () => {
    const { service } = svc({ adminToken: "s3cret" });
    expect(service.authorized("Bearer s3cret")).toBe(true);
    expect(service.authorized("Bearer wrong")).toBe(false);
    expect(service.authorized("s3cret")).toBe(false);
    expect(service.authorized(undefined)).toBe(false);
    // No token configured must CLOSE the API, not open it.
    expect(svc({ adminToken: undefined }).service.authorized("Bearer anything")).toBe(false);
  });

  it("does not leak the key or the token through the knobs view", () => {
    const { service } = svc();
    const json = JSON.stringify({ knobs: service.knobs, status: service.status() });
    expect(json).not.toContain("test-key");
    expect(json).not.toContain("secret");
  });
});

describe("configuration defaults", () => {
  const cfg = blogConfigFromEnv({} as NodeJS.ProcessEnv);

  it("ships human-like limits out of the box", () => {
    expect(cfg.autopublish).toBe(true);
    expect(cfg.dailyMax).toBe(3);
    expect(cfg.intervalMin).toBe(60);
    expect(cfg.minGapMin).toBeGreaterThanOrEqual(120);
    expect(cfg.jitterMin).toBeGreaterThan(0);
    expect(cfg.hours[0]).toBeGreaterThanOrEqual(6);
    expect(cfg.hours[1]).toBeLessThanOrEqual(23);
  });

  it("reads every knob from the environment", () => {
    const env = {
      GWW_BLOG_AUTOPUBLISH: "0",
      GWW_BLOG_DAILY_MAX: "7",
      GWW_BLOG_INTERVAL_MIN: "90",
      GWW_BLOG_TOPICS: "first topic|second topic",
      GWW_BLOG_HOUR_START: "9",
      GWW_BLOG_HOUR_END: "21",
    } as unknown as NodeJS.ProcessEnv;
    const c = blogConfigFromEnv(env);
    expect(c.autopublish).toBe(false);
    expect(c.dailyMax).toBe(7);
    expect(c.intervalMin).toBe(90);
    expect(c.topics).toEqual(["first topic", "second topic"]);
    expect(c.hours).toEqual([9, 21]);
  });

  it("ignores nonsense in the environment instead of publishing every 0 minutes", () => {
    const c = blogConfigFromEnv({ GWW_BLOG_INTERVAL_MIN: "banana", GWW_BLOG_DAILY_MAX: "0" } as unknown as NodeJS.ProcessEnv);
    expect(c.intervalMin).toBe(60);
    expect(c.dailyMax).toBe(1);
  });
});

describe("the prompt", () => {
  const prompt = draftSystemPrompt({ tone: "plain", minWords: 500, maxWords: 1400 });

  it("teaches all five blocks and the closing marker", () => {
    for (const tag of ["TITLE", "SLUG", "DESCRIPTION", "KEYWORDS", "BODY"]) {
      expect(prompt).toContain(`<<<${tag}>>>`);
    }
    expect(prompt).toContain("<<<END>>>");
  });

  it("states the real product facts, so Muse cannot invent features", () => {
    expect(prompt).toContain("Say Less");
    expect(prompt).toContain("Ghost Writer");
    expect(prompt).toContain("never invent");
    expect(prompt).toContain("500");
  });
});

/**
 * THE LIVE FAILURE, 2026-08-25.
 *
 * Every tick logged "missing SLUG, DESCRIPTION, KEYWORDS, BODY (content ~67
 * chars, thinking 0)". TITLE was never missing, because ~67 characters IS a
 * title block: the shared SSE reader hung up on the first `<<<END>>>`, which
 * is correct for a one-block voice line and destroys a five-block post.
 *
 * Behind it sat a second failure that the first one was hiding: the request
 * carried no token ceiling at all, and omitting it is not "unlimited" — it
 * hands the ceiling to PIN, whose schema default is 1024. A 500-to-1400 word
 * body does not fit in that, so the draft would have come back truncated the
 * moment the streaming stopped being cut short.
 */
describe("the request Muse actually receives", () => {
  it("names a token ceiling big enough for a whole post", () => {
    const { service, calls } = svc();
    void service.tick();
    const body = JSON.parse(calls[0] ?? "{}") as { max_tokens?: number; num_predict?: number };
    expect(body.max_tokens, "no max_tokens means PIN's 1024 default").toBeGreaterThanOrEqual(4096);
    // Ollama-family backends read num_predict; send both so the ceiling holds
    // whichever one is honoured.
    expect(body.num_predict).toBe(body.max_tokens);
  });

  it("is configurable, with a floor under it", () => {
    expect(blogConfigFromEnv({ GWW_BLOG_MAX_TOKENS: "9000" } as NodeJS.ProcessEnv).maxTokens).toBe(9000);
    // A ceiling too small to hold a post is the bug, so it cannot be set.
    expect(blogConfigFromEnv({ GWW_BLOG_MAX_TOKENS: "512" } as NodeJS.ProcessEnv).maxTokens).toBeGreaterThanOrEqual(2048);
    expect(blogConfigFromEnv({} as NodeJS.ProcessEnv).maxTokens).toBeGreaterThanOrEqual(4096);
  });

  it("reads a STREAMED post all the way to the last block", async () => {
    // The regression, end to end: the same five-block reply delivered as SSE.
    // Before the fix this produced a draft missing four blocks.
    const text = completion();
    const frames = text.match(/[\s\S]{1,40}/g) ?? [];
    const encoder = new TextEncoder();
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= frames.length) { c.enqueue(encoder.encode("data: [DONE]\n\n")); c.close(); return; }
        c.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: frames[i]! } }] })}\n\n`));
        i += 1;
      },
    });
    const { service } = svc({}, () => new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    await service.tick();
    // The proof is a post on disk. Before the fix this tick produced nothing
    // and logged "missing SLUG, DESCRIPTION, KEYWORDS, BODY".
    expect(service.store.count("published")).toBe(1);
    const post = service.store.list()[0]!;
    expect(post.title).toBe("How to Host a Game Night That Works");
    // BODY is the block furthest past the first <<<END>>>, so its presence is
    // what actually proves the reader stopped hanging up early.
    expect(post.body.length).toBeGreaterThan(400);
  });
});
