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

/** The moments Ris hosts. Every cue has L0 text, cached audio, and a muse brief. */
export type Cue =
  | "intro"
  | "round"
  | "clue"
  | "timeout"
  | "correct"
  | "outro";

export const CUES: Cue[] = ["intro", "round", "clue", "timeout", "correct", "outro"];

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
};

/** What muse is asked to write, per cue. One line, speakable, under 25 words. */
const CUE_BRIEFS: Record<Cue, string> = {
  intro: "Write EXACTLY ONE fresh opening line to welcome the room and kick off a game of Say Less.",
  round: "Write EXACTLY ONE fresh line announcing a new round is starting: the Speaker just got a secret word, everyone else should get ready to guess.",
  clue: "Write EXACTLY ONE fresh line announcing the Speaker's clue just landed and the guessers should start guessing fast.",
  timeout: "Write EXACTLY ONE fresh line for the moment time runs out and NOBODY guessed the word — playful sting, roast the moment never a person.",
  correct: "Write EXACTLY ONE fresh celebratory line for the moment someone guesses the secret word correctly.",
  outro: "Write EXACTLY ONE fresh sign-off line for the end of the game — send the room off laughing.",
};

interface VoiceEntry {
  hash: string;
  text: string;
  file: string;
  createdAt: number;
  source: "muse" | "seed";
  /** Which hosting moment this line serves. Legacy entries default to intro. */
  cue?: Cue;
}

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

const lineSystemPrompt = (cue: Cue): string =>
  "You are Ris, the host of Games With Words — a private, in-person party game " +
  "played by friends and family in one room. " + CUE_BRIEFS[cue] + " Rules: under 25 words; " +
  "warm, funny, a little mischievous; roast the MOMENT never a person; no emojis; " +
  "no quotation marks; no stage directions; plain speakable text only. " +
  "Randomize your angle every time — never repeat a structure you have used before.";

/** Deterministic sanity gate for generated lines — reject junk before it costs a render. */
export function validateLine(raw: string): string | undefined {
  // Local models often narrate before they answer — strip reasoning blocks
  // and take the LAST non-empty line, which is where the actual answer lives.
  let line = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const parts = line.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (parts.length > 0) line = parts[parts.length - 1]!;
  line = line.replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 4 || words.length > 30) return undefined;
  if (/https?:|<|>|\{|\}/.test(line)) return undefined;
  if (!/[a-zA-Z]/.test(line)) return undefined;
  return line;
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
    return this.manifest.entries.filter((e) => e.createdAt >= midnight).length;
  }

  /**
   * Pick a line for a hosting moment. Cached voiced lines win; otherwise a
   * hand-written L0 line, caption-only. NEVER waits on generation.
   */
  pickLine(cue: Cue): { text: string; audioFile: string | undefined } {
    const voiced = this.manifest.entries.filter((e) => (e.cue ?? "intro") === cue);
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
      const n = this.manifest.entries.filter((e) => (e.cue ?? "intro") === c).length;
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
          { role: "user", content: `Write tonight's opening line. Random seed: ${Math.floor(this.now() / 1000)}.` },
        ],
        temperature: 1.0,
        max_tokens: 80,
      }),
    });
    if (!chatRes.ok) return { status: `line_failed_${chatRes.status}`, cue };
    const chat = (await chatRes.json()) as { choices?: { message?: { content?: string } }[] };
    const raw = chat.choices?.[0]?.message?.content ?? "";
    const line = validateLine(raw);
    if (line === undefined) {
      // Show WHAT was rejected — a bare "line_rejected" cost us a debugging loop.
      console.log(`[voice] rejected muse output (${raw.length} chars): ${JSON.stringify(raw.slice(0, 200))}`);
      return { status: "line_rejected", cue };
    }

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
    this.manifest.entries.push({ hash, text: line, file, createdAt: this.now(), source: "muse", cue });
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
