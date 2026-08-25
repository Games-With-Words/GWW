/**
 * The SEO claims, asserted.
 *
 * Every check here is something a crawler actually reads, and every one of them
 * has a documented way of silently not working: a canonical pointing at the
 * wrong URL, a description over the truncation limit, JSON-LD that does not
 * parse, a sitemap in the wrong namespace. The sitemap namespace typo
 * (sitemap.org for sitemaps.org) shipped once already — a file that looks
 * perfect and is ignored entirely. Hence the exact-string assertion below.
 */

import { describe, expect, it } from "vitest";
import { renderIndex, renderPost, renderSitemap, renderFeed, renderMissing, SITE } from "../src/blog/render.js";
import type { Post } from "../src/blog/store.js";

function post(over: Partial<Post> = {}): Post {
  return {
    slug: "how-to-host-a-game-night",
    title: "How to Host a Game Night That Doesn't Die",
    description: "Game nights fail in the eleven minutes before the first round. Six fixes for the part of the evening nobody plans for.",
    body: "## First\n\nThe opening paragraph of the post.\n\n## Second\n\nAnother paragraph entirely.",
    topic: "how to host a game night",
    keywords: ["how to host a game night", "party games"],
    status: "published",
    createdAt: Date.UTC(2026, 7, 20),
    publishedAt: Date.UTC(2026, 7, 20),
    source: "hand",
    ...over,
  };
}

/** Every JSON-LD block on the page, parsed. Unparseable is a failure. */
function jsonLd(html: string): unknown[] {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  expect(blocks.length).toBeGreaterThan(0);
  return blocks.map((m) => JSON.parse(m[1]!) as unknown);
}

describe("a post page", () => {
  const html = renderPost(post(), [post({ slug: "word-games-for-groups", title: "Word Games for Groups" })]);

  it("is a complete document, not a fragment", () => {
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  it("puts the PROSE IN THE BODY — the whole point of rendering on the server", () => {
    expect(html).toContain("The opening paragraph of the post.");
    expect(html).toContain("<h2>First</h2>");
  });

  it("carries its own title, description and canonical — not the homepage's", () => {
    expect(html).toContain("<title>How to Host a Game Night That Doesn&#39;t Die — Games With Words</title>");
    expect(html).toContain(`<link rel="canonical" href="${SITE}/blog/how-to-host-a-game-night" />`);
    expect(html).toContain('<meta name="description" content="Game nights fail in the eleven minutes');
  });

  it("keeps the description inside the length search engines will show", () => {
    const match = /<meta name="description" content="([^"]*)"/.exec(html);
    expect(match).not.toBeNull();
    expect(match![1]!.length).toBeLessThanOrEqual(165);
    expect(match![1]!.length).toBeGreaterThanOrEqual(60);
  });

  it("declares itself an article to social scrapers", () => {
    expect(html).toContain('<meta property="og:type" content="article" />');
    expect(html).toContain('<meta property="article:published_time" content="2026-08-20T00:00:00.000Z" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain(`<meta property="og:image" content="${SITE}/og.jpg" />`);
  });

  it("emits BlogPosting and BreadcrumbList that PARSE", () => {
    const graph = jsonLd(html)[0] as { "@graph": { "@type": string; headline?: string }[] };
    const types = graph["@graph"].map((n) => n["@type"]);
    expect(types).toContain("BlogPosting");
    expect(types).toContain("BreadcrumbList");
    const posting = graph["@graph"].find((n) => n["@type"] === "BlogPosting")!;
    expect(posting.headline).toBe("How to Host a Game Night That Doesn't Die");
  });

  it("escapes the title everywhere it appears — including inside JSON-LD", () => {
    const html2 = renderPost(post({ title: 'A "Quoted" <b>Title</b>' }), []);
    expect(html2).not.toContain("<b>Title</b>");
    // JSON-LD is JSON, so quotes are escaped by the serializer, not by us.
    expect(() => jsonLd(html2)).not.toThrow();
  });

  it("links back to the game and out to other posts", () => {
    expect(html).toContain('class="cta" href="/"');
    expect(html).toContain('href="/blog/word-games-for-groups"');
  });

  it("omits the related section entirely when there is nothing to link", () => {
    expect(renderPost(post(), [])).not.toContain("Keep reading");
  });
});

describe("the index", () => {
  it("lists posts with dates and links, and declares a Blog", () => {
    const html = renderIndex([post(), post({ slug: "word-games-for-groups", title: "Word Games for Groups" })]);
    expect(html).toContain('href="/blog/how-to-host-a-game-night"');
    expect(html).toContain('href="/blog/word-games-for-groups"');
    expect(html).toContain("<time datetime=\"2026-08-20T00:00:00.000Z\">");
    const ld = jsonLd(html)[0] as { "@type": string; blogPost: unknown[] };
    expect(ld["@type"]).toBe("Blog");
    expect(ld.blogPost).toHaveLength(2);
  });

  it("says so honestly when there are no posts", () => {
    const html = renderIndex([]);
    expect(html).toContain("No posts yet");
    expect(() => jsonLd(html)).not.toThrow();
  });
});

describe("sitemap.xml", () => {
  const xml = renderSitemap([post(), post({ slug: "word-games-for-groups" })]);

  it("uses the namespace that is actually the namespace", () => {
    // sitemap.org (no S) parses as valid XML and is silently ignored. Exact string.
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
  });

  it("lists the homepage, the blog index, and every post", () => {
    expect(xml).toContain(`<loc>${SITE}/</loc>`);
    expect(xml).toContain(`<loc>${SITE}/blog</loc>`);
    expect(xml).toContain(`<loc>${SITE}/blog/how-to-host-a-game-night</loc>`);
    expect(xml).toContain(`<loc>${SITE}/blog/word-games-for-groups</loc>`);
  });

  it("dates the posts and never a drafts URL", () => {
    expect(xml).toContain("<lastmod>2026-08-20</lastmod>");
    expect(xml).not.toContain("draft");
  });

  it("is a single well-formed document with matching url counts", () => {
    expect((xml.match(/<url>/g) ?? []).length).toBe((xml.match(/<\/url>/g) ?? []).length);
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe("feed.xml", () => {
  it("is RSS with items that carry permalinks and RFC dates", () => {
    const xml = renderFeed([post()]);
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain(`<guid isPermaLink="true">${SITE}/blog/how-to-host-a-game-night</guid>`);
    expect(xml).toContain("<pubDate>Thu, 20 Aug 2026 00:00:00 GMT</pubDate>");
  });

  it("escapes a title containing an ampersand rather than breaking the XML", () => {
    const xml = renderFeed([post({ title: "Cards & Words" })]);
    expect(xml).toContain("Cards &amp; Words");
  });
});

describe("the 404", () => {
  it("is a real page and does not claim to be the blog index", () => {
    const html = renderMissing();
    expect(html).toContain("Nothing here");
    expect(html).toContain('href="/blog"');
  });
});
