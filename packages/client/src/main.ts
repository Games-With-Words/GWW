/**
 * Games With Words client — the arcade, the board, the phones.
 *
 * Topology (Mark, 2026-08-23): the creating device (desktop/TV) is the BOARD —
 * QR, scores, clues, captions, never a player. Phones scan in and play. The
 * HOST is picked at random when the game starts. No framework: one state
 * object, one render pass, big thumb targets. The server is the authority.
 */

import QRCode from "qrcode";
import { scenes, score } from "./cinema.js";
import { api, openSocket, type CreatedRoom, type GameTile, type Socket } from "./api.js";
import {
  amHost,
  initialRoom,
  joinUrl,
  msLeft,
  nameOf,
  reduce,
  roleOf,
  type RoomState,
} from "./state.js";
import { viewFor, type ViewHelpers } from "./games/index.js";

declare const __BUILD__: string;
// A stale cached bundle cost us a debugging session — the build now announces
// itself so "which version am I actually running?" is a one-glance question.
console.log(`%cGames With Words · client build ${__BUILD__}`, "color:#ffd166;font-weight:bold");

const app = document.getElementById("app")!;

type Screen =
  | { kind: "home"; games: GameTile[] }
  | { kind: "join"; code: string; token?: string }
  | { kind: "room" };

let screen: Screen = { kind: "home", games: [] };
let room: RoomState | undefined;
let created: CreatedRoom | undefined;
let socket: Socket | undefined;
let roomId = "";
let myToken = "";
let asBoard = false;
let busy = false;
let formError = "";
let ticker: ReturnType<typeof setInterval> | undefined;
/**
 * Which game this room is playing, from the server's hello.
 *
 * The client used to have no need for this — there was one game, so every render
 * path could assume Say Less. It is now the key into the view registry, and the
 * lobby reads the matching tile for the real minimum table size.
 */
let gameId = "";
let tiles: GameTile[] = [];

/** Everything a game view is allowed to reach for. */
const helpers: ViewHelpers = {
  el,
  esc,
  command,
  nameOf,
  amHost,
  scores: scoreCard,
};

function currentView() {
  return viewFor(gameId);
}

/* ------------------------------------------------------------------ boot */

function parseHash(): void {
  const m = /^#\/join\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(location.hash);
  if (m !== null) {
    screen = { kind: "join", code: m[1]!, ...(m[2] !== undefined ? { token: m[2] } : {}) };
  }
}

async function boot(): Promise<void> {
  parseHash();
  // Fetch the shelf even when joining by link: a phone that lands straight in a
  // room still needs the manifest to know the game's real minimum table size.
  try {
    tiles = await api.games();
  } catch {
    tiles = [];
  }
  if (screen.kind === "home") {
    screen = { kind: "home", games: tiles };
  }
  render();
}

/* ------------------------------------------------------------ networking */

function connect(rid: string, token: string, board: boolean): void {
  roomId = rid;
  myToken = token;
  asBoard = board;
  socket = openSocket(
    rid,
    token,
    (msg) => {
      if (msg.type === "hello") {
        const d = msg["data"] as {
          playerId?: string; isHost?: boolean; board?: boolean;
          roomState: string; snapshot?: unknown; gameId?: string;
        };
        if (typeof d.gameId === "string" && d.gameId !== "") gameId = d.gameId;
        room = initialRoom(d.playerId ?? "board", d.isHost ?? false, d.roomState, d.board === true);
        if (d.snapshot !== undefined && d.snapshot !== null) {
          room = reduce(room, { type: "state", data: d.snapshot });
        }
      } else if (room !== undefined) {
        const before = room;
        room = reduce(room, msg);
        if (msg.type === "event") {
          const ev = msg["data"] as { type?: string; [k: string]: unknown } | undefined;
          if (ev?.type !== undefined) void risHosts(ev);
          if (room.isBoard && ev?.type !== undefined) boardCinema(before, room, ev);
        }
        if (msg.type === "error") setTimeout(() => { if (room?.error !== undefined) { room = { ...room, error: undefined }; render(); } }, 4000);
      }
      screen = { kind: "room" };
      render();
    },
    (code) => {
      // 4404 = the room is gone. Reconnecting forever just floods the server
      // log with zombies (seen live: dead tabs hammering every 2s). Stop, and
      // tell the human to start fresh.
      if (code === 4404) {
        room = undefined;
        screen = { kind: "home", games: [] };
        formError = "That room has ended. Start a new one!";
        void boot();
        return;
      }
      if (screen.kind === "room") setTimeout(() => connect(roomId, myToken, asBoard), 1500);
    },
    board,
  );
}

function command(name: string, payload: Record<string, unknown> = {}): void {
  socket?.send({ type: "command", name, payload });
}

/* -------------------------------------------------------- board cinema */

let creditsRolled = false;
function boardCinema(before: RoomState, after: RoomState, ev: { type?: string; [k: string]: unknown }): void {
  switch (ev.type) {
    case "game.started":
      scenes.title("Say Less");
      return;
    case "round.started":
      score.roundOpen();
      return;
    case "clue.accepted":
      score.clue();
      return;
    case "guess.submitted":
      score.guess();
      return;
    case "round.completed": {
      const secret = String(ev["secret"] ?? "");
      const winnerId = ev["winnerId"] !== undefined ? String(ev["winnerId"]) : undefined;
      const line = after.game?.round?.revealLine;
      if (secret.length > 0) {
        scenes.reveal(secret, line, winnerId !== undefined ? nameOf(after, winnerId) : undefined);
      }
      return;
    }
    case "game.completed": {
      if (creditsRolled) return;
      creditsRolled = true;
      const totals = (ev["totals"] ?? {}) as Record<string, number>;
      const cast = after.players.map((p) => ({ name: p.displayName, score: totals[p.id] ?? 0 }));
      scenes.credits(cast, "SAY LESS", "The Oracle");
      return;
    }
  }
  void before;
}

/** Countdown pressure: tick each second under 10s (board only). */
let lastTickSecond = -1;
function boardTick(): void {
  if (room?.isBoard !== true || room.game?.status !== "IN_ROUND") return;
  const ms = msLeft(room, Date.now());
  if (ms === undefined) return;
  const secs = Math.ceil(ms / 1000);
  if (secs <= 10 && secs >= 0 && secs !== lastTickSecond) {
    lastTickSecond = secs;
    score.tick(10 - secs);
  }
}

/** Ris hosts the whole night from the board — she calls the round, lands the
 *  clue, stings the timeout, celebrates the win, signs off. Cached lines only;
 *  audio failure leaves the caption — the party never waits (spec §07). */
const CUE_FOR_EVENT: Record<string, string> = {
  "game.started": "intro",
  "round.started": "round",
  "clue.accepted": "clue",
  "game.completed": "outro",
  // The ballot and reveal have captions but no cue bank yet — once
  // `ris-lines-vote` and `ris-lines-reveal` are forged, they slot in here.
};

/**
 * ONE audio element for the whole session, unlocked by the first user gesture.
 *
 * Browsers refuse audio.play() until the page has been interacted with. The
 * old code created a fresh `new Audio(url)` per line and swallowed the
 * rejection with `.catch(() => undefined)` — so on a board nobody had clicked,
 * Ris was silent and NOTHING said why. Cached WAVs, working API, no sound, no
 * clue. Exactly the silent-failure pattern that cost us a night already.
 *
 * A single element primed inside a real gesture stays playable for the rest of
 * the session, and a blocked play now reports itself.
 */
const risAudio = new Audio();
let audioUnlocked = false;
let audioBlocked = false;
let introSpoken = false;

/**
 * A tiny valid silent WAV. Priming with an EMPTY src throws instead of
 * unlocking, which is why the first attempt at this silently did nothing —
 * the element must actually play something real inside the gesture.
 */
const SILENT_WAV =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YQAAAAA=";

/** Prime the audio element INSIDE a user gesture so later plays are allowed. */
function unlockAudio(): void {
  if (audioUnlocked) return;
  audioUnlocked = true;
  risAudio.src = SILENT_WAV;
  risAudio.play().then(() => {
    risAudio.pause();
    risAudio.currentTime = 0;
    audioBlocked = false;
  }).catch((err: unknown) => {
    // Still blocked after a real gesture — say so rather than going quiet.
    audioUnlocked = false;
    console.warn("[ris] audio still locked after gesture:", err);
  });
}
// Any interaction anywhere counts: creating the room, starting the game, a tap
// on the board. The board's own "Say Less" click is usually the one.
document.addEventListener("pointerdown", unlockAudio, { once: false });
document.addEventListener("keydown", unlockAudio, { once: false });

async function risHosts(ev: { type?: string; [k: string]: unknown }): Promise<void> {
  if (room?.isBoard !== true || ev.type === undefined) return;
  let cue = CUE_FOR_EVENT[ev.type];
  if (ev.type === "round.completed") {
    const reason = String(ev["reason"] ?? "");
    if (reason === "TIMEOUT") cue = "timeout";
    else if (reason === "CORRECT") cue = "correct";
  }
  if (cue === undefined) return;
  if (cue === "intro") {
    if (introSpoken) return;
    introSpoken = true;
  }
  try {
    const res = await fetch(`/api/voice/cue/${cue}`);
    const line = (await res.json()) as { text: string; audioUrl: string | null };
    // The intro caption is Ris's own line; other beats keep the event caption
    // (it carries specifics like the actual clue) — she voices over it.
    if (cue === "intro" && room !== undefined) {
      room = { ...room, caption: line.text };
      render();
    }
    if (line.audioUrl !== null) {
      risAudio.pause();
      risAudio.src = line.audioUrl;
      risAudio.currentTime = 0;
      try {
        await risAudio.play();
        if (audioBlocked) { audioBlocked = false; render(); }
      } catch (err) {
        // NEVER swallow this. A blocked autoplay is indistinguishable from a
        // broken pipeline unless it says so.
        console.warn(`[ris] playback blocked for cue "${cue}":`, err);
        if (!audioBlocked) { audioBlocked = true; render(); }
      }
    }
  } catch (err) {
    console.warn(`[ris] cue "${cue}" failed:`, err);
  }
}

/* ---------------------------------------------------------------- render */

function el(html: string): HTMLElement {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function render(): void {
  // A re-render must NEVER eat what the player is typing. Capture the focused
  // input before rebuilding the DOM, restore it after — found in live play:
  // every incoming message (and the old 1s ticker) blurred the clue box and
  // wiped half-typed text. Party games live and die on the keyboard.
  const active = document.activeElement as HTMLInputElement | null;
  const keepId = active !== null && active.tagName === "INPUT" ? active.id : undefined;
  const keepValue = keepId !== undefined ? active!.value : "";
  const keepPos = keepId !== undefined ? active!.selectionStart ?? keepValue.length : 0;

  app.replaceChildren();
  const boardMode = room?.isBoard === true && screen.kind === "room";
  app.classList.toggle("board", boardMode);
  document.body.classList.toggle("theater", boardMode);
  const msRemaining = room !== undefined ? msLeft(room, Date.now()) : undefined;
  document.body.classList.toggle(
    "tension",
    boardMode && room?.game?.status === "IN_ROUND" && msRemaining !== undefined && msRemaining <= 10_000,
  );
  switch (screen.kind) {
    case "home": renderHome(screen.games); break;
    case "join": renderJoin(screen.code, screen.token); break;
    case "room": renderRoom(); break;
  }
  app.append(el(`<footer>Games With Words · Interchained LLC Labs · <span class="dim">the room is the game</span> · <a href="https://github.com/Games-With-Words/GWW" target="_blank" rel="noopener noreferrer">GPLv3</a> · <span class="dim">build ${__BUILD__}</span></footer>`));

  if (keepId !== undefined) {
    const revived = document.getElementById(keepId) as HTMLInputElement | null;
    if (revived !== null) {
      revived.value = keepValue;
      revived.focus({ preventScroll: true });
      try { revived.setSelectionRange(keepPos, keepPos); } catch { /* number inputs etc. */ }
    }
  }
  syncTicker();
}

/** Update ONLY the clock text each second — a full render would blur the
 *  player's input mid-word. The DOM rebuild happens on real state changes. */
function tickClock(): void {
  if (room === undefined) return;
  const ms = msLeft(room, Date.now());
  const node = document.querySelector(".clock");
  if (node !== null && ms !== undefined) {
    const secs = Math.ceil(ms / 1000);
    node.textContent = `${secs}s`;
    node.classList.toggle("urgent", secs <= 10);
    document.body.classList.toggle(
      "tension",
      room.isBoard && room.game?.status === "IN_ROUND" && ms <= 10_000,
    );
  }
}

function syncTicker(): void {
  const running = room?.game?.deadline !== undefined && room.game.status === "IN_ROUND";
  if (running && ticker === undefined) {
    ticker = setInterval(() => { if (screen.kind === "room") { boardTick(); tickClock(); } }, 1000);
  } else if (!running && ticker !== undefined) {
    clearInterval(ticker);
    ticker = undefined;
  }
}

function countdown(s: RoomState): HTMLElement | undefined {
  const ms = msLeft(s, Date.now());
  if (ms === undefined) return undefined;
  const secs = Math.ceil(ms / 1000);
  return el(`<div class="clock${secs <= 10 ? " urgent" : ""}">${secs}s</div>`);
}

/* ------------------------------------------------------------- the arcade */

function renderHome(games: GameTile[]): void {
  app.append(el(`<div><div class="brand">Games With Words</div><h1>The room is<br/>the game.</h1><p class="tag">Put this screen where everyone can see it. Phones scan in. Then the stories begin.</p></div>`));

  const shelf = el(`<div class="stack"></div>`);
  for (const g of games) {
    const tile = el(`<button class="tile card"${busy ? " disabled" : ""}>
      <div class="maker">by ${esc(g.credit.maker)}</div>
      <h3>${esc(g.title)}</h3>
      <div class="dim">${esc(g.tagline)}</div>
      <div class="small dim">${g.minPlayers}–${g.maxPlayers} players · ${g.sessionMinutes[0]}–${g.sessionMinutes[1]} min · tap to open a room</div>
    </button>`);
    tile.addEventListener("click", () => {
      busy = true; render();
      api.createRoom(g.gameId)
        .then((c) => { created = c; connect(c.roomId, c.boardToken, true); })
        .catch((e: Error) => { formError = e.message; })
        .finally(() => { busy = false; });
    });
    shelf.append(tile);
  }
  shelf.append(el(`<div class="tile card soon"><div class="maker">by you?</div><h3>More games coming</h3><div class="dim">The arcade grows — each game made by a person, credited on its tile.</div></div>`));
  app.append(shelf);
  if (formError.length > 0) app.append(el(`<div class="error">${esc(formError)}</div>`));

  const joinCard = el(`<div class="card stack">
    <h2>Joining from your phone?</h2>
    <input id="code" type="text" placeholder="ROOM CODE" autocapitalize="characters"
           autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go" maxlength="6" />
    <button class="secondary" id="joinbtn">Join a room</button>
  </div>`);
  joinCard.querySelector("#joinbtn")!.addEventListener("click", () => {
    const code = (joinCard.querySelector("#code") as HTMLInputElement).value.trim().toUpperCase();
    if (code.length > 0) { screen = { kind: "join", code }; render(); }
  });
  app.append(joinCard);
}

/* ------------------------------------------------------------------- join */

function renderJoin(code: string, token?: string): void {
  const card = el(`<div class="card stack">
    <h2>Join room ${esc(code)}</h2>
    ${formError.length > 0 ? `<div class="error">${esc(formError)}</div>` : ""}
    <input id="name" type="text" placeholder="Your name" maxlength="24"
           autocomplete="off" autocorrect="off" autocapitalize="words" enterkeyhint="go" />
    <button id="go"${busy ? " disabled" : ""}>I'm here</button>
    <button class="secondary" id="back">Back</button>
  </div>`);
  const input = card.querySelector("#name") as HTMLInputElement;
  const submit = () => {
    const name = input.value.trim();
    if (name.length === 0 || busy) return;
    busy = true; render();
    api.joinRoom(code, name, token)
      .then((j) => { formError = ""; connect(j.roomId, j.playerToken, false); })
      .catch((e: Error) => { formError = e.message; })
      .finally(() => { busy = false; render(); });
  };
  card.querySelector("#go")!.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  card.querySelector("#back")!.addEventListener("click", () => { formError = ""; location.hash = ""; screen = { kind: "home", games: [] }; void boot(); });
  app.append(el(`<div><div class="brand">Games With Words</div></div>`), card);
  input.focus();
}

/* ------------------------------------------------------------- the room */

function renderRoom(): void {
  if (room === undefined) { app.append(el(`<div class="card">Connecting…</div>`)); return; }
  const s = room;

  if (s.error !== undefined) app.append(el(`<div class="error">${esc(s.error)}</div>`));

  if (s.game === undefined) {
    if (s.isBoard) renderBoardLobby(s); else renderPhoneLobby(s);
    return;
  }
  if (s.game.status === "COMPLETE") { renderSummary(s); return; }
  if (s.isBoard) renderBoardGame(s); else renderPhoneGame(s);
}

function caption(s: RoomState): HTMLElement | undefined {
  if (s.caption === undefined) return undefined;
  return el(`<div class="caption"><span class="who">RIS</span><br/>${esc(s.caption)}</div>`);
}

function playerList(s: RoomState): HTMLElement {
  return el(`<div class="card"><h2>In the room</h2><ul class="playerlist">${s.players
    .map((p) => `<li><span class="dot${p.connected ? "" : " off"}"></span><span class="grow">${esc(p.displayName)}${p.id === s.playerId ? " (you)" : ""}</span>${p.isHost ? `<span class="hostmark">HOST</span>` : ""}</li>`)
    .join("")}</ul></div>`);
}

/* --------------------------------------------------------------- board */

const ATTRACT_LINES = [
  "Tonight's feature: your friends, under pressure.",
  "No strangers. No accounts. No mercy.",
  "One secret word. Too few words to give it away.",
  "The best rounds become inside jokes. Bring popcorn.",
  "A random player becomes the host. Fate decides.",
];
let attractIdx = 0;
let attractTimer: ReturnType<typeof setInterval> | undefined;

function renderBoardLobby(s: RoomState): void {
  if (attractTimer === undefined) {
    attractTimer = setInterval(() => {
      attractIdx = (attractIdx + 1) % ATTRACT_LINES.length;
      if (room?.game === undefined && screen.kind === "room") render();
    }, 5000);
  }
  app.append(el(`<div class="attract-head"><div class="cine-studio-inline">INTERCHAINED LLC LABS <span>presents</span></div><h1 class="attract-title">SAY LESS</h1><p class="attract-line">${esc(ATTRACT_LINES[attractIdx]!)}</p></div>`));
  if (created !== undefined) {
    const url = joinUrl(location.origin, created.shortCode, created.joinToken);
    const card = el(`<div class="card stack">
      <div class="code">${esc(created.shortCode)}</div>
      <div class="qr"><canvas id="qr"></canvas></div>
      <div class="small dim" style="text-align:center">Scan with your phone camera · or enter the code at ${esc(location.host)}</div>
    </div>`);
    app.append(card);
    void QRCode.toCanvas(card.querySelector("#qr") as HTMLCanvasElement, url, { width: 260, margin: 1 });
  }
  app.append(playerList(s));

  /**
   * THE BOARD'S OWN START BUTTON — and it exists for a reason beyond taste.
   *
   * The board is designed never to be touched ("nobody plays on this screen"),
   * so its browser never receives a user gesture, so it NEVER gets audio
   * permission, so Ris is silent on the one device that is supposed to speak.
   * Cached WAVs, working API, dead room.
   *
   * A synthetic .click() cannot fix this: autoplay permission requires a
   * trusted event, and scripted clicks are excluded by design. The host has to
   * really tap. So make that tap worth something — it unlocks the voice AND
   * starts the game, one gesture, no extra ceremony.
   */
  if (s.players.length >= 2) {
    const go = el(`<button class="go" id="boardstart">🔊 Tap to start the show</button>`);
    go.addEventListener("click", () => {
      unlockAudio();              // inside the trusted gesture — the whole point
      socket?.send({ type: "game.start" });
    });
    app.append(go);
    app.append(el(`<p class="dim small" style="text-align:center">Tap here so Ris can speak — or start from any phone and she'll stay quiet.</p>`));
  } else {
    app.append(el(`<p class="dim" style="text-align:center">Now seating — scan to take your seat. Nobody plays on this screen.</p>`));
  }
}

/** Loud, tappable notice when the browser is refusing to let Ris speak. */
function audioNotice(s: RoomState): HTMLElement | undefined {
  if (!s.isBoard || !audioBlocked) return undefined;
  const el2 = el(`<div class="error" style="cursor:pointer">🔇 Ris can't speak — tap anywhere to enable sound</div>`);
  el2.addEventListener("click", () => {
    audioUnlocked = false;
    unlockAudio();
    risAudio.play().then(() => { audioBlocked = false; render(); }).catch(() => undefined);
  });
  return el2;
}

function renderBoardGame(s: RoomState): void {
  const g = s.game!;
  const view = currentView();
  const clock = countdown(s);
  app.append(el(`<div class="row"><span class="brand">${esc(view.title)}</span><span class="grow"></span><span class="dim">Round ${g.roundIndex + 1}</span></div>`));
  if (clock !== undefined) app.append(clock);
  const notice = audioNotice(s);
  if (notice !== undefined) app.append(notice);
  const cap = caption(s);
  if (cap !== undefined) app.append(cap);

  // The board's round area belongs to the game. Between rounds it gets its own
  // panel, falling back to the phone's reveal when a game only wrote one.
  const round = g.round;
  const live = round !== undefined && round.phase !== "COMPLETE";
  const nodes = live
    ? view.board(s, helpers)
    : (view.boardReveal ?? view.betweenRounds)(s, helpers);
  for (const n of nodes) app.append(n);

  renderScores(s);
}

/* --------------------------------------------------------------- phones */

function renderPhoneLobby(s: RoomState): void {
  app.append(el(`<div><div class="brand">Games With Words</div><h2>You're in!</h2></div>`));
  app.append(playerList(s));
  // The floor is the GAME's, not a hardcoded 2 — Ghostwriter needs three, and a
  // button that starts an unplayable session is worse than a disabled one.
  const view = currentView();
  const floor = tiles.find((t) => t.gameId === gameId)?.minPlayers ?? 2;
  const short = s.players.length < floor;
  const start = el(`<button class="go"${short ? " disabled" : ""}>Start ${esc(view.title)}${short ? ` (need ${floor}+)` : ""}</button>`);
  start.addEventListener("click", () => socket?.send({ type: "game.start" }));
  app.append(start);
  app.append(el(`<p class="dim small" style="text-align:center">Anyone can start. A random player becomes the host.</p>`));
}

function renderPhoneGame(s: RoomState): void {
  const g = s.game!;
  const view = currentView();
  const role = view.role?.(s) ?? roleOf(s);
  const clock = countdown(s);

  app.append(el(`<div class="row"><span class="rolepill ${esc(role)}">${esc(role)}</span><span class="grow"></span><span class="dim small">Round ${g.roundIndex + 1}</span></div>`));
  if (clock !== undefined) app.append(clock);
  const cap = caption(s);
  if (cap !== undefined) app.append(cap);

  /**
   * An empty node list means "nothing for a phone to do in this phase" — which
   * is how a game tells the platform the round is over without the platform ever
   * learning its phase names. Say Less returns [] on COMPLETE; so does
   * Ghostwriter; so will the next game.
   */
  const nodes = view.phone(s, helpers);
  if (nodes.length === 0) { renderBetweenRounds(s); return; }
  for (const n of nodes) app.append(n);

  renderScores(s);
}

function renderBetweenRounds(s: RoomState): void {
  for (const n of currentView().betweenRounds(s, helpers)) app.append(n);

  // The next-round button is platform furniture: every game has rounds, and the
  // host starts them. `round.start` is the one command name the contract assumes.
  if (amHost(s)) {
    const next = el(`<button class="go">Next round</button>`);
    next.addEventListener("click", () => command("round.start"));
    app.append(next);
  } else {
    app.append(el(`<p class="dim" style="text-align:center">Next round when ${esc(s.players.find((p) => p.isHost)?.displayName ?? "the host")} is ready…</p>`));
  }
  renderScores(s);
}

/** The scoreboard as a node — shared furniture every game gets for free. */
function scoreCard(s: RoomState): HTMLElement {
  const g = s.game;
  const rows = [...s.players]
    .map((p) => ({ p, score: g?.scores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  return el(`<div class="card"><h2>Scores</h2><table class="scores">${rows
    .map((r, i) => `<tr class="${i === 0 && r.score > 0 ? "winner" : ""}"><td>${esc(r.p.displayName)}${r.p.id === s.playerId ? " (you)" : ""}</td><td>${r.score}</td></tr>`)
    .join("")}</table></div>`);
}

function renderScores(s: RoomState): void {
  if (s.game === undefined) return;
  app.append(scoreCard(s));
}

function renderSummary(s: RoomState): void {
  app.append(el(`<div><div class="brand">Games With Words</div><h1>That's the game!</h1></div>`));
  const cap = caption(s);
  if (cap !== undefined) app.append(cap);
  renderScores(s);
  app.append(el(`<p class="dim" style="text-align:center">Tell the story afterward — the best rounds become your group's new inside jokes.</p>`));
  const again = el(`<button class="secondary">Back to the arcade</button>`);
  again.addEventListener("click", () => { location.hash = ""; location.reload(); });
  app.append(again);
}

window.addEventListener("hashchange", () => { if (screen.kind !== "room") { parseHash(); render(); } });
void boot();
