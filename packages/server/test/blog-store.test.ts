/**
 * The store's real job: refusing posts.
 *
 * Persistence is easy to get right and easy to test. The interesting behaviour
 * is the refusal set — because with autopublish on, the store is the only thing
 * standing between "the model drafted this topic again" and two near-identical
 * URLs competing with each other on our own domain.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BlogStore, slugify, isValidSlug, titleSimilarity, readingMinutes, firstSentence, type Post,
} from "../src/blog/store.js";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "gww-blog-"));
}

function post(over: Partial<Post> = {}): Post {
  return {
    slug: "a-real-slug-here",
    title: "A Real Title About Party Games",
    description: "A description long enough to be a real meta description for a real post about games.",
    body: "## One\n\nWords.\n\n## Two\n\nMore words.",
    topic: "party games",
    keywords: ["party games"],
    status: "published",
    createdAt: 1_000,
    publishedAt: 1_000,
    source: "hand",
    ...over,
  };
}

describe("slugs", () => {
  it("makes a permalink out of a headline", () => {
    expect(slugify("How to Host a Game Night That Doesn't Die!")).toBe("how-to-host-a-game-night-that-doesnt-die");
  });

  it("never ends in a hyphen, even when truncation lands on one", () => {
    const s = slugify("a ".repeat(60) + "word");
    expect(s.endsWith("-")).toBe(false);
    expect(s.length).toBeLessThanOrEqual(72);
  });

  it("refuses a single word, a path traversal, and anything with a dot", () => {
    expect(isValidSlug("word")).toBe(false);
    expect(isValidSlug("../../etc/passwd")).toBe(false);
    expect(isValidSlug("posts.json")).toBe(false);
    expect(isValidSlug("two-words")).toBe(true);
  });
});

describe("near-duplicate detection", () => {
  it("catches the same title in a different word order", () => {
    const a = "Word Games for Groups of Friends";
    const b = "Games With Words for Groups of Friends";
    expect(titleSimilarity(a, b)).toBeGreaterThanOrEqual(0.8);
  });

  it("does not flag two genuinely different posts", () => {
    const sim = titleSimilarity(
      "How to Host a Game Night That Doesn't Die",
      "What Makes a Word Game Funny",
    );
    expect(sim).toBeLessThan(0.5);
  });

  it("survives a title made entirely of stop words", () => {
    expect(titleSimilarity("the and for", "you how why")).toBe(0);
  });
});

describe("BlogStore", () => {
  let store: BlogStore;
  beforeEach(() => { store = new BlogStore(dir()); });

  it("round-trips a post to disk and back", () => {
    const d = dir();
    new BlogStore(d).save(post());
    const reopened = new BlogStore(d);
    expect(reopened.get("a-real-slug-here")?.title).toBe("A Real Title About Party Games");
  });

  it("skips an unreadable file instead of failing to boot", () => {
    const d = dir();
    writeFileSync(join(d, "broken.json"), "{ not json");
    new BlogStore(d).save(post());
    expect(new BlogStore(d).count()).toBe(1);
  });

  it("hides drafts from the public list", () => {
    store.save(post({ slug: "published-post-here" }));
    store.save(post({ slug: "draft-post-here", status: "draft", publishedAt: undefined }));
    expect(store.list().map((p) => p.slug)).toEqual(["published-post-here"]);
    expect(store.list({ includeDrafts: true })).toHaveLength(2);
    expect(store.published("draft-post-here")).toBeUndefined();
  });

  it("orders newest first", () => {
    store.save(post({ slug: "older-post-here", publishedAt: 100 }));
    store.save(post({ slug: "newer-post-here", publishedAt: 900 }));
    expect(store.list()[0]!.slug).toBe("newer-post-here");
  });

  it("refuses a duplicate slug", () => {
    store.save(post({ slug: "how-to-host-a-game-night" }));
    expect(store.refuse({ slug: "how-to-host-a-game-night", title: "Completely Unrelated Headline" }))
      .toMatch(/duplicate_slug/);
  });

  it("refuses a near-duplicate title under a different slug", () => {
    store.save(post({ slug: "word-games-for-groups", title: "Word Games for Groups of Friends" }));
    const refusal = store.refuse({ slug: "games-with-words-for-groups", title: "Games With Words for Groups of Friends" });
    expect(refusal).toMatch(/near_duplicate_title/);
  });

  it("refuses a malformed slug before it can become a URL", () => {
    expect(store.refuse({ slug: "../secrets", title: "Anything At All Here" })).toMatch(/bad_slug/);
  });

  it("accepts a genuinely new post", () => {
    store.save(post({ slug: "how-to-host-a-game-night", title: "How to Host a Game Night" }));
    expect(store.refuse({ slug: "what-makes-a-word-game-funny", title: "What Makes a Word Game Funny" })).toBeUndefined();
  });

  it("publishes, unpublishes, and is idempotent about it", () => {
    store.save(post({ slug: "draft-post-here", status: "draft", publishedAt: undefined }));
    const live = store.publish("draft-post-here", 5_000)!;
    expect(live.status).toBe("published");
    expect(live.publishedAt).toBe(5_000);
    // Publishing again must not move the date — that would re-date old posts.
    expect(store.publish("draft-post-here", 9_000)!.publishedAt).toBe(5_000);
    expect(store.unpublish("draft-post-here")!.publishedAt).toBeUndefined();
  });

  it("counts today's posts and reports the last publish time", () => {
    store.save(post({ slug: "yesterday-post-here", publishedAt: 1_000 }));
    store.save(post({ slug: "today-post-here", publishedAt: 50_000 }));
    expect(store.publishedSince(10_000)).toHaveLength(1);
    expect(store.lastPublishedAt()).toBe(50_000);
  });

  it("has no last-published time when nothing is live", () => {
    store.save(post({ slug: "draft-post-here", status: "draft", publishedAt: undefined }));
    expect(store.lastPublishedAt()).toBeUndefined();
  });

  it("deletes a post from the index and the disk", () => {
    const d = dir();
    const s = new BlogStore(d);
    s.save(post());
    expect(s.remove("a-real-slug-here")).toBe(true);
    expect(new BlogStore(d).count()).toBe(0);
  });
});

describe("presentation helpers", () => {
  it("reports reading time in whole minutes, never zero", () => {
    expect(readingMinutes("a few words")).toBe(1);
    expect(readingMinutes("word ".repeat(660))).toBe(3);
  });

  it("takes a real first sentence for a fallback description", () => {
    const s = firstSentence("## Heading\n\nThis is the opening sentence of the post and it is long enough. Then another.");
    expect(s).toMatch(/^Heading This is the opening sentence/);
    expect(s.endsWith(".")).toBe(true);
  });
});
