/**
 * The blog over real HTTP, through the real gateway.
 *
 * Every assertion here is one a crawler makes: the status code, the content
 * type, whether the prose is in the body. It runs against a listening server
 * rather than calling the renderers directly, because the failure this file
 * exists to prevent is a ROUTING failure — the SPA fallback answering /blog
 * with the arcade's index.html. That is a 200 containing a game lobby, which
 * looks fine in a browser and is indexed as a duplicate of the homepage.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGateway, type Gateway } from "../src/gateway.js";
import { BlogService, blogConfigFromEnv } from "../src/blog/service.js";
import { VoiceService, voiceConfigFromEnv } from "../src/voice.js";
import type { Post } from "../src/blog/store.js";

const TOKEN = "test-admin-token";
let gw: Gateway;
let base: string;
let blog: BlogService;

function post(over: Partial<Post> = {}): Post {
  return {
    slug: "how-to-host-a-game-night",
    title: "How to Host a Game Night That Doesn't Die",
    description: "Game nights fail in the eleven minutes before the first round. Six fixes for the part of the evening nobody plans for.",
    body: "## First\n\nA real paragraph of prose that a crawler must be able to read.\n\n## Second\n\nAnother one.",
    topic: "how to host a game night",
    keywords: ["game night"],
    status: "published",
    createdAt: Date.UTC(2026, 7, 20),
    publishedAt: Date.UTC(2026, 7, 20),
    source: "hand",
    ...over,
  };
}

beforeAll(async () => {
  blog = new BlogService({
    ...blogConfigFromEnv({} as NodeJS.ProcessEnv),
    dir: mkdtempSync(join(tmpdir(), "gww-blogroutes-")),
    apiKey: undefined,          // nothing is generated during this suite
    adminToken: TOKEN,
    enabled: false,
  });
  blog.store.save(post());
  blog.store.save(post({ slug: "a-secret-draft-post", title: "A Draft Nobody Should See", status: "draft", publishedAt: undefined }));

  gw = createGateway({
    blog,
    voice: new VoiceService({ ...voiceConfigFromEnv(), cacheDir: mkdtempSync(join(tmpdir(), "gww-voice-")) }),
  });
  const port = await gw.listen(0, "127.0.0.1");
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => { await gw.close(); });

const get = (path: string): Promise<Response> => fetch(`${base}${path}`);
const admin = (path: string, body?: unknown, token = TOKEN): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("public pages", () => {
  it("serves the blog index as HTML, not as the app shell", async () => {
    const res = await get("/blog");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("The Blog");
    expect(html).toContain("how-to-host-a-game-night");
    // The tell of the SPA fallback having answered instead.
    expect(html).not.toContain('id="app"');
  });

  it("serves a post with its prose in the response body", async () => {
    const html = await (await get("/blog/how-to-host-a-game-night")).text();
    expect(html).toContain("A real paragraph of prose that a crawler must be able to read.");
    expect(html).toContain("<h2>First</h2>");
    expect(html).toContain('<link rel="canonical" href="https://games-with-words.com/blog/how-to-host-a-game-night" />');
  });

  it("treats a trailing slash as the same page", async () => {
    expect((await get("/blog/")).status).toBe(200);
    expect((await get("/blog/how-to-host-a-game-night/")).status).toBe(200);
  });

  it("404s an unknown post — a real status, not a soft 404", async () => {
    const res = await get("/blog/no-such-post-exists");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("Nothing here");
  });

  it("NEVER serves a draft, by any route", async () => {
    expect((await get("/blog/a-secret-draft-post")).status).toBe(404);
    const index = await (await get("/blog")).text();
    expect(index).not.toContain("A Draft Nobody Should See");
    const sitemap = await (await get("/sitemap.xml")).text();
    expect(sitemap).not.toContain("a-secret-draft-post");
    const feed = await (await get("/feed.xml")).text();
    expect(feed).not.toContain("a-secret-draft-post");
  });

  it("generates sitemap.xml, overriding the static file of the same name", async () => {
    const res = await get("/sitemap.xml");
    expect(res.headers.get("content-type")).toContain("xml");
    const xml = await res.text();
    expect(xml).toContain("http://www.sitemaps.org/schemas/sitemap/0.9");
    expect(xml).toContain("<loc>https://games-with-words.com/blog/how-to-host-a-game-night</loc>");
  });

  it("serves the feed as RSS", async () => {
    const res = await get("/feed.xml");
    expect(res.headers.get("content-type")).toContain("rss");
    expect(await res.text()).toContain("<rss version=\"2.0\"");
  });
});

describe("the knobs API", () => {
  it("refuses every route without the token", async () => {
    for (const path of ["/api/blog/golive", "/api/blog/knobs", "/api/blog/write", "/api/blog/publish"]) {
      const res = await admin(path, {}, "wrong-token");
      expect(res.status, path).toBe(401);
    }
    expect((await fetch(`${base}/api/blog/status`)).status).toBe(401);
  });

  it("reports status, including what is blocking publication", async () => {
    const res = await fetch(`${base}/api/blog/status`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body["published"]).toBe(1);
    expect(body["drafts"]).toBe(1);
    expect(body["knobs"]).toBeTypeOf("object");
    // The secret must not travel, even to an authorized caller.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("lists posts including drafts, for the operator's view", async () => {
    const res = await fetch(`${base}/api/blog/posts`, { headers: { authorization: `Bearer ${TOKEN}` } });
    const body = await res.json() as { posts: { slug: string; status: string; url: string | null }[] };
    expect(body.posts).toHaveLength(2);
    const draft = body.posts.find((p) => p.slug === "a-secret-draft-post")!;
    expect(draft.status).toBe("draft");
    expect(draft.url).toBeNull();
  });

  it("flips GO LIVE", async () => {
    const off = await (await admin("/api/blog/golive", { on: false })).json() as { autopublish: boolean };
    expect(off.autopublish).toBe(false);
    expect(blog.knobs.autopublish).toBe(false);
    const on = await (await admin("/api/blog/golive", { on: true })).json() as { autopublish: boolean };
    expect(on.autopublish).toBe(true);
    // GO LIVE also lifts the master switch — a live blog with the engine off
    // would report "autopublish: true" and never write anything.
    expect(blog.knobs.enabled).toBe(true);
  });

  it("tunes a knob and reports what it applied", async () => {
    const body = await (await admin("/api/blog/knobs", { dailyMax: 4, nonsense: 1 })).json() as { applied: Record<string, unknown> };
    expect(body.applied).toEqual({ dailyMax: 4 });
    expect(blog.knobs.dailyMax).toBe(4);
  });

  it("publishes and unpublishes a post by hand", async () => {
    const pub = await (await admin("/api/blog/publish", { slug: "a-secret-draft-post" })).json() as { status: string };
    expect(pub.status).toBe("published");
    expect((await get("/blog/a-secret-draft-post")).status).toBe(200);

    await admin("/api/blog/unpublish", { slug: "a-secret-draft-post" });
    expect((await get("/blog/a-secret-draft-post")).status).toBe(404);
  });

  it("404s a publish for a post that does not exist", async () => {
    expect((await admin("/api/blog/publish", { slug: "nope-not-here" })).status).toBe(404);
  });

  it("refuses an unknown blog route rather than falling through to the app", async () => {
    expect((await admin("/api/blog/whatever", {})).status).toBe(404);
  });
});

describe("the game is untouched", () => {
  it("still answers /health and /api/games with the blog mounted", async () => {
    expect((await get("/health")).status).toBe(200);
    const games = await (await get("/api/games")).json() as { games: unknown[] };
    expect(games.games.length).toBeGreaterThanOrEqual(2);
  });
});
