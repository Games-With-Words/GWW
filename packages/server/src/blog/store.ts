/**
 * The blog's storage — one JSON file per post, an index in memory.
 *
 * No database, for the same reason the voice cache has no database: a post is a
 * small immutable document with a natural key, and a directory of files is
 * something you can read, diff, back up and delete by hand at 2am. The index is
 * rebuilt from disk at boot, so the truth is always the files.
 *
 * The interesting logic here is not persistence, it is REFUSAL: which posts are
 * allowed to exist at all. A pipeline that writes a new post every few hours
 * will eventually try to write the same post twice — same topic, near-identical
 * title — and near-duplicate pages are worse than no pages. So the store owns
 * slug shape, slug uniqueness, and title similarity, and says no.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { toPlainText, wordCount } from "./markdown.js";

export type PostStatus = "draft" | "published";

export interface Post {
  slug: string;
  title: string;
  /** The meta description AND the index card blurb — one sentence of promise. */
  description: string;
  /** Body in the markdown subset. Source of truth; HTML is derived per request. */
  body: string;
  /** Free-text topic this post was drafted for — the keyword queue entry. */
  topic: string;
  keywords: string[];
  status: PostStatus;
  createdAt: number;
  publishedAt: number | undefined;
  /** "muse" or "hand" — so a human-written floor post is distinguishable. */
  source: "muse" | "hand";
  /** Model that wrote it, when a model did. Provenance survives on disk. */
  model?: string;
}

/** A url-safe slug. Deliberately strict: this string ends up in a permalink. */
export function slugify(raw: string): string {
  return raw
    .normalize("NFKD")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
    .replace(/-+$/g, "");
}

/** Is this a slug we are willing to serve at /blog/<slug>? */
export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+){1,11}$/.test(slug) && slug.length <= 72;
}

/**
 * Title similarity, as a token overlap ratio.
 *
 * Not fuzzy string distance — that flags "10 party games" vs "11 party games" as
 * different when they are the same page, and flags nothing about reordered
 * words. Comparing meaningful token SETS catches the failure mode that actually
 * happens: the model drafting the same article again in a different word order.
 */
export function titleSimilarity(a: string, b: string): number {
  /**
   * Tokens are STEMMED, crudely, because the first real near-duplicate pair
   * this function was shown scored 0.75 and passed:
   *
   *   "Word Games for Groups of Friends"
   *   "Games With Words for Groups of Friends"
   *
   * Those are the same page. They scored low only because "word" and "words"
   * counted as different subjects. Dropping a trailing "s" is not linguistics,
   * but it is the whole distance between those two titles.
   */
  const tokens = (s: string): Set<string> =>
    new Set(
      s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
        .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w)),
    );
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / Math.min(A.size, B.size);
}

const STOP = new Set([
  "the", "and", "for", "with", "your", "you", "how", "why", "what", "that", "this",
  "are", "can", "from", "into", "when", "who", "our", "out", "get", "not", "all",
  "with", "without", "make", "makes", "does", "doesnt", "isnt", "was", "were",
]);

/** Reading time, rounded the way a human would say it. */
export function readingMinutes(body: string): number {
  return Math.max(1, Math.round(wordCount(body) / 220));
}

/** First real sentence of the body — the fallback when a description is thin. */
export function firstSentence(body: string): string {
  const text = toPlainText(body);
  const cut = /^(.{40,180}?[.!?])\s/.exec(text);
  return (cut?.[1] ?? text.slice(0, 155)).trim();
}

export class BlogStore {
  private posts = new Map<string, Post>();

  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
    this.load();
  }

  private file(slug: string): string {
    return join(this.dir, `${slug}.json`);
  }

  /** Rebuild the index from disk. A corrupt file is skipped, never fatal. */
  private load(): void {
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      try {
        const post = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Post;
        if (isValidSlug(post.slug)) this.posts.set(post.slug, post);
      } catch {
        console.log(`[blog] skipped unreadable post file: ${name}`);
      }
    }
  }

  /** Newest first. Published only, unless asked for everything. */
  list(opts: { includeDrafts?: boolean } = {}): Post[] {
    const all = [...this.posts.values()];
    const wanted = opts.includeDrafts === true ? all : all.filter((p) => p.status === "published");
    return wanted.sort((a, b) => (b.publishedAt ?? b.createdAt) - (a.publishedAt ?? a.createdAt));
  }

  get(slug: string): Post | undefined {
    return this.posts.get(slug);
  }

  /** Published posts only — what a reader or a crawler is allowed to see. */
  published(slug: string): Post | undefined {
    const p = this.posts.get(slug);
    return p?.status === "published" ? p : undefined;
  }

  count(status?: PostStatus): number {
    return status === undefined
      ? this.posts.size
      : [...this.posts.values()].filter((p) => p.status === status).length;
  }

  /** Posts published since local midnight — the daily cap's window. */
  publishedSince(cutoff: number): Post[] {
    return [...this.posts.values()].filter(
      (p) => p.status === "published" && (p.publishedAt ?? 0) >= cutoff,
    );
  }

  /** When the most recent post went live, or undefined if none ever has. */
  lastPublishedAt(): number | undefined {
    const times = [...this.posts.values()]
      .filter((p) => p.status === "published")
      .map((p) => p.publishedAt ?? 0);
    return times.length === 0 ? undefined : Math.max(...times);
  }

  /**
   * Why a candidate post cannot be saved — or undefined if it can.
   *
   * Returns a REASON rather than throwing, because the caller is a background
   * loop whose job is to log the refusal and try again later, not to crash.
   */
  refuse(candidate: { slug: string; title: string }): string | undefined {
    if (!isValidSlug(candidate.slug)) return `bad_slug:${candidate.slug}`;
    if (this.posts.has(candidate.slug)) return `duplicate_slug:${candidate.slug}`;
    for (const existing of this.posts.values()) {
      const sim = titleSimilarity(candidate.title, existing.title);
      if (sim >= 0.8) return `near_duplicate_title:${existing.slug}(${sim.toFixed(2)})`;
    }
    return undefined;
  }

  save(post: Post): Post {
    this.posts.set(post.slug, post);
    writeFileSync(this.file(post.slug), JSON.stringify(post, null, 2));
    return post;
  }

  /** Promote a draft. Idempotent — publishing a published post is a no-op. */
  publish(slug: string, now: number): Post | undefined {
    const post = this.posts.get(slug);
    if (post === undefined) return undefined;
    if (post.status === "published") return post;
    return this.save({ ...post, status: "published", publishedAt: now });
  }

  /** Send a post back to draft. The knob for "that one was bad". */
  unpublish(slug: string): Post | undefined {
    const post = this.posts.get(slug);
    if (post === undefined || post.status === "draft") return post;
    return this.save({ ...post, status: "draft", publishedAt: undefined });
  }

  remove(slug: string): boolean {
    if (!this.posts.delete(slug)) return false;
    if (existsSync(this.file(slug))) unlinkSync(this.file(slug));
    return true;
  }
}
