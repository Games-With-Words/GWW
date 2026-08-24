/**
 * Games With Words client — the arcade, the board, the phones.
 *
 * Topology (Mark, 2026-08-23): the creating device (desktop/TV) is the BOARD —
 * QR, scores, clues, captions, never a player. Phones scan in and play. The
 * HOST is picked at random when the game starts. No framework: one state
 * object, one render pass, big thumb targets. The server is the authority.
 */

import QRCode from "qrcode";
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
        room = reduce(room, msg);
        if (msg.type === "event" && (msg["data"] as { type?: string } | undefined)?.type === "game.started") {
          void playIntroOnBoard();
        }
        if (msg.type === "error") setTimeout(() => { if (room?.error !== undefined) { room = { ...room, error: undefined }; render(); } }, 4000);
      }
      screen = { kind: "room" };
      render();
    },
    () => {
      if (screen.kind === "room") setTimeout(() => connect(roomId, myToken, asBoard), 1500);
    },
  );
}

function command(name: string, payload: Record<string, unknown> = {}): void {
  socket?.send({ type: "command", name, payload });
}

/** The board speaks Ris's intro when the game starts. Fire-and-forget:
 *  audio failure just leaves the caption — the party never waits (spec §07). */
let introPlayed = false;
async function playIntroOnBoard(): Promise<void> {
  if (introPlayed || room?.isBoard !== true) return;
  introPlayed = true;
  try {
    const res = await fetch("/api/voice/intro");
    const intro = (await res.json()) as { text: string; audioUrl: string | null };
    if (room !== undefined) {
      room = { ...room, caption: intro.text };
      render();
    }
    if (intro.audioUrl !== null) {
      const audio = new Audio(intro.audioUrl);
      audio.play().catch(() => undefined);
    }
  } catch {
    /* caption fallback already rendered from the event stream */
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
  app.replaceChildren();
  app.classList.toggle("board", room?.isBoard === true && screen.kind === "room");
  switch (screen.kind) {
    case "home": renderHome(screen.games); break;
    case "join": renderJoin(screen.code, screen.token); break;
    case "room": renderRoom(); break;
  }
  app.append(el(`<footer>Games With Words · Interchained LLC Labs · <span class="dim">the room is the game</span> · <a href="https://github.com/Games-With-Words/GWW" target="_blank" rel="noopener noreferrer">GPLv3</a> · <span class="dim">build ${__BUILD__}</span></footer>`));
  syncTicker();
}

/** Re-render once a second while a phase clock is running. */
function syncTicker(): void {
  const running = room?.game?.deadline !== undefined && room.game.status === "IN_ROUND";
  if (running && ticker === undefined) {
    ticker = setInterval(() => { if (screen.kind === "room") render(); }, 1000);
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
    <input id="code" type="text" placeholder="ROOM CODE" autocapitalize="characters" autocomplete="off" maxlength="6" />
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
    <input id="name" type="text" placeholder="Your name" maxlength="24" autocomplete="off" />
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

function renderBoardLobby(s: RoomState): void {
  app.append(el(`<div><div class="brand">Games With Words</div><h2>Scan in — the show starts soon</h2></div>`));
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
  app.append(el(`<p class="dim" style="text-align:center">${s.players.length < 2 ? "Waiting for at least 2 phones — nobody plays on this screen." : "Ready! Any phone can hit Start — a random player becomes the host."}</p>`));
}

function guessFeed(s: RoomState): HTMLElement | undefined {
  const guesses = s.game?.round?.guesses ?? [];
  if (guesses.length === 0) return undefined;
  return el(`<div class="card"><h2>Guesses</h2><ul class="guessfeed">${guesses
    .map((g) => `<li class="${g.correct ? "hit" : "miss"}"><b>${esc(nameOf(s, g.playerId))}</b> ${esc(g.value)} ${g.correct ? "✓" : "✗"}</li>`)
    .join("")}</ul></div>`);
}

function renderBoardGame(s: RoomState): void {
  const g = s.game!;
  const round = g.round;
  const clock = countdown(s);
  app.append(el(`<div class="row"><span class="brand">Say Less</span><span class="grow"></span><span class="dim">Round ${g.roundIndex + 1}</span></div>`));
  if (clock !== undefined) app.append(clock);
  const cap = caption(s);
  if (cap !== undefined) app.append(cap);

  if (round !== undefined && round.phase !== "COMPLETE") {
    if (round.phase === "AWAITING_CLUE") {
      app.append(el(`<div class="card reveal"><h2>${esc(nameOf(s, round.speakerId))} is composing a clue…</h2><p class="dim">Category: ${esc(round.category)} · ${round.budget}-word budget</p></div>`));
    } else {
      app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">— ${esc(nameOf(s, round.speakerId))}${round.phase === "VOTING" ? " · LOOPHOLE VOTE IN PROGRESS" : ""}</div></div>`));
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

  // Speaker: the secret card lives here and only here.
  if (role === "SPEAKER") {
    if (s.secret !== undefined) {
      const c = s.secret;
      app.append(el(`<div class="card secretcard stack">
        <div class="small dim" style="text-align:center">YOUR SECRET · ${esc(c.card.category)} · don't say the red words</div>
        <div class="secretword">${esc(c.card.secret)}</div>
        <div class="forbidden">${c.card.forbidden.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
        <div class="budget">Get them to guess it in a ${c.budget}-word clue</div>
      </div>`));
    } else {
      app.append(el(`<div class="card">Fetching your secret…</div>`));
    }
    if (round.phase === "AWAITING_CLUE") {
      const form = el(`<div class="card stack">
        <input id="clue" type="text" placeholder="Your ${round.budget}-word clue" autocomplete="off" />
        <button id="send">Send clue to the room</button>
      </div>`);
      const input = form.querySelector("#clue") as HTMLInputElement;
      const submit = () => { if (input.value.trim().length > 0) command("clue.submit", { clue: input.value.trim() }); };
      form.querySelector("#send")!.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
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
      app.append(el(`<div class="card"><h2>${esc(nameOf(s, round.speakerId))} is thinking…</h2><p class="dim">Category: ${esc(round.category)} · they get ${round.budget} words. Get ready.</p></div>`));
    }
    if (round.phase === "GUESSING") {
      app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">by ${esc(nameOf(s, round.speakerId))} · what's the secret?</div></div>`));
      if (hasGuessed(s)) {
        app.append(el(`<p class="dim" style="text-align:center">Your one guess is in. Sweat it out.</p>`));
      } else {
        const form = el(`<div class="card stack">
          <input id="guess" type="text" placeholder="One guess. Make it count." autocomplete="off" />
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
  if (r !== undefined) {
    app.append(el(`<div class="card reveal stack">
      <div class="small dim">THE ANSWER WAS</div>
      <div class="word">${esc(r.secret)}</div>
      ${round?.revealLine !== undefined ? `<div class="dim revealline">“${esc(round.revealLine)}”</div>` : ""}
      <div class="dim">${r.winnerId !== undefined ? `${esc(nameOf(s, r.winnerId))} got it!` : r.reason === "TIMEOUT" ? "Nobody got it." : "Round scrapped."}</div>
    </div>`));
  }
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
