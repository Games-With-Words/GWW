/**
 * Games With Words client — the arcade, the board, the phones.
 *
 * Topology (Mark, 2026-08-23): the creating device (desktop/TV) is the BOARD —
 * QR, scores, clues, captions, never a player. Phones scan in and play. The
 * HOST is picked at random when the game starts. No framework: one state
 * object, one render pass, big thumb targets. The server is the authority.
 */

import QRCode from "qrcode";
import { scenes, score, type Crown } from "./cinema.js";
import { api, openSocket, type CreatedRoom, type GameTile, type Socket } from "./api.js";
import {
  amHost,
  hasGuessed,
  initialRoom,
  joinUrl,
  msLeft,
  nameOf,
  reduce,
  roleOf,
  type RoomState,
} from "./state.js";

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

/* ------------------------------------------------------------------ boot */

function parseHash(): void {
  const m = /^#\/join\/([A-Za-z0-9]+)(?:\/([A-Za-z0-9_-]+))?$/.exec(location.hash);
  if (m !== null) {
    screen = { kind: "join", code: m[1]!, ...(m[2] !== undefined ? { token: m[2] } : {}) };
  }
}

async function boot(): Promise<void> {
  parseHash();
  if (screen.kind === "home") {
    try {
      screen = { kind: "home", games: await api.games() };
    } catch {
      screen = { kind: "home", games: [] };
    }
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
          roomState: string; snapshot?: unknown;
        };
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

/**
 * What the room crowned, joined up for the board.
 *
 * The award winners arrive as slotId + playerId + votes — deliberately, since
 * the ballot is anonymous right up until the reveal. The guess TEXT lives in
 * the ballot, and the name lives in the player list, so the board's version of
 * the payoff has to be assembled here from all three. Returns [] when there
 * was no ballot (under four players it never runs), and the reveal falls back
 * to its old shape.
 */
function crownsFor(s: RoomState): Crown[] {
  const round = s.game?.round;
  const rev = round?.reveal;
  if (round === undefined || rev === undefined) return [];
  const textOf = (slotId: string): string | undefined =>
    round.ballot?.find((b) => b.slotId === slotId)?.text;

  const out: Crown[] = [];
  for (const [category, winners] of [
    ["FUNNIEST", rev.funniest],
    ["CLOSEST", rev.closest],
  ] as const) {
    for (const w of winners) {
      const text = textOf(w.slotId);
      // No text means no headline, and a crown with no guess on it is just a
      // name — not worth a beat. Skip rather than show an empty slab.
      if (text === undefined || text.length === 0) continue;
      out.push({ category, text, who: nameOf(s, w.playerId), votes: w.votes });
    }
  }
  return out;
}

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
        scenes.reveal(
          secret,
          line,
          winnerId !== undefined ? nameOf(after, winnerId) : undefined,
          crownsFor(after),
        );
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

/**
 * Who has answered, without saying WHAT — the tension without the spoiler.
 * Shown while guessing; the words themselves land at the reveal.
 */
function answeredSoFar(s: RoomState): HTMLElement | undefined {
  const round = s.game?.round;
  if (round === undefined || round.phase !== "GUESSING") return undefined;
  const total = s.players.length - 1;
  const done = round.guessedPlayerIds;
  if (done.length === 0) return undefined;
  return el(`<div class="card"><h2>Locked in · ${done.length}/${total}</h2><ul class="playerlist">${done
    .map((id) => `<li><span class="dot"></span><span class="grow">${esc(nameOf(s, id))}</span><span class="dim small">answered</span></li>`)
    .join("")}</ul></div>`);
}

/** The anonymous ballot as the BOARD shows it — big, unattributed. */
function ballotBoard(s: RoomState): HTMLElement | undefined {
  const round = s.game?.round;
  if (round?.ballot === undefined || round.phase !== "BALLOT") return undefined;
  const cast = round.votedBy?.length ?? 0;
  return el(`<div class="card stack">
    <h2>The guesses — vote on your phone</h2>
    <ul class="ballot">${round.ballot
      .map((b) => `<li class="ballotrow"><span class="slot">${esc(b.text)}</span></li>`)
      .join("")}</ul>
    <div class="budget">${cast} vote${cast === 1 ? "" : "s"} in · nobody knows who wrote what</div>
  </div>`);
}

/** The reveal: who wrote what, who was right, who the room picked. */
function revealPanel(s: RoomState): HTMLElement | undefined {
  const round = s.game?.round;
  const rev = round?.reveal;
  if (rev === undefined) return undefined;
  const winners = (list: { slotId: string; playerId: string; votes: number }[]): string =>
    list.length === 0
      ? `<span class="dim">no votes</span>`
      : list.map((w) => `${esc(nameOf(s, w.playerId))} <span class="dim">(${w.votes})</span>`).join(" &amp; ");
  const rows = (round?.guesses ?? []).map((g) => {
    const funny = rev.funniest.some((w) => w.playerId === g.playerId);
    const close = rev.closest.some((w) => w.playerId === g.playerId);
    const badges = [g.correct ? `<span class="badge hit">CORRECT</span>` : "",
      funny ? `<span class="badge funny">FUNNIEST</span>` : "",
      close ? `<span class="badge close">CLOSEST</span>` : ""].join("");
    return `<li class="${g.correct ? "hit" : "miss"}"><b>${esc(nameOf(s, g.playerId))}</b> ${esc(g.value)} ${badges}</li>`;
  }).join("");
  return el(`<div class="card stack">
    <h2>The reveal</h2>
    <ul class="guessfeed">${rows}</ul>
    <div class="budget">Funniest: ${winners(rev.funniest)} · Closest: ${winners(rev.closest)}</div>
  </div>`);
}

/**
 * The phone ballot: every guess, two buttons each.
 *
 * Own guess is disabled — the server rejects a self-vote anyway, but a button
 * that errors is worse than one that is visibly not for you. A cast vote greys
 * its whole category so you can see what you already did.
 */
function ballotPhone(s: RoomState): HTMLElement | undefined {
  const round = s.game?.round;
  if (round?.ballot === undefined || round.phase !== "BALLOT") return undefined;

  const isSpeaker = round.speakerId === s.playerId;
  const myGuess = round.guessedPlayerIds.includes(s.playerId);
  const castF = round.votedBy?.some((v) => v.voterId === s.playerId && v.category === "FUNNIEST") === true;
  const castC = round.votedBy?.some((v) => v.voterId === s.playerId && v.category === "CLOSEST") === true;

  const wrap = el(`<div class="card stack">
    <h2>Vote</h2>
    <p class="dim small">Nobody can see who wrote what. ${isSpeaker
      ? "You know the answer, so you only pick the funniest."
      : "Pick the funniest and the closest."}</p>
    <ul class="ballot" id="rows"></ul>
  </div>`);
  const rows = wrap.querySelector("#rows")!;

  for (const b of round.ballot) {
    // We cannot know which slot is ours from the ballot alone — by design.
    // The server refuses a self-vote; this is belt-and-braces for the case
    // where a player has a guess in play at all.
    const row = el(`<li class="ballotrow">
      <span class="slot">${esc(b.text)}</span>
      <span class="votebtns">
        <button class="vote funny" data-cat="FUNNIEST" data-slot="${esc(b.slotId)}"${castF ? " disabled" : ""}>😂</button>
        ${isSpeaker ? "" : `<button class="vote close" data-cat="CLOSEST" data-slot="${esc(b.slotId)}"${castC ? " disabled" : ""}>🎯</button>`}
      </span>
    </li>`);
    rows.append(row);
  }
  rows.querySelectorAll("button.vote").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el2 = btn as HTMLButtonElement;
      command("ballot.vote", { category: el2.dataset["cat"], slotId: el2.dataset["slot"] });
    });
  });

  const need = [castF ? "" : "funniest", isSpeaker || castC ? "" : "closest"].filter(Boolean);
  wrap.append(el(`<div class="budget">${need.length === 0
    ? "Votes in. Waiting on the room…"
    : `Still to pick: ${need.join(" and ")}`}</div>`));
  void myGuess;
  return wrap;
}

function guessFeed(s: RoomState): HTMLElement | undefined {
  const guesses = s.game?.round?.guesses ?? [];
  if (guesses.length === 0) return undefined;
  return el(`<div class="card"><h2>Guesses</h2><ul class="guessfeed">${guesses
    .map((g) => `<li class="${g.correct ? "hit" : "miss"}"><b>${esc(nameOf(s, g.playerId))}</b> ${esc(g.value)} ${g.correct ? "✓" : "✗"}</li>`)
    .join("")}</ul></div>`);
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

/**
 * The two strips that were black bars.
 *
 * They used to be 4vh of pure black at the top and bottom of a 16:9 UI on a
 * 16:9 TV — letterboxing a format nothing was cropped to. Cinema letterboxes
 * because the source is wider than the frame; broadcast doesn't letterbox, it
 * has a tally light and a lower third. So the best two strips of real estate on
 * the television now carry the two facts people ask for all night: how long is
 * left, and who is winning.
 *
 * It also fixes a layout problem: the scoreboard was rendered LAST, at the
 * bottom of a scrolling column, on a screen nobody can touch to scroll.
 * Standings are permanent furniture now.
 */
function boardFurniture(s: RoomState): HTMLElement[] {
  const g = s.game!;
  const round = g.round;
  const live = g.status === "IN_ROUND";
  const ms = msLeft(s, Date.now());
  const secs = ms !== undefined ? Math.ceil(ms / 1000) : undefined;

  const top = el(`<div class="tally">
    <span class="onair${live ? " live" : ""}"><i></i>${live ? "ON AIR" : "STANDBY"}</span>
    <span class="grow"></span>
    <span class="tally-show">SAY LESS · ROUND ${g.roundIndex + 1} OF ${g.maxRounds}</span>
    <span class="grow"></span>
    ${secs !== undefined ? `<span class="clock${secs <= 10 ? " urgent" : ""}">${secs}s</span>` : `<span class="clock dim">—</span>`}
  </div>`);

  // The lower third answers whatever the room is currently wondering about.
  let lower: string;
  if (round?.phase === "BALLOT") {
    const cast = new Set((round.votedBy ?? []).map((v) => v.voterId)).size;
    lower = `<span class="lt-label">VOTING</span><span>${cast} of ${s.players.length} in · nobody knows who wrote what</span>`;
  } else if (round?.phase === "GUESSING" && (round.guessedPlayerIds ?? []).length > 0) {
    const inNames = (round.guessedPlayerIds ?? []).map((id) => nameOf(s, id)).join(" · ");
    lower = `<span class="lt-label">LOCKED IN</span><span>${esc(inNames)}</span>`;
  } else {
    const board = [...s.players]
      .map((p) => ({ name: p.displayName, n: g.scores[p.id] ?? 0 }))
      .sort((a, b) => b.n - a.n);
    const best = board[0]?.n ?? 0;
    lower = `<span class="lt-label">STANDINGS</span>` + board
      .map((r) => `<span class="lt-score${r.n === best && best > 0 ? " lead" : ""}">${esc(r.name)} <b>${r.n}</b></span>`)
      .join("");
  }
  return [top, el(`<div class="lowerthird">${lower}</div>`)];
}

function renderBoardGame(s: RoomState): void {
  const g = s.game!;
  const round = g.round;
  for (const strip of boardFurniture(s)) app.append(strip);
  const notice = audioNotice(s);
  if (notice !== undefined) app.append(notice);
  const cap = caption(s);
  if (cap !== undefined) app.append(cap);

  if (round !== undefined && round.phase !== "COMPLETE") {
    if (round.phase === "AWAITING_CLUE") {
      app.append(el(`<div class="card reveal"><h2>${esc(nameOf(s, round.speakerId))} is composing a clue…</h2><p class="dim">Category: ${esc(round.category)} · up to ${round.budget} words</p></div>`));
    } else {
      app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">— ${esc(nameOf(s, round.speakerId))}${round.phase === "VOTING" ? " · LOOPHOLE VOTE IN PROGRESS" : ""}</div></div>`));
      const bb = ballotBoard(s);
      if (bb !== undefined) app.append(bb);
      const answered = answeredSoFar(s);
      if (answered !== undefined) app.append(answered);
    }
    const feed = guessFeed(s);
    if (feed !== undefined) app.append(feed);
  } else if (s.lastReveal !== undefined) {
    app.append(el(`<div class="card reveal stack">
      <div class="small dim">THE ANSWER WAS</div>
      <div class="word">${esc(s.lastReveal.secret)}</div>
      ${round?.revealLine !== undefined ? `<div class="dim revealline">“${esc(round.revealLine)}”</div>` : ""}
      <div class="dim">${s.lastReveal.winnerId !== undefined ? `${esc(nameOf(s, s.lastReveal.winnerId))} got it!` : s.lastReveal.reason === "TIMEOUT" ? "Nobody got it." : "Round scrapped."}</div>
    </div>`));
  }
  renderScores(s);
}

/* --------------------------------------------------------------- phones */

function renderPhoneLobby(s: RoomState): void {
  app.append(el(`<div><div class="brand">Games With Words</div><h2>You're in!</h2></div>`));
  app.append(playerList(s));
  const start = el(`<button class="go"${s.players.length < 2 ? " disabled" : ""}>Start Say Less${s.players.length < 2 ? " (need 2+)" : ""}</button>`);
  start.addEventListener("click", () => socket?.send({ type: "game.start" }));
  app.append(start);
  app.append(el(`<p class="dim small" style="text-align:center">Anyone can start. A random player becomes the host.</p>`));
}

function renderPhoneGame(s: RoomState): void {
  const g = s.game!;
  const round = g.round;
  const role = roleOf(s);
  const clock = countdown(s);

  app.append(el(`<div class="row"><span class="rolepill ${role}">${role}</span><span class="grow"></span><span class="dim small">Round ${g.roundIndex + 1}</span></div>`));
  if (clock !== undefined) app.append(clock);
  const cap = caption(s);
  if (cap !== undefined) app.append(cap);

  if (round === undefined || round.phase === "COMPLETE") { renderBetweenRounds(s); return; }

  // The ballot replaces the guessing UI entirely — one job per screen.
  const phoneBallot = ballotPhone(s);
  if (phoneBallot !== undefined) {
    app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">by ${esc(nameOf(s, round.speakerId))}</div></div>`));
    app.append(phoneBallot);
    renderScores(s);
    return;
  }

  // Speaker: the secret card lives here and only here.
  if (role === "SPEAKER") {
    if (s.secret !== undefined) {
      const c = s.secret;
      app.append(el(`<div class="card secretcard stack">
        <div class="small dim" style="text-align:center">YOUR SECRET · ${esc(c.card.category)} · don't say the red words</div>
        <div class="secretword">${esc(c.card.secret)}</div>
        <div class="forbidden">${c.card.forbidden.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
        <div class="budget">Make them say it — up to ${c.budget} words</div>
      </div>`));
    } else {
      app.append(el(`<div class="card">Fetching your secret…</div>`));
    }
    if (round.phase === "AWAITING_CLUE") {
      // A textarea, not an input: the budget now runs to 20 words, and a
      // sentence that long scrolls out of sight in a single-line field on a
      // phone. You cannot edit what you cannot read.
      const form = el(`<div class="card stack composer">
        <textarea id="clue" rows="3" placeholder="Write the clue that makes them say it…"
               autocomplete="off" autocorrect="on" spellcheck="false" enterkeyhint="send"></textarea>
        <div id="count" class="wordcount">0 / ${round.budget} words</div>
        <button id="send">Send clue to the room</button>
      </div>`);
      const input = form.querySelector("#clue") as HTMLTextAreaElement;
      const count = form.querySelector("#count") as HTMLElement;
      const send = form.querySelector("#send") as HTMLButtonElement;
      // The budget is a CEILING, never a quota — a three-word clue that lands is
      // a perfectly good round. So the counter only ever objects to going OVER,
      // and never nags you toward spending the rest of it.
      const words = (): number => input.value.trim().split(/\s+/).filter((w) => w.length > 0).length;
      const refresh = (): void => {
        const n = words();
        const over = n > round.budget;
        count.textContent = over
          ? `${n} / ${round.budget} words — ${n - round.budget} over`
          : `${n} / ${round.budget} words`;
        count.classList.toggle("over", over);
        send.disabled = over || n === 0;
      };
      const submit = (): void => {
        if (words() > 0 && words() <= round.budget) command("clue.submit", { clue: input.value.trim() });
      };
      input.addEventListener("input", refresh);
      send.addEventListener("click", submit);
      // Enter sends; Shift+Enter is a real newline, since this is prose now.
      input.addEventListener("keydown", (e) => {
        const ev = e as KeyboardEvent;
        if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submit(); }
      });
      refresh();
      app.append(form);
    } else if (round.phase === "GUESSING") {
      app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">Clue is out — watch them squirm.</div></div>`));
      const feed = guessFeed(s);
      if (feed !== undefined) app.append(feed);
    }
  }

  // Everyone else: the clue and the one-shot guess.
  if (role !== "SPEAKER") {
    if (round.phase === "AWAITING_CLUE") {
      app.append(el(`<div class="card"><h2>${esc(nameOf(s, round.speakerId))} is thinking…</h2><p class="dim">Category: ${esc(round.category)} · up to ${round.budget} words. Get ready.</p></div>`));
    }
    if (round.phase === "GUESSING") {
      app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">by ${esc(nameOf(s, round.speakerId))} · what's the secret?</div></div>`));
      if (hasGuessed(s)) {
        app.append(el(`<p class="dim" style="text-align:center">Your one guess is in. Sweat it out.</p>`));
      } else {
        const form = el(`<div class="card stack composer">
          <input id="guess" type="text" placeholder="One guess. Make it count."
                 autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" />
          <button id="send" class="go">Guess!</button>
        </div>`);
        const input = form.querySelector("#guess") as HTMLInputElement;
        const submit = () => { if (input.value.trim().length > 0) command("guess.submit", { value: input.value.trim() }); };
        form.querySelector("#send")!.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
        app.append(form);
      }
      const feed = guessFeed(s);
      if (feed !== undefined) app.append(feed);
    }
  }

  if (round.phase === "VOTING") {
    app.append(el(`<div class="card"><h2>Loophole vote</h2><p class="dim">${esc(s.flagged?.reason ?? "That clue looks suspicious.")} Argue it out loud!</p></div>`));
    if (amHost(s)) {
      const row = el(`<div class="row"><button class="go" id="allow">Allow it</button><button class="danger" id="reject">Reject it</button></div>`);
      row.querySelector("#allow")!.addEventListener("click", () => command("vote.resolve", { allow: true }));
      row.querySelector("#reject")!.addEventListener("click", () => command("vote.resolve", { allow: false }));
      app.append(row);
    } else {
      app.append(el(`<p class="dim" style="text-align:center">The host taps the room's verdict.</p>`));
    }
  }

  if (amHost(s) && round.phase !== "VOTING") {
    const end = el(`<button class="secondary">End round (host)</button>`);
    end.addEventListener("click", () => command("round.end"));
    app.append(end);
  }

  renderScores(s);
}

function renderBetweenRounds(s: RoomState): void {
  const r = s.lastReveal;
  const round = s.game?.round;
  const reveal = revealPanel(s);
  if (r !== undefined) {
    app.append(el(`<div class="card reveal stack">
      <div class="small dim">THE ANSWER WAS</div>
      <div class="word">${esc(r.secret)}</div>
      ${round?.revealLine !== undefined ? `<div class="dim revealline">“${esc(round.revealLine)}”</div>` : ""}
      <div class="dim">${r.winnerId !== undefined ? `${esc(nameOf(s, r.winnerId))} got it!` : r.reason === "TIMEOUT" ? "Nobody got it." : "Round scrapped."}</div>
    </div>`));
  }
  // Who wrote what, who was right, who the room crowned. The comedy that used
  // to dribble out during guessing now lands here, all at once.
  if (reveal !== undefined) app.append(reveal);
  if (amHost(s)) {
    const next = el(`<button class="go">Next round</button>`);
    next.addEventListener("click", () => command("round.start"));
    app.append(next);
  } else {
    app.append(el(`<p class="dim" style="text-align:center">Next round when ${esc(s.players.find((p) => p.isHost)?.displayName ?? "the host")} is ready…</p>`));
  }
  renderScores(s);
}

function renderScores(s: RoomState): void {
  const g = s.game;
  if (g === undefined) return;
  const rows = [...s.players]
    .map((p) => ({ p, score: g.scores[p.id] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  app.append(el(`<div class="card"><h2>Scores</h2><table class="scores">${rows
    .map((r, i) => `<tr class="${i === 0 && r.score > 0 ? "winner" : ""}"><td>${esc(r.p.displayName)}${r.p.id === s.playerId ? " (you)" : ""}</td><td>${r.score}</td></tr>`)
    .join("")}</table></div>`));
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
