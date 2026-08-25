/**
 * Ris's voice pipeline (spec §07 cache hierarchy + §08 speech systems).
 *
 * muse-local writes fresh intro lines; Chatterbox Turbo renders them; AiAS PIN
 * carries both — server-to-server with the aai_ key, never in the client.
 *
 * HARD INVARIANT: this whole file lives OFF the critical gameplay path.
 * - L0: hand-written lines ship in this file. Always available, caption-only.
 * - L1: content-addressed WAV cache on disk, replenished in the background.
 * - Budget: at most GWW_VOICE_DAILY_MAX new renders per day (default 10 —
 *   nobody's playing yet; raise the env when they are).
 * A dead pipeline degrades to text captions. It can never stop the party.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractBlock } from "sentinel-blocks";

/** The moments Ris hosts. Every cue has L0 text, cached audio, and a muse brief. */
export type Cue =
  | "intro"
  | "round"
  | "clue"
  | "timeout"
  | "correct"
  | "outro"
  // Cues a second game needed. Ris hosts the arcade, not one game: a game names
  // its own moments in effects().cue, and the bank either has lines for that
  // moment or the board simply stays quiet. Adding a cue is adding L0 lines —
  // the Record below is exhaustive, so the compiler will not let a cue ship mute.
  | "vote"
  | "caught"
  | "survived";

export const CUES: Cue[] = [
  "intro", "round", "clue", "timeout", "correct", "outro",
  "vote", "caught", "survived",
];

/** Does the voice bank host this moment? Unknown cues are ignored, never fatal. */
export function isCue(name: string): name is Cue {
  return (CUES as string[]).includes(name);
}

/** L0 — hand-written Ris intro lines. The floor the pipeline can never sink below. */
export const L0_INTRO_LINES: string[] = [
  "Welcome to the room! No strangers, no awkward accounts — just your circle and some very questionable clues.",
  "Phones up, eyes up. Tonight's winners get bragging rights. Tonight's losers get remembered forever.",
  "It's Say Less! Where fewer words means more points, and someone always says the forbidden word anyway.",
  "Gather round! The rules are simple, the clues will not be.",
  "Welcome welcome welcome. I'm Ris, your host. I already know who's going to argue about the rules.",
  "The room is the game, people. Let's find out who actually knows their friends.",
  "Say Less, round zero: everyone claims they're good at this. The scoreboard disagrees shortly.",
  "New game, clean slate. Old grudges from last round are, of course, still admissible.",
];

/** L0 lines for every other cue — Ris guides the whole night, never just the open. */
export const L0_CUE_LINES: Record<Cue, string[]> = {
  intro: L0_INTRO_LINES,
  round: [
    "New round! Speaker, your secret just landed. Everyone else, look alive.",
    "Fresh card, fresh chances. Speaker, choose your words like they cost money — they do.",
    "Round's up! Remember: fewer words, more glory.",
    "Here we go. Speaker, the room believes in you. The room is also ready to laugh at you.",
    "Next round! Somebody in here is about to be a legend or a cautionary tale.",
  ],
  clue: [
    "The clue is in! Guessers, go go go!",
    "That's the clue. Phones up — first correct answer takes it.",
    "Clue's on the board. Trust your gut, it's funnier when you're wrong anyway.",
    "And the clue lands. Guess fast, think later.",
  ],
  timeout: [
    "Time! Nobody got it. That silence? That's the sound of friendship being tested.",
    "Buzzer! No winners this round — the word remains undefeated.",
    "And... time. The secret walks free. Awkward.",
  ],
  correct: [
    "YES! That's it! Points on the board!",
    "Got it! Somebody actually knows their friends.",
    "Correct! The room erupts. Well — it should.",
    "Nailed it! That's how it's done, people.",
  ],
  outro: [
    "That's the game! Argue about the scoring on your own time — I'm off the clock.",
    "And scene! Tonight's best rounds are tomorrow's inside jokes.",
    "Game over! The scoreboard is final. The rematch demands are inevitable.",
  ],
  vote: [
    "Answers are in and nobody knows who wrote what. Find the one who was guessing.",
    "Read them again. One of these people had no idea what the question was.",
    "Vote on your phones. Trust nothing, especially the confident ones.",
    "Somebody at this table is bluffing beautifully. Point at them.",
  ],
  caught: [
    "CAUGHT! The room smelled it. One last chance — what was the question?",
    "Busted. Now the fun part: do you even know what you were answering?",
    "They got you. Redeem yourself — name the prompt.",
    "The room has spoken, and it spoke your name. Last word?",
  ],
  survived: [
    "The Ghost walks free. You people were RIGHT THERE.",
    "Nobody caught it. Somebody at this table lies for a living.",
    "Clean escape. That answer had no business fitting that well.",
    "The room split, the Ghost strolled out. Painful.",
  ],
};

/** What muse is asked to write, per cue. One line, speakable, under 25 words. */
const CUE_BRIEFS: Record<Cue, string> = {
  intro: "Write EXACTLY ONE fresh opening line to welcome the room and kick off a game of Say Less.",
  round: "Write EXACTLY ONE fresh line announcing a new round is starting: the Speaker just got a secret word, everyone else should get ready to guess.",
  clue: "Write EXACTLY ONE fresh line announcing the Speaker's clue just landed and the guessers should start guessing fast.",
  timeout: "Write EXACTLY ONE fresh line for the moment time runs out and NOBODY guessed the word — playful sting, roast the moment never a person.",
  correct: "Write EXACTLY ONE fresh celebratory line for the moment someone guesses the secret word correctly.",
  outro: "Write EXACTLY ONE fresh sign-off line for the end of the game — send the room off laughing.",
  vote: "The anonymous answers are on the board and the room must vote on which one was written blind. Build suspicion, name nobody.",
  caught: "The room correctly identified the Ghost, who now gets one attempt to name the prompt they never saw. Gloat, then dare them.",
  survived: "The Ghost escaped the vote. Celebrate the bluff and needle the room for missing it.",
};

interface VoiceEntry {
  hash: string;
  text: string;
  file: string;
  createdAt: number;
  source: "muse" | "seed";
  /** Which hosting moment this line serves. Legacy entries default to intro. */
  cue?: Cue;
  /** Which extractor produced this text. Anything but "sentinel" came from the
   *  heuristic miner we retired — it cached muse's scratchpad into WAVs, so
   *  those entries are quarantined at boot rather than trusted — never deleted. */
  parser?: string;
}

/** Entries the retired heuristic parser produced are not trusted. */
const TRUSTED_PARSER = "sentinel";

interface Manifest {
  entries: VoiceEntry[];
}

export interface VoiceConfig {
  aiasUrl: string;
  apiKey: string | undefined;
  lineModel: string;
  ttsModel: string;
  voice: string;
  cacheDir: string;
  dailyMax: number;
}

export function voiceConfigFromEnv(): VoiceConfig {
  return {
    aiasUrl: process.env["AIAS_URL"] ?? "https://aiassist.net",
    apiKey: process.env["AIAS_API_KEY"],
    lineModel: process.env["GWW_LINE_MODEL"] ?? "muse-local:latest",
    ttsModel: process.env["GWW_TTS_MODEL"] ?? "chatterbox-turbo",
    voice: process.env["GWW_TTS_VOICE"] ?? "default",
    cacheDir: process.env["GWW_VOICE_DIR"] ?? "./voice-cache",
    dailyMax: Number(process.env["GWW_VOICE_DAILY_MAX"] ?? 10),
  };
}

/** The sentinel tag muse wraps her finished line in. Think as long as you
 *  like — the answer is whatever sits between the markers. */
export const LINE_TAG = "LINE";

const lineSystemPrompt = (cue: Cue): string =>
  "You are Ris, the host of Games With Words — a private, in-person party game " +
  "played by friends and family in one room. " + CUE_BRIEFS[cue] + " Rules: under 25 words; " +
  "warm, funny, a little mischievous; roast the MOMENT never a person; no emojis; " +
  "no quotation marks; no stage directions; plain speakable text only. " +
  "Randomize your angle every time — never repeat a structure you have used before.\n\n" +
  "=== HOW TO ANSWER: SENTINEL BLOCKS ===\n" +
  "Your reply is read by a machine that does NOT guess. It ignores everything " +
  "you write except one clearly marked block, so you are free to think, weigh " +
  "options, and change your mind as long as you like — none of it leaks into " +
  "the show.\n\n" +
  "A sentinel block is an opening marker on its own line, the payload, then a " +
  "closing marker on its own line:\n\n" +
  `<<<${LINE_TAG}>>>\n` +
  "the finished line, exactly as it should be spoken\n" +
  "<<<END>>>\n\n" +
  "Rules for the block:\n" +
  `1. Emit exactly ONE <<<${LINE_TAG}>>> block, and emit it LAST — it is how you say DONE.\n` +
  "2. Between the markers: only the spoken line. No quotes, no label, no " +
  "alternatives, no notes, no markdown, no trailing explanation.\n" +
  "3. Both markers sit alone on their own lines, spelled exactly as shown.\n" +
  "4. Anything outside the block is discarded — deliberate freely above it.\n\n" +
  "Worked example (a different cue, same shape):\n" +
  "Let me try a couple of angles... maybe something about the clock, or about " +
  "the room going quiet. The clock one lands better.\n" +
  `<<<${LINE_TAG}>>>\n` +
  "Time's up and the word walks free, smug as ever.\n" +
  "<<<END>>>";

/**
 * Pull Ris's finished line out of a completion using sentinel blocks.
 *
 * The model declares completion by wrapping the answer in <<<LINE>>>…<<<END>>>.
 * We never guess which line of a reasoning stream is "the answer" — the old
 * heuristic mined muse's scratchpad and voiced "I'll produce one line." into
 * a WAV. Thinking is welcome and unbounded; only the block is read.
 *
 * Searches the answer channel first, then the thinking channel (thinking
 * models routinely close the block inside their reasoning stream).
 */
export function lineFromCompletion(content: string, thinking = ""): string | undefined {
  const found = findLine(content, thinking);
  return found.ok ? found.line : undefined;
}

/**
 * Same search, but it reports WHY it came back empty.
 *
 * The old code returned a bare undefined and the caller logged "no usable
 * <<<LINE>>> block" for every failure — including the case where the block was
 * found and PERFECTLY well-formed and a validator rule refused its contents.
 * Those are opposite problems (the model misbehaved vs. our gate misbehaved) and
 * one message for both sent Mark hunting token budgets for a line that had
 * arrived whole. A diagnosis our own logging pre-writes is the worst kind.
 */
export function findLine(
  content: string,
  thinking = "",
): { ok: true; line: string; channel: "content" | "thinking" } | { ok: false; reason: "NO_BLOCK" | LineRejection; extracted?: string } {
  let lastReject: { reason: LineRejection; extracted: string } | undefined;
  for (const [channel, text] of [["content", content], ["thinking", thinking]] as const) {
    if (text.length === 0) continue;
    const block = extractBlock(text, LINE_TAG);
    if (block === null) continue;
    const check = checkLine(block);
    if (check.ok) return { ok: true, line: check.line, channel };
    lastReject = { reason: check.reason, extracted: check.line };
  }
  if (lastReject !== undefined) return { ok: false, reason: lastReject.reason, extracted: lastReject.extracted };
  return { ok: false, reason: "NO_BLOCK" };
}

/** Why a line was refused. Named so the log can say which rule fired. */
export type LineRejection = "EMPTY" | "TOO_SHORT" | "TOO_LONG" | "MARKUP" | "NO_LETTERS";

export type LineCheck =
  | { ok: true; line: string }
  | { ok: false; reason: LineRejection; line: string };

/**
 * Deterministic sanity gate — reject junk before it costs a render.
 *
 * THE DANGLING-WORD RULE IS GONE (Mark's call, 2026-08-25: "<<<END>>> is the
 * contract"). It used to reject any line ending on a function word, on the
 * theory that such a line was a cut-off thought. It cost us a real line in live
 * play: muse wrote
 *
 *   "...you get one charming guess at a prompt you never saw bring it on"
 *
 * which is a complete sentence, and the gate threw it away because "on" was in
 * the list. The same trap was waiting for "what are you waiting for", "that's
 * what it's for", and anything ending in is / are / to / by / at / in.
 *
 * The rule was a leftover from when we MINED the reasoning stream for an answer
 * and had to guess whether a fragment was finished. That era is over: the model
 * now declares completion by closing a sentinel block, extractBlock only returns
 * CLOSED blocks, and a truncated completion is refused earlier by the
 * finish_reason check. Completion is structural now, so guessing at it from
 * grammar is both unnecessary and — as the live failure proved — wrong.
 *
 * What remains are checks about the line being SPEAKABLE, not finished: it has
 * words, not too many, no markup, and at least one letter.
 */
export function checkLine(raw: string): LineCheck {
  // Local models often narrate before they answer — strip reasoning blocks
  // and take the LAST non-empty line, which is where the actual answer lives.
  let line = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parts = line.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (parts.length > 0) line = parts[parts.length - 1]!;
  line = line.replace(/^["'“‘]+|["'”’]+$/g, "").trim();

  if (line.length === 0) return { ok: false, reason: "EMPTY", line };
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 4) return { ok: false, reason: "TOO_SHORT", line };
  if (words.length > 30) return { ok: false, reason: "TOO_LONG", line };
  if (/https?:|<|>|\{|\}/.test(line)) return { ok: false, reason: "MARKUP", line };
  if (!/[a-zA-Z]/.test(line)) return { ok: false, reason: "NO_LETTERS", line };

  // A complete thought missing its period gets one — muse often skips it.
  if (!/[.!?…]$/.test(line)) line = `${line}.`;
  return { ok: true, line };
}

/** Back-compat wrapper: the line, or undefined. */
export function validateLine(raw: string): string | undefined {
  const check = checkLine(raw);
  return check.ok ? check.line : undefined;
}

/**
 * What a streamed completion produced.
 *
 * `stoppedEarly` means we saw the closing marker and hung up rather than waiting
 * for the model to finish talking to itself.
 */
export interface StreamedCompletion {
  content: string;
  thinking: string;
  finishReason: string | undefined;
  stoppedEarly: boolean;
  /** Server-sent events seen. Zero means the endpoint did not actually stream. */
  events: number;
}

const SSE_DONE = "[DONE]";

/**
 * Read an OpenAI-style SSE stream and stop at the closing sentinel.
 *
 * WHY STREAM AT ALL (Mark's call, 2026-08-25): muse is a reasoning model, and the
 * live logs show her spending 3,400 characters of scratchpad to produce a 23-word
 * line. With a single JSON response we pay for all of that before we see a
 * character. Streaming lets us hang up the moment `<<<END>>>` lands, which is the
 * model's own DONE signal — the same contract the parser already relies on.
 *
 * This did NOT cause the bug it was proposed for: that line arrived complete with
 * finish_reason "stop" and was killed by our own validator. Streaming is a
 * latency and cost win, and real protection for the day an upstream cap DOES
 * truncate her — not a fix for that failure. Worth being clear about, because a
 * change that lands next to a bug tends to get credit for solving it.
 *
 * Written as a function over a stream rather than inside the fetch call so it can
 * be unit-tested against a fabricated stream, with no network and no model.
 */
export interface ReadSseOptions {
  /** Fired when we hang up early, so the caller can abort the request. */
  onEnd?: () => void;
  /**
   * When the payload is COMPLETE. Defaults to the first closing marker.
   *
   * That default is right for a one-block payload and silently wrong for any
   * other. The blog asks for five blocks and got exactly one: the reader saw
   * the `<<<END>>>` of TITLE, decided the model was done, and hung up — so
   * every tick reported "missing SLUG, DESCRIPTION, KEYWORDS, BODY" with about
   * 67 characters of content, which is the length of a title block. The blog
   * even carried a comment saying "no early hang-up here", because the hang-up
   * was believed to live in the voice CALLER. It lived here, in the reader both
   * of them import.
   *
   * So the stop condition belongs to whoever knows the shape of the payload.
   */
  isDone?: (content: string, thinking: string) => boolean;
}

export async function readSseCompletion(
  stream: ReadableStream<Uint8Array>,
  opts?: ReadSseOptions | (() => void),
): Promise<StreamedCompletion> {
  const o: ReadSseOptions = typeof opts === "function" ? { onEnd: opts } : opts ?? {};
  const isDone = o.isDone ?? ((c: string, t: string): boolean =>
    c.includes("<<<END>>>") || t.includes("<<<END>>>"));
  const onEnd = o.onEnd;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let thinking = "";
  let finishReason: string | undefined;
  let events = 0;
  let stoppedEarly = false;

  const closed = (): boolean => isDone(content, thinking);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line; a frame may hold several
      // `data:` lines. Keep the trailing partial frame in the buffer.
      const frames = buffer.split(/\r?\n\r?\n/);
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        for (const rawLine of frame.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === SSE_DONE) { events += 1; continue; }
          events += 1;
          let parsed: {
            choices?: {
              finish_reason?: string | null;
              delta?: { content?: string; thinking?: string; reasoning_content?: string };
              message?: { content?: string; thinking?: string; reasoning_content?: string };
              text?: string;
            }[];
          };
          try {
            parsed = JSON.parse(data);
          } catch {
            continue; // a keep-alive or a partial frame we cannot use
          }
          const choice = parsed.choices?.[0];
          const delta = choice?.delta ?? choice?.message;
          content += delta?.content ?? choice?.text ?? "";
          thinking += delta?.thinking ?? delta?.reasoning_content ?? "";
          if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
            finishReason = choice.finish_reason;
          }
        }
      }

      if (closed()) {
        // The model said DONE. Everything after this is deliberation we throw
        // away anyway, so stop paying for it.
        stoppedEarly = true;
        onEnd?.();
        break;
      }
    }
  } finally {
    // Releasing the lock is enough; cancel() on an aborted body can reject.
    try { await reader.cancel(); } catch { /* already gone */ }
  }

  return { content, thinking, finishReason, stoppedEarly, events };
}

export class VoiceService {
  private manifest: Manifest = { entries: [] };
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private cfg: VoiceConfig,
    /** Injectable for tests — defaults to global fetch. */
    private fetcher: typeof fetch = fetch,
    private now: () => number = () => Date.now(),
  ) {
    mkdirSync(cfg.cacheDir, { recursive: true });
    const mf = join(cfg.cacheDir, "lines.json");
    if (existsSync(mf)) {
      try {
        this.manifest = JSON.parse(readFileSync(mf, "utf8")) as Manifest;
      } catch {
        this.manifest = { entries: [] };
      }
    }
    this.logBank();
  }

  /** Lines the retired heuristic parser wrote are QUARANTINED, never deleted:
   *  the manifest and every WAV stay exactly as they are on disk. They simply
   *  stop being pickable, because that parser voiced muse's deliberation
   *  ("Which to choose? Let's randomize with seed") into real audio. */
  private trusted(): VoiceEntry[] {
    return this.manifest.entries.filter((e) => e.parser === TRUSTED_PARSER);
  }

  /** Say what Ris can actually say. A silent bank was invisible for a whole
   *  night of "why is audioUrl null" — the cache is now read out at boot. */
  private logBank(): void {
    const quarantined = this.manifest.entries.length - this.trusted().length;
    if (quarantined > 0) {
      console.log(`[voice] ${quarantined} line(s) quarantined — written by the retired parser, kept on disk, never spoken`);
    }
    for (const cue of CUES) {
      const lines = this.trusted().filter((e) => (e.cue ?? "intro") === cue);
      if (lines.length === 0) {
        console.log(`[voice] bank ${cue}: SILENT (L0 captions only)`);
        continue;
      }
      console.log(`[voice] bank ${cue}: ${lines.length} voiced`);
      for (const l of lines) console.log(`[voice]   - "${l.text}"`);
    }
  }

  private save(): void {
    writeFileSync(join(this.cfg.cacheDir, "lines.json"), JSON.stringify(this.manifest, null, 2));
  }

  get enabled(): boolean {
    return this.cfg.apiKey !== undefined && this.cfg.apiKey.length > 0;
  }

  /** Renders created since local midnight — the budget window. */
  generatedToday(): number {
    const d = new Date(this.now());
    d.setHours(0, 0, 0, 0);
    const midnight = d.getTime();
    // Quarantined renders don't hold budget hostage — they produced nothing
    // speakable, so they don't count against tonight's allowance.
    return this.trusted().filter((e) => e.createdAt >= midnight).length;
  }

  /**
   * Pick a line for a hosting moment. Cached voiced lines win; otherwise a
   * hand-written L0 line, caption-only. NEVER waits on generation.
   */
  pickLine(cue: Cue): { text: string; audioFile: string | undefined } {
    const voiced = this.trusted().filter((e) => (e.cue ?? "intro") === cue);
    if (voiced.length > 0) {
      const e = voiced[Math.floor(Math.random() * voiced.length)]!;
      const path = join(this.cfg.cacheDir, e.file);
      if (existsSync(path)) return { text: e.text, audioFile: e.file };
    }
    const l0 = L0_CUE_LINES[cue];
    return { text: l0[Math.floor(Math.random() * l0.length)]!, audioFile: undefined };
  }

  /** Back-compat alias — the intro is just the first cue Ris ever had. */
  pickIntro(): { text: string; audioFile: string | undefined } {
    return this.pickLine("intro");
  }

  /** The cue with the thinnest cache gets the next render. */
  private neediestCue(): Cue {
    let best: Cue = "intro";
    let bestCount = Infinity;
    for (const c of CUES) {
      const n = this.trusted().filter((e) => (e.cue ?? "intro") === c).length;
      if (n < bestCount) { best = c; bestCount = n; }
    }
    return best;
  }

  audioPath(file: string): string | undefined {
    // Content-addressed names only — no traversal, no surprises.
    if (!/^[a-f0-9]{16}\.wav$/.test(file)) return undefined;
    const p = join(this.cfg.cacheDir, file);
    return existsSync(p) ? p : undefined;
  }

  /** One replenishment attempt: muse writes a line, Chatterbox voices it.
   *  Fills the cue with the thinnest cache so Ris learns her whole script. */
  async replenishOnce(cueOverride?: Cue): Promise<{ status: string; text?: string; cue?: Cue }> {
    if (!this.enabled) return { status: "disabled" };
    if (this.generatedToday() >= this.cfg.dailyMax) return { status: "budget_exhausted" };
    const cue = cueOverride ?? this.neediestCue();

    // 1. muse-local writes the line (through PIN, server-to-server).
    // Pulled when the closing sentinel lands — the point of streaming.
    const abort = new AbortController();
    const chatRes = await this.fetcher(`${this.cfg.aiasUrl}/api/v1/pin/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.lineModel,
        messages: [
          { role: "system", content: lineSystemPrompt(cue) },
          {
            role: "user",
            content:
              `${CUE_BRIEFS[cue]} Take your time, then close with the ` +
              `<<<${LINE_TAG}>>> block. Random seed: ${Math.floor(this.now() / 1000)}.`,
          },
        ],
        temperature: 1.0,
        // Stream, so we can hang up on <<<END>>> instead of waiting out the
        // scratchpad. Servers that ignore this just send one JSON body, which
        // the fallback below handles.
        stream: true,
        // NO token cap. muse thinks before she speaks — Mark's call: let her.
        // Every cap we tried (80, 500) choked the deliberation and content
        // came back empty. She's local, on our own A6000 — tokens are free.
      }),
      signal: abort.signal,
    });
    if (!chatRes.ok) return { status: `line_failed_${chatRes.status}`, cue };

    /**
     * Two shapes, one path.
     *
     * A streaming server sends text/event-stream and we read it until the
     * closing sentinel. Anything else — a server that ignored `stream: true`, a
     * test fake handing back a plain Response — is parsed as one JSON body. The
     * fallback is not defensive padding: the entire existing voice suite fakes
     * this endpoint with plain JSON, and those tests are the regression net for
     * this change.
     */
    const ctype = chatRes.headers?.get?.("content-type") ?? "";
    let content = "";
    let thinking = "";
    let finishReason: string | undefined;
    let streamNote = "";

    if (ctype.includes("text/event-stream") && chatRes.body !== null && chatRes.body !== undefined) {
      const streamed = await readSseCompletion(chatRes.body, () => abort.abort());
      content = streamed.content;
      thinking = streamed.thinking;
      finishReason = streamed.finishReason;
      streamNote = ` [stream: ${streamed.events} event(s)${streamed.stoppedEarly ? ", hung up on <<<END>>>" : ""}]`;
    } else {
      const chat = (await chatRes.json()) as {
        choices?: {
          finish_reason?: string;
          message?: { content?: string; reasoning_content?: string; thinking?: string };
          text?: string;
        }[];
      };
      console.log(`[voice] muse response (${cue}): ${JSON.stringify(chat).slice(0, 600)}`);
      const msg = chat.choices?.[0];
      content = msg?.message?.content ?? msg?.text ?? "";
      thinking = msg?.message?.thinking ?? msg?.message?.reasoning_content ?? "";
      finishReason = msg?.finish_reason;
    }

    // The model says DONE by closing a sentinel block. A cut-off completion
    // can't have closed one — fail loudly rather than parsing a fragment.
    // (Streaming makes this rare: we stop AT the marker, so a `length` finish
    // means the cap hit before she ever got there.)
    if (finishReason === "length") {
      console.log(`[voice] muse was TRUNCATED (finish_reason=length) — no cap is set, check the upstream limit`);
      return { status: "line_truncated", cue };
    }

    const found = findLine(content, thinking);
    if (!found.ok) {
      /**
       * Say WHICH failure this is. "No usable block" for both a missing block
       * and a rejected-by-our-own-gate line is what cost a debugging loop in
       * live play — the block had arrived whole and closed.
       */
      if (found.reason === "NO_BLOCK") {
        console.log(
          `[voice] no <<<${LINE_TAG}>>> block in either channel${streamNote}. ` +
          `content(${content.length}) tail: ${JSON.stringify(content.slice(-200))} | ` +
          `thinking(${thinking.length}) tail: ${JSON.stringify(thinking.slice(-300))}`,
        );
        return { status: "line_no_block", cue };
      }
      console.log(
        `[voice] block found but REJECTED by our gate (${found.reason})${streamNote}: ` +
        `${JSON.stringify(found.extracted ?? "")}`,
      );
      return { status: `line_rejected_${found.reason.toLowerCase()}`, cue };
    }
    const line = found.line;
    console.log(`[voice] line accepted from ${found.channel}${streamNote}: ${JSON.stringify(line)}`);

    const hash = createHash("sha256").update(line).digest("hex").slice(0, 16);
    if (this.manifest.entries.some((e) => e.hash === hash)) return { status: "duplicate", cue };

    // 2. Chatterbox voices it (through PIN).
    const ttsRes = await this.fetcher(`${this.cfg.aiasUrl}/api/v1/pin/audio/speech`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.ttsModel,
        input: line,
        voice: this.cfg.voice,
        response_format: "wav",
      }),
    });
    if (!ttsRes.ok) return { status: `tts_failed_${ttsRes.status}`, cue };
    const audio = Buffer.from(await ttsRes.arrayBuffer());
    if (audio.length < 100) return { status: "tts_empty", cue };

    const file = `${hash}.wav`;
    writeFileSync(join(this.cfg.cacheDir, file), audio);
    this.manifest.entries.push({
      hash, text: line, file, createdAt: this.now(), source: "muse", cue, parser: TRUSTED_PARSER,
    });
    this.save();
    console.log(`[voice] new Ris ${cue} line cached (${audio.length} bytes): "${line}"`);
    return { status: "ok", text: line, cue };
  }

  /** Drip wrapper: EVERY outcome hits the log — a silent failure cost us a
   *  night of "why is audioUrl null". Never again. A failed attempt retries in
   *  90s (up to 5 in a row) instead of waiting hours for the next drip tick. */
  private failStreak = 0;
  private async replenishLogged(): Promise<void> {
    try {
      const r = await this.replenishOnce();
      if (r.status === "ok") {
        this.failStreak = 0;
        // Warm-up sprint: until EVERY cue has at least one voiced line, keep
        // rendering every 15s (budget still rules). Ris has a show tonight —
        // she can't learn one cue per 144 minutes.
        const empty = CUES.filter((c) => !this.trusted().some((e) => (e.cue ?? "intro") === c));
        if (empty.length === 0) {
          console.log(`[voice] warm-up complete — every cue has a voice`);
          return;
        }
        // The silent skip cost us a debugging round: the sprint looked broken
        // when it was only out of budget. Say WHY it stopped.
        if (this.generatedToday() >= this.cfg.dailyMax) {
          console.log(
            `[voice] warm-up HELD: budget spent (${this.generatedToday()}/${this.cfg.dailyMax} today), ` +
            `${empty.length} cue(s) still silent (${empty.join(", ")}) — raise GWW_VOICE_DAILY_MAX to finish tonight`,
          );
          return;
        }
        console.log(`[voice] warm-up: ${empty.length} cue(s) still silent (${empty.join(", ")}) — next render in 15s`);
        setTimeout(() => void this.replenishLogged(), 15_000).unref?.();
        return;
      }
      console.log(`[voice] replenish: ${r.status}${r.cue !== undefined ? ` (cue: ${r.cue})` : ""}`);
      const transient = r.status !== "disabled" && r.status !== "budget_exhausted";
      if (transient && this.failStreak < 5) {
        this.failStreak += 1;
        console.log(`[voice] retrying in 90s (attempt ${this.failStreak}/5)`);
        setTimeout(() => void this.replenishLogged(), 90_000).unref?.();
      }
    } catch (err) {
      console.log(`[voice] replenish threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Background drip: spaced so the daily budget is spread across the day. */
  start(): void {
    if (!this.enabled) {
      console.log("[voice] AIAS_API_KEY not set — pipeline off, L0 captions only");
      return;
    }
    const intervalMs = Math.max(1, Math.floor((24 * 60 * 60 * 1000) / Math.max(1, this.cfg.dailyMax)));
    console.log(`[voice] pipeline on: max ${this.cfg.dailyMax}/day, one attempt every ${Math.round(intervalMs / 60000)}m`);
    // First attempt shortly after boot, then the drip.
    setTimeout(() => void this.replenishLogged(), 15_000).unref?.();
    this.timer = setInterval(() => void this.replenishLogged(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
