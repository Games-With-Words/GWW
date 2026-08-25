/**
 * Muse writes the blog.
 *
 * Same architecture as the voice pipeline, for the same reason: a background
 * process that talks to a model must never be able to hurt the thing people came
 * for. It runs on a timer, off the request path; every outcome is logged; a dead
 * model means no new posts and nothing else. The existing posts keep serving.
 *
 * WHAT IS DIFFERENT FROM VOICE, and it is the reason this file is careful: a
 * voice line that comes out badly is heard once and gone. A published post is a
 * permanent URL on our domain, and a domain's reputation is one number shared by
 * every page on it. So publication is gated in three independent ways:
 *
 *   1. QUALITY — length, structure, a real subject, no model tells (checkPost).
 *   2. NOVELTY — the store refuses a duplicate slug or a near-identical title.
 *   3. CADENCE — a daily cap, a minimum gap, jitter, and quiet hours.
 *
 * The cadence layer is the one that isn't obvious. Autopublish is ON (Mark's
 * call), so nothing between the model and the live site is a human — which makes
 * the SHAPE of the schedule the only thing distinguishing a blog from a firehose.
 * A person does not publish at 03:00, does not publish on the hour every hour,
 * and does not publish twelve times a day. So neither do we: attempts run on the
 * interval, but publication additionally requires the gap, the jitter offset and
 * the waking hours to agree. The interval is how often we THINK about it; the
 * cadence is how often anything actually lands.
 */

import { extractBlock } from "sentinel-blocks";
import { readSseCompletion } from "../voice.js";
import { toPlainText, wordCount } from "./markdown.js";
import { BlogStore, slugify, type Post } from "./store.js";

/* ------------------------------------------------------------------------- *
 * The knobs.
 * ------------------------------------------------------------------------- */

export interface BlogKnobs {
  /** The master switch. Off means nothing is drafted and nothing is published. */
  enabled: boolean;
  /** GO LIVE. When false, Muse still drafts — the drafts just wait for a human. */
  autopublish: boolean;
  /** How often an attempt is made, in minutes. */
  intervalMin: number;
  /** Hard ceiling on posts published per local day. */
  dailyMax: number;
  /** Minimum minutes between two published posts, regardless of the interval. */
  minGapMin: number;
  /** Random minutes (0..n) added to the gap, so posts don't land on the clock. */
  jitterMin: number;
  /** Local hours during which publication is allowed. [start, endExclusive) */
  hours: [number, number];
  /** The keyword queue — what to write about, in order of preference. */
  topics: string[];
  /** Voice direction handed to Muse verbatim. */
  tone: string;
  /** Minimum words before a draft is publishable. */
  minWords: number;
  /** Maximum words — a 4,000-word answer to a simple question is a model tell. */
  maxWords: number;
}

export interface BlogConfig extends BlogKnobs {
  dir: string;
  aiasUrl: string;
  apiKey: string | undefined;
  model: string;
  /** Bearer token for the knobs API. Absent means the API is closed entirely. */
  adminToken: string | undefined;
}

/**
 * The starting keyword queue.
 *
 * Written as QUESTIONS a person types, not as keywords a tool suggested. Each
 * one is something this project can answer from experience — which is the only
 * durable advantage a small site has, and the difference between a post worth
 * publishing and filler.
 */
export const DEFAULT_TOPICS: string[] = [
  "party games you can play on your TV with phones as controllers",
  "word games for groups of 4 to 10 people",
  "how to host a game night that doesn't die in the first ten minutes",
  "party games that need no app and no accounts",
  "games to play with family who don't play games",
  "what makes a word game funny instead of just hard",
  "how to explain a party game's rules in under a minute",
  "party games for large groups where nobody sits out",
  "free party games for a small apartment and one television",
  "games where the best player is the funniest person, not the fastest",
  "how to run a game night over a video call",
  "party games to play with your partner's family for the first time",
];

export function blogConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BlogConfig {
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (key: string, fallback: boolean): boolean => {
    const raw = env[key];
    if (raw === undefined || raw === "") return fallback;
    return /^(1|true|yes|on)$/i.test(raw);
  };
  const list = (key: string, fallback: string[]): string[] => {
    const raw = env[key];
    if (raw === undefined || raw.trim().length === 0) return fallback;
    return raw.split("|").map((t) => t.trim()).filter((t) => t.length > 0);
  };

  return {
    dir: env["GWW_BLOG_DIR"] ?? "./blog-store",
    aiasUrl: env["AIAS_URL"] ?? "https://aiassist.net",
    apiKey: env["AIAS_API_KEY"],
    model: env["GWW_BLOG_MODEL"] ?? env["GWW_LINE_MODEL"] ?? "muse-local:latest",
    adminToken: env["GWW_BLOG_ADMIN_TOKEN"],

    enabled: bool("GWW_BLOG_ENABLED", true),
    // GO LIVE, on by default — Mark's call. The rails below are what make that
    // safe rather than reckless.
    autopublish: bool("GWW_BLOG_AUTOPUBLISH", true),
    intervalMin: Math.max(5, num("GWW_BLOG_INTERVAL_MIN", 60)),
    // THREE a day. The number a person with something to say actually manages,
    // and the number that keeps a year of publishing under a thousand pages
    // instead of over eight thousand.
    dailyMax: Math.max(1, num("GWW_BLOG_DAILY_MAX", 3)),
    minGapMin: Math.max(0, num("GWW_BLOG_MIN_GAP_MIN", 150)),
    jitterMin: Math.max(0, num("GWW_BLOG_JITTER_MIN", 45)),
    hours: [num("GWW_BLOG_HOUR_START", 8), num("GWW_BLOG_HOUR_END", 23)],
    topics: list("GWW_BLOG_TOPICS", DEFAULT_TOPICS),
    tone: env["GWW_BLOG_TONE"] ??
      "Plain, warm, specific, faintly funny. Short sentences. Real examples from real game nights. " +
      "No hype, no listicle padding, no 'in today's fast-paced world', no em-dash-heavy throat-clearing.",
    minWords: Math.max(150, num("GWW_BLOG_MIN_WORDS", 500)),
    maxWords: Math.max(400, num("GWW_BLOG_MAX_WORDS", 1400)),
  };
}

/** The knobs a running server will accept from the admin API. */
export const TUNABLE: (keyof BlogKnobs)[] = [
  "enabled", "autopublish", "intervalMin", "dailyMax", "minGapMin",
  "jitterMin", "hours", "topics", "tone", "minWords", "maxWords",
];

/* ------------------------------------------------------------------------- *
 * Parsing what Muse wrote.
 * ------------------------------------------------------------------------- */

export const BLOG_TAGS = ["TITLE", "SLUG", "DESCRIPTION", "KEYWORDS", "BODY"] as const;

export interface DraftFields {
  title: string;
  slug: string;
  description: string;
  keywords: string[];
  body: string;
}

/**
 * Pull the five blocks out of a completion.
 *
 * Same contract as the voice line: the model may think as long as it likes, and
 * only closed sentinel blocks are read. Five blocks instead of one, because a
 * post is five fields and asking a model to emit JSON with a 900-word string
 * inside it is asking for an unparseable escape sequence at word 400.
 */
export function findDraft(content: string, thinking: string): DraftFields | { missing: string[] } {
  const missing: string[] = [];
  const got: Record<string, string> = {};
  for (const tag of BLOG_TAGS) {
    const block = extractBlock(content, tag) ?? extractBlock(thinking, tag);
    if (block === null || block.trim().length === 0) missing.push(tag);
    else got[tag] = block.trim();
  }
  if (missing.length > 0) return { missing };

  const title = got["TITLE"]!.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  return {
    title,
    // A model asked for a slug will sometimes hand back the title. Re-slugify
    // whatever arrives: the value has to be url-safe, and there is exactly one
    // function in this codebase that decides what url-safe means.
    slug: slugify(got["SLUG"]!.length > 0 ? got["SLUG"]! : title),
    description: got["DESCRIPTION"]!.replace(/\s+/g, " ").replace(/^["'“‘]+|["'”’]+$/g, "").trim(),
    keywords: got["KEYWORDS"]!.split(",").map((k) => k.trim()).filter((k) => k.length > 0).slice(0, 8),
    body: got["BODY"]!,
  };
}

export type PostRejection =
  | "TOO_SHORT" | "TOO_LONG" | "NO_STRUCTURE" | "TITLE_TOO_LONG" | "TITLE_TOO_SHORT"
  | "DESCRIPTION_LENGTH" | "OFF_SUBJECT" | "MODEL_TELL" | "MARKUP" | "NO_KEYWORDS";

/**
 * Phrases that mean a model wrote this and nobody read it.
 *
 * Not a style preference — each of these is a fingerprint. "As an AI language
 * model" is obvious; the rest ("in today's fast-paced world", "delve into",
 * "it's important to note") are the padding a model reaches for when it has run
 * out of things to say, which is precisely when a post should not be published.
 */
const TELLS = [
  "as an ai", "as a language model", "i cannot", "in today's fast-paced",
  "in today's digital", "delve into", "it's important to note that",
  "in conclusion, ", "unleash the power", "look no further",
  "lorem ipsum", "[insert", "todo:", "your keyword here",
];

/** Words that prove the post is about US and not about gardening. */
const SUBJECT_WORDS = [
  "game", "games", "player", "players", "party", "word", "words",
  "round", "rounds", "play", "playing", "night",
];

export function checkPost(
  fields: DraftFields,
  limits: { minWords: number; maxWords: number },
): { ok: true } | { ok: false; reason: PostRejection; detail: string } {
  const words = wordCount(fields.body);
  if (words < limits.minWords) return { ok: false, reason: "TOO_SHORT", detail: `${words} words` };
  if (words > limits.maxWords) return { ok: false, reason: "TOO_LONG", detail: `${words} words` };

  // At least two subheadings. Not a formatting nicety: a 900-word wall of text
  // is unreadable on a phone, and headings are how a reader decides to stay.
  const headings = (fields.body.match(/^#{2,3}\s+\S/gm) ?? []).length;
  if (headings < 2) return { ok: false, reason: "NO_STRUCTURE", detail: `${headings} subheading(s)` };

  if (fields.title.length > 70) return { ok: false, reason: "TITLE_TOO_LONG", detail: `${fields.title.length} chars` };
  if (fields.title.length < 15) return { ok: false, reason: "TITLE_TOO_SHORT", detail: `${fields.title.length} chars` };

  // Google truncates around 155–160 characters; under 60 usually means the model
  // restated the title instead of writing a promise.
  if (fields.description.length < 60 || fields.description.length > 165) {
    return { ok: false, reason: "DESCRIPTION_LENGTH", detail: `${fields.description.length} chars` };
  }

  if (fields.keywords.length === 0) return { ok: false, reason: "NO_KEYWORDS", detail: "none" };

  const haystack = `${fields.title} ${fields.description} ${toPlainText(fields.body)}`.toLowerCase();
  const tell = TELLS.find((t) => haystack.includes(t));
  if (tell !== undefined) return { ok: false, reason: "MODEL_TELL", detail: tell };

  if (!SUBJECT_WORDS.some((w) => haystack.includes(w))) {
    return { ok: false, reason: "OFF_SUBJECT", detail: "no subject word present" };
  }

  // The renderer escapes everything, so raw HTML cannot hurt a reader — but a
  // body full of it means the model ignored the format, and the post will read
  // like source code.
  if (/<\/?(script|iframe|style|div|span|img)\b/i.test(fields.body)) {
    return { ok: false, reason: "MARKUP", detail: "raw html in body" };
  }

  return { ok: true };
}

/* ------------------------------------------------------------------------- *
 * The prompt.
 * ------------------------------------------------------------------------- */

const PRODUCT_FACTS =
  "FACTS ABOUT GAMES WITH WORDS (use them; never invent features):\n" +
  "- It is a free browser party game for people in the same room. games-with-words.com.\n" +
  "- One screen is the BOARD (a TV, a laptop on the coffee table). It shows a room code and a QR code.\n" +
  "- Everyone else joins on their own phone by typing the code. No app to install, no account, no email.\n" +
  "- A random phone becomes the HOST and controls the pace. Nobody plays on the big screen.\n" +
  "- Game one is Say Less: one player is the Speaker and gets a secret word, and must make the room guess it " +
  "using as few words as possible. Fewer words scores more. Forbidden words are listed on the card.\n" +
  "- Game two is Ghost Writer: everyone answers the same prompt on their phone, except one player — the Ghost — " +
  "who never sees the prompt and has to bluff an answer that fits. The room reads the answers aloud, votes on " +
  "which was written blind, and a caught Ghost gets one guess at what the question was.\n" +
  "- Rounds are short. A session is 15 to 35 minutes. Say Less plays with 2 to 12 people; Ghost Writer needs at least 3, because the room has to be able to out-vote the Ghost.\n" +
  "- There is a host voice called Ris who reads lines out on the TV between rounds.";

export function draftSystemPrompt(knobs: Pick<BlogKnobs, "tone" | "minWords" | "maxWords">): string {
  return (
    "You write the blog for Games With Words, a free browser party game. Your reader is a person " +
    "planning an evening with friends or family — not a marketer, not a developer. They found this page by " +
    "typing a real question into a search engine, and the post has to answer that question better than " +
    "anything else they could have clicked.\n\n" +
    `VOICE: ${knobs.tone}\n\n` +
    `LENGTH: between ${knobs.minWords} and ${knobs.maxWords} words of body copy.\n\n` +
    "HARD RULES\n" +
    "1. Answer the question in the first two sentences. Do not warm up, do not set a scene.\n" +
    "2. Be specific. Name real situations: six people and one shy cousin, a phone at 4% battery, the " +
    "person who argues about rules. Specifics are the only thing that cannot be faked.\n" +
    "3. At least two `## ` subheadings, and each section must contain something usable — a rule, a number, " +
    "a fix, a thing to say out loud.\n" +
    "4. Mention Games With Words honestly, where it genuinely fits, once or twice. Never in every section. " +
    "A post that is entirely an advert ranks for nothing.\n" +
    "5. Never invent a feature, a price, a player count or an award. If you are unsure, leave it out.\n" +
    "6. No padding phrases: 'in today's fast-paced world', 'delve into', 'look no further', 'it's important " +
    "to note'. No emoji. No exclamation marks in the title.\n" +
    "7. Markdown only: `## `/`### ` headings, paragraphs, `- ` bullets, **bold**, > quotes. No HTML, no " +
    "code fences, no tables, no images.\n\n" +
    PRODUCT_FACTS + "\n\n" +
    "=== HOW TO ANSWER: SENTINEL BLOCKS ===\n" +
    "Your reply is read by a machine that does NOT guess. It ignores everything except five clearly marked " +
    "blocks, so think, plan and change your mind as long as you like above them — none of it is published.\n\n" +
    "Emit these five blocks, in this order, LAST, each marker alone on its own line:\n\n" +
    "<<<TITLE>>>\nthe headline, 15-70 characters, no quotation marks, title case not shouting\n<<<END>>>\n\n" +
    "<<<SLUG>>>\nlowercase-words-joined-by-hyphens, 3 to 8 words, no dates, no stop-word padding\n<<<END>>>\n\n" +
    "<<<DESCRIPTION>>>\nthe meta description: 60-165 characters, one sentence, a promise not a summary\n<<<END>>>\n\n" +
    "<<<KEYWORDS>>>\nthree to six comma-separated phrases a person would actually type\n<<<END>>>\n\n" +
    "<<<BODY>>>\nthe full post in markdown\n<<<END>>>\n\n" +
    "Anything outside the blocks is discarded. Emit each block exactly once."
  );
}

/* ------------------------------------------------------------------------- *
 * The service.
 * ------------------------------------------------------------------------- */

export interface AttemptResult {
  status:
    | "ok" | "drafted" | "disabled" | "no_key" | "daily_max" | "too_soon" | "quiet_hours"
    | "duplicate" | "gate_rejected" | "no_blocks" | "truncated" | "request_failed" | "threw";
  slug?: string;
  title?: string;
  detail?: string;
}

export class BlogService {
  readonly store: BlogStore;
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Re-rolled after every publish, so the gap is never the same twice. */
  private jitterMs = 0;
  private cursor = 0;
  private consecutiveFailures = 0;

  constructor(
    private cfg: BlogConfig,
    private fetcher: typeof fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {
    this.store = new BlogStore(cfg.dir);
    this.rollJitter();
  }

  get knobs(): BlogKnobs {
    const { dir: _d, aiasUrl: _u, apiKey: _k, model: _m, adminToken: _t, ...knobs } = this.cfg;
    return knobs;
  }

  private rollJitter(): void {
    this.jitterMs = Math.floor(Math.random() * this.cfg.jitterMin * 60_000);
  }

  /** Apply knob changes at runtime. Returns what actually changed. */
  tune(patch: Partial<BlogKnobs>): Partial<BlogKnobs> {
    const applied: Partial<BlogKnobs> = {};
    for (const key of TUNABLE) {
      if (!(key in patch)) continue;
      const value = patch[key];
      if (value === undefined) continue;
      // Re-run the same floors the env parser enforces, so the API cannot set a
      // 1-minute interval or a zero-word minimum that the env never could.
      switch (key) {
        case "intervalMin": this.cfg.intervalMin = Math.max(5, Number(value)); break;
        case "dailyMax": this.cfg.dailyMax = Math.max(1, Number(value)); break;
        case "minGapMin": this.cfg.minGapMin = Math.max(0, Number(value)); break;
        case "jitterMin": this.cfg.jitterMin = Math.max(0, Number(value)); this.rollJitter(); break;
        case "minWords": this.cfg.minWords = Math.max(150, Number(value)); break;
        case "maxWords": this.cfg.maxWords = Math.max(400, Number(value)); break;
        case "enabled": this.cfg.enabled = value === true; break;
        case "autopublish": this.cfg.autopublish = value === true; break;
        case "hours": {
          const h = value as [number, number];
          if (Array.isArray(h) && h.length === 2) this.cfg.hours = [Number(h[0]), Number(h[1])];
          break;
        }
        case "topics": {
          const t = (value as string[]).filter((x) => typeof x === "string" && x.trim().length > 0);
          if (t.length > 0) this.cfg.topics = t;
          break;
        }
        case "tone": this.cfg.tone = String(value); break;
      }
      applied[key] = this.cfg[key] as never;
    }
    if (Object.keys(applied).length > 0) {
      console.log(`[blog] knobs tuned: ${JSON.stringify(applied)}`);
      // A changed interval has to take effect now, not at the next old tick.
      if ("intervalMin" in applied || "enabled" in applied) this.restart();
    }
    return applied;
  }

  private midnight(): number {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  publishedToday(): number {
    return this.store.publishedSince(this.midnight()).length;
  }

  /**
   * May a post go live RIGHT NOW?
   *
   * Separate from drafting on purpose: a draft that was refused by the cadence is
   * kept, not thrown away, and goes out on the next tick that clears. The model's
   * work is never wasted by the clock.
   */
  publishGate(): { ok: true } | { ok: false; reason: "daily_max" | "too_soon" | "quiet_hours"; detail: string } {
    if (this.publishedToday() >= this.cfg.dailyMax) {
      return { ok: false, reason: "daily_max", detail: `${this.publishedToday()}/${this.cfg.dailyMax} today` };
    }
    const hour = new Date(this.now()).getHours();
    const [start, end] = this.cfg.hours;
    if (hour < start || hour >= end) {
      return { ok: false, reason: "quiet_hours", detail: `${hour}:00 is outside ${start}:00-${end}:00` };
    }
    const last = this.store.lastPublishedAt();
    if (last !== undefined) {
      const needed = this.cfg.minGapMin * 60_000 + this.jitterMs;
      const since = this.now() - last;
      if (since < needed) {
        return {
          ok: false,
          reason: "too_soon",
          detail: `${Math.round(since / 60_000)}m since last, needs ${Math.round(needed / 60_000)}m`,
        };
      }
    }
    return { ok: true };
  }

  /**
   * The next topic to write about.
   *
   * Walks the queue and skips anything already covered — a topic whose words
   * substantially overlap an existing title is done, and re-drafting it just
   * feeds the near-duplicate check later. When everything is covered the cursor
   * simply advances, so the queue cycles for angles rather than stalling.
   */
  nextTopic(): string {
    const topics = this.cfg.topics;
    const titles = this.store.list({ includeDrafts: true }).map((p) => p.topic);
    for (let i = 0; i < topics.length; i++) {
      const candidate = topics[(this.cursor + i) % topics.length]!;
      if (!titles.includes(candidate)) {
        this.cursor = (this.cursor + i + 1) % topics.length;
        return candidate;
      }
    }
    const fallback = topics[this.cursor % topics.length]!;
    this.cursor = (this.cursor + 1) % topics.length;
    return fallback;
  }

  /** Publish a draft by hand — the knob for reviewing before going live. */
  publish(slug: string): Post | undefined {
    const post = this.store.publish(slug, this.now());
    if (post !== undefined) {
      this.rollJitter();
      console.log(`[blog] PUBLISHED /blog/${post.slug} — "${post.title}"`);
    }
    return post;
  }

  /** One attempt: ask Muse for a post, gate it, store it, maybe publish it. */
  async writeOnce(topicOverride?: string): Promise<AttemptResult> {
    if (!this.cfg.enabled) return { status: "disabled" };
    if (this.cfg.apiKey === undefined || this.cfg.apiKey.length === 0) return { status: "no_key" };

    /**
     * The cadence is checked BEFORE spending a completion, not after.
     *
     * Drafting a post we already know cannot be published today would burn
     * model time to produce a file nobody asked for — and with autopublish on,
     * a pile of undated drafts is exactly the backlog that later floods the
     * site the moment the cap resets.
     */
    const gate = this.publishGate();
    if (this.cfg.autopublish && !gate.ok) {
      return { status: gate.reason, detail: gate.detail };
    }

    const topic = topicOverride ?? this.nextTopic();
    const abort = new AbortController();
    let res: Response;
    try {
      res = await this.fetcher(`${this.cfg.aiasUrl}/api/v1/pin/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [
            { role: "system", content: draftSystemPrompt(this.cfg) },
            {
              role: "user",
              content:
                `Write today's post. The reader's question is: "${topic}".\n\n` +
                `Already published, so pick a genuinely different angle and do not repeat these: ` +
                `${this.store.list({ includeDrafts: true }).map((p) => p.title).join(" | ") || "(nothing yet)"}\n\n` +
                `Take as long as you need to think, then emit the five sentinel blocks. Seed: ${Math.floor(this.now() / 1000)}.`,
            },
          ],
          temperature: 0.9,
          stream: true,
        }),
        signal: abort.signal,
      });
    } catch (err) {
      return { status: "threw", detail: err instanceof Error ? err.message : String(err) };
    }
    if (!res.ok) return { status: "request_failed", detail: `http_${res.status}` };

    // Streaming when the endpoint streams, one JSON body when it does not —
    // the same two-shape path the voice pipeline uses, so the same fakes work.
    let content = "";
    let thinking = "";
    let finishReason: string | undefined;
    const ctype = res.headers?.get?.("content-type") ?? "";
    if (ctype.includes("text/event-stream") && res.body !== null && res.body !== undefined) {
      // NOTE: no early hang-up here. The voice pipeline stops at the first
      // <<<END>>> because it wants ONE block; a post is five blocks, and the
      // first END is the end of the TITLE.
      const streamed = await readSseCompletion(res.body);
      content = streamed.content;
      thinking = streamed.thinking;
      finishReason = streamed.finishReason;
    } else {
      const json = (await res.json()) as {
        choices?: { finish_reason?: string; message?: { content?: string; thinking?: string; reasoning_content?: string }; text?: string }[];
      };
      const choice = json.choices?.[0];
      content = choice?.message?.content ?? choice?.text ?? "";
      thinking = choice?.message?.thinking ?? choice?.message?.reasoning_content ?? "";
      finishReason = choice?.finish_reason;
    }

    if (finishReason === "length") return { status: "truncated", detail: "finish_reason=length" };

    const draft = findDraft(content, thinking);
    if ("missing" in draft) {
      console.log(`[blog] no usable draft — missing block(s): ${draft.missing.join(", ")} (content ${content.length} chars, thinking ${thinking.length})`);
      return { status: "no_blocks", detail: draft.missing.join(",") };
    }

    const quality = checkPost(draft, this.cfg);
    if (!quality.ok) {
      console.log(`[blog] draft REJECTED (${quality.reason}: ${quality.detail}) — "${draft.title}"`);
      return { status: "gate_rejected", detail: `${quality.reason}:${quality.detail}`, title: draft.title };
    }

    const refusal = this.store.refuse(draft);
    if (refusal !== undefined) {
      console.log(`[blog] draft REFUSED by store (${refusal}) — "${draft.title}"`);
      return { status: "duplicate", detail: refusal, title: draft.title };
    }

    // Re-check the cadence: the completion took real time, and a concurrent
    // manual publish may have used up the day while the model was thinking.
    const stillClear = this.publishGate();
    const goLive = this.cfg.autopublish && stillClear.ok;
    const at = this.now();
    const post: Post = {
      ...draft,
      topic,
      status: goLive ? "published" : "draft",
      createdAt: at,
      publishedAt: goLive ? at : undefined,
      source: "muse",
      model: this.cfg.model,
    };
    this.store.save(post);
    if (goLive) {
      this.rollJitter();
      console.log(`[blog] PUBLISHED /blog/${post.slug} — "${post.title}" (${wordCount(post.body)} words, topic: ${topic})`);
      return { status: "ok", slug: post.slug, title: post.title };
    }
    console.log(`[blog] DRAFTED /blog/${post.slug} — "${post.title}" (awaiting ${this.cfg.autopublish ? "cadence" : "review"})`);
    return { status: "drafted", slug: post.slug, title: post.title, detail: stillClear.ok ? "review" : stillClear.reason };
  }

  /**
   * A drafted-but-unpublished post going live on a later tick.
   *
   * This is what keeps the cadence from wasting work: a post refused at 02:00
   * for quiet hours is published at 08:00 instead of being written again.
   */
  private releaseOldestDraft(): AttemptResult | undefined {
    const drafts = this.store.list({ includeDrafts: true })
      .filter((p) => p.status === "draft" && p.source === "muse")
      .sort((a, b) => a.createdAt - b.createdAt);
    const oldest = drafts[drafts.length - 1];
    if (oldest === undefined) return undefined;
    const post = this.publish(oldest.slug);
    return post === undefined ? undefined : { status: "ok", slug: post.slug, title: post.title, detail: "released from drafts" };
  }

  private async tick(): Promise<void> {
    try {
      // Clear a backlog before writing anything new — otherwise a queue built
      // up overnight never drains and the same topics get drafted twice.
      if (this.cfg.autopublish && this.publishGate().ok) {
        const released = this.releaseOldestDraft();
        if (released !== undefined) {
          console.log(`[blog] tick: ${released.status} (${released.detail})`);
          return;
        }
      }
      const r = await this.writeOnce();
      console.log(`[blog] tick: ${r.status}${r.detail !== undefined ? ` (${r.detail})` : ""}`);
      // Transient failures retry in 10 minutes rather than waiting a whole
      // interval — but only a few times, so a dead endpoint stops being asked.
      const transient = ["request_failed", "threw", "no_blocks", "truncated"].includes(r.status);
      if (transient && this.consecutiveFailures < 3) {
        this.consecutiveFailures += 1;
        console.log(`[blog] retrying in 10m (attempt ${this.consecutiveFailures}/3)`);
        setTimeout(() => void this.tick(), 10 * 60_000).unref?.();
        return;
      }
      if (!transient) this.consecutiveFailures = 0;
    } catch (err) {
      console.log(`[blog] tick threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  start(): void {
    if (!this.cfg.enabled) { console.log("[blog] disabled (GWW_BLOG_ENABLED=0)"); return; }
    if (this.cfg.apiKey === undefined || this.cfg.apiKey.length === 0) {
      console.log(`[blog] AIAS_API_KEY not set — serving ${this.store.count("published")} existing post(s), writing nothing`);
      return;
    }
    const [h0, h1] = this.cfg.hours;
    console.log(
      `[blog] LIVE: autopublish=${this.cfg.autopublish}, attempt every ${this.cfg.intervalMin}m, ` +
      `max ${this.cfg.dailyMax}/day, min gap ${this.cfg.minGapMin}m +0-${this.cfg.jitterMin}m jitter, ` +
      `hours ${h0}:00-${h1}:00, ${this.cfg.topics.length} topic(s) queued, ` +
      `${this.store.count("published")} published / ${this.store.count("draft")} draft`,
    );
    setTimeout(() => void this.tick(), 60_000).unref?.();
    this.timer = setInterval(() => void this.tick(), this.cfg.intervalMin * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private restart(): void {
    if (this.timer === undefined) return;
    this.stop();
    this.start();
  }

  /** Everything the knobs API reports. Read-only view of the whole pipeline. */
  status(): Record<string, unknown> {
    const gate = this.publishGate();
    return {
      knobs: this.knobs,
      model: this.cfg.model,
      hasKey: this.cfg.apiKey !== undefined && this.cfg.apiKey.length > 0,
      running: this.timer !== undefined,
      published: this.store.count("published"),
      drafts: this.store.count("draft"),
      publishedToday: this.publishedToday(),
      lastPublishedAt: this.store.lastPublishedAt() ?? null,
      jitterMinutes: Math.round(this.jitterMs / 60_000),
      canPublishNow: gate.ok,
      blockedBy: gate.ok ? null : `${gate.reason}: ${gate.detail}`,
      nextTopic: this.cfg.topics.length > 0 ? this.cfg.topics[this.cursor % this.cfg.topics.length] : null,
    };
  }

  /** Does this request carry the admin token? No token configured means no. */
  authorized(header: string | undefined): boolean {
    const token = this.cfg.adminToken;
    if (token === undefined || token.length === 0) return false;
    return header === `Bearer ${token}`;
  }
}
