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

interface VoiceEntry {
  hash: string;
  text: string;
  file: string;
  createdAt: number;
  source: "muse" | "seed";
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

const LINE_SYSTEM_PROMPT =
  "You are Ris, the host of Games With Words — a private, in-person party game " +
  "played by friends and family in one room. Write EXACTLY ONE fresh opening line " +
  "to welcome the room and kick off a game of Say Less. Rules: under 25 words; " +
  "warm, funny, a little mischievous; roast the MOMENT never a person; no emojis; " +
  "no quotation marks; no stage directions; plain speakable text only. " +
  "Randomize your angle every time — never repeat a structure you have used before.";

/** Deterministic sanity gate for generated lines — reject junk before it costs a render. */
export function validateLine(raw: string): string | undefined {
  let line = raw.trim().replace(/^["'“‘]+|["'”’]+$/g, "").trim();
  if (line.includes("\n")) line = line.split("\n")[0]!.trim();
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
   * Pick an intro for a starting game. Cached voiced lines win; otherwise a
   * hand-written L0 line, caption-only. NEVER waits on generation.
   */
  pickIntro(): { text: string; audioFile: string | undefined } {
    const voiced = this.manifest.entries;
    if (voiced.length > 0) {
      const e = voiced[Math.floor(Math.random() * voiced.length)]!;
      const path = join(this.cfg.cacheDir, e.file);
      if (existsSync(path)) return { text: e.text, audioFile: e.file };
    }
    return {
      text: L0_INTRO_LINES[Math.floor(Math.random() * L0_INTRO_LINES.length)]!,
      audioFile: undefined,
    };
  }

  audioPath(file: string): string | undefined {
    // Content-addressed names only — no traversal, no surprises.
    if (!/^[a-f0-9]{16}\.wav$/.test(file)) return undefined;
    const p = join(this.cfg.cacheDir, file);
    return existsSync(p) ? p : undefined;
  }

  /** One replenishment attempt: muse writes a line, Chatterbox voices it. */
  async replenishOnce(): Promise<{ status: string; text?: string }> {
    if (!this.enabled) return { status: "disabled" };
    if (this.generatedToday() >= this.cfg.dailyMax) return { status: "budget_exhausted" };

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
          { role: "system", content: LINE_SYSTEM_PROMPT },
          { role: "user", content: `Write tonight's opening line. Random seed: ${Math.floor(this.now() / 1000)}.` },
        ],
        temperature: 1.0,
        max_tokens: 80,
      }),
    });
    if (!chatRes.ok) return { status: `line_failed_${chatRes.status}` };
    const chat = (await chatRes.json()) as { choices?: { message?: { content?: string } }[] };
    const line = validateLine(chat.choices?.[0]?.message?.content ?? "");
    if (line === undefined) return { status: "line_rejected" };

    const hash = createHash("sha256").update(line).digest("hex").slice(0, 16);
    if (this.manifest.entries.some((e) => e.hash === hash)) return { status: "duplicate" };

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
    if (!ttsRes.ok) return { status: `tts_failed_${ttsRes.status}` };
    const audio = Buffer.from(await ttsRes.arrayBuffer());
    if (audio.length < 100) return { status: "tts_empty" };

    const file = `${hash}.wav`;
    writeFileSync(join(this.cfg.cacheDir, file), audio);
    this.manifest.entries.push({ hash, text: line, file, createdAt: this.now(), source: "muse" });
    this.save();
    console.log(`[voice] new Ris intro cached (${audio.length} bytes): "${line}"`);
    return { status: "ok", text: line };
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
    setTimeout(() => void this.replenishOnce().catch(() => undefined), 15_000).unref?.();
    this.timer = setInterval(() => void this.replenishOnce().catch(() => undefined), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
