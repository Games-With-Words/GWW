/**
 * Games With Words client — the arcade, the lobby, the game.
 * No framework: one state object, one render pass, big thumb targets.
 * The server is the authority; this screen only projects it.
 */

import QRCode from "qrcode";
import { api, openSocket, type CreatedRoom, type GameTile, type Socket } from "./api.js";
import {
  hasGuessed,
  initialRoom,
  joinUrl,
  nameOf,
  reduce,
  roleOf,
  type RoomState,
} from "./state.js";

const app = document.getElementById("app")!;

type Screen =
  | { kind: "home"; games: GameTile[] }
  | { kind: "create"; gameId: string }
  | { kind: "join"; code: string; token?: string }
  | { kind: "room" };

let screen: Screen = { kind: "home", games: [] };
let room: RoomState | undefined;
let created: CreatedRoom | undefined;
let socket: Socket | undefined;
let roomId = "";
let myToken = "";
let busy = false;
let formError = "";

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

function connect(rid: string, token: string): void {
  roomId = rid;
  myToken = token;
  socket = openSocket(
    rid,
    token,
    (msg) => {
      if (msg.type === "hello") {
        const d = msg["data"] as { playerId: string; isHost: boolean; roomState: string; snapshot?: unknown };
        room = initialRoom(d.playerId, d.isHost, d.roomState);
        if (d.snapshot !== undefined && d.snapshot !== null) {
          room = reduce(room, { type: "state", data: d.snapshot });
        }
      } else if (room !== undefined) {
        room = reduce(room, msg);
        if (msg.type === "error") setTimeout(() => { if (room?.error !== undefined) { room = { ...room, error: undefined }; render(); } }, 4000);
      }
      screen = { kind: "room" };
      render();
    },
    () => {
      // Reconnect with backoff while the room screen is up.
      if (screen.kind === "room") {
        setTimeout(() => connect(roomId, myToken), 1500);
      }
    },
  );
}

function command(name: string, payload: Record<string, unknown> = {}): void {
  socket?.send({ type: "command", name, payload });
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
  switch (screen.kind) {
    case "home": renderHome(screen.games); break;
    case "create": renderCreate(screen.gameId); break;
    case "join": renderJoin(screen.code, screen.token); break;
    case "room": renderRoom(); break;
  }
  app.append(el(`<footer>Games With Words · Interchained LLC Labs · <span class="dim">the room is the game</span></footer>`));
}

/* ------------------------------------------------------------- the arcade */

function renderHome(games: GameTile[]): void {
  app.append(el(`<div><div class="brand">Games With Words</div><h1>The room is<br/>the game.</h1><p class="tag">One person starts a room. Everyone scans in. Then the stories begin.</p></div>`));

  const shelf = el(`<div class="stack"></div>`);
  for (const g of games) {
    const tile = el(`<button class="tile card">
      <div class="maker">by ${esc(g.credit.maker)}</div>
      <h3>${esc(g.title)}</h3>
      <div class="dim">${esc(g.tagline)}</div>
      <div class="small dim">${g.minPlayers}–${g.maxPlayers} players · ${g.sessionMinutes[0]}–${g.sessionMinutes[1]} min</div>
    </button>`);
    tile.addEventListener("click", () => { screen = { kind: "create", gameId: g.gameId }; render(); });
    shelf.append(tile);
  }
  shelf.append(el(`<div class="tile card soon"><div class="maker">by you?</div><h3>More games coming</h3><div class="dim">The arcade grows — each game made by a person, credited on its tile.</div></div>`));
  app.append(shelf);

  const joinCard = el(`<div class="card stack">
    <h2>Got a code?</h2>
    <input id="code" type="text" placeholder="ROOM CODE" autocapitalize="characters" autocomplete="off" maxlength="6" />
    <button class="secondary" id="joinbtn">Join a room</button>
  </div>`);
  joinCard.querySelector("#joinbtn")!.addEventListener("click", () => {
    const code = (joinCard.querySelector("#code") as HTMLInputElement).value.trim().toUpperCase();
    if (code.length > 0) { screen = { kind: "join", code }; render(); }
  });
  app.append(joinCard);
}

/* --------------------------------------------------------- create / join */

function nameForm(title: string, cta: string, onSubmit: (name: string) => void): void {
  const card = el(`<div class="card stack">
    <h2>${esc(title)}</h2>
    ${formError.length > 0 ? `<div class="error">${esc(formError)}</div>` : ""}
    <input id="name" type="text" placeholder="Your name" maxlength="24" autocomplete="off" />
    <button id="go"${busy ? " disabled" : ""}>${esc(cta)}</button>
    <button class="secondary" id="back">Back</button>
  </div>`);
  const input = card.querySelector("#name") as HTMLInputElement;
  const submit = () => { if (input.value.trim().length > 0 && !busy) onSubmit(input.value.trim()); };
  card.querySelector("#go")!.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
  card.querySelector("#back")!.addEventListener("click", () => { formError = ""; location.hash = ""; screen = { kind: "home", games: [] }; void boot(); });
  app.append(el(`<div><div class="brand">Games With Words</div></div>`), card);
  input.focus();
}

function renderCreate(gameId: string): void {
  nameForm("Start a room", "Create my room", (name) => {
    busy = true; render();
    api.createRoom(name, gameId)
      .then((c) => { created = c; formError = ""; connect(c.roomId, c.hostToken); })
      .catch((e: Error) => { formError = e.message; })
      .finally(() => { busy = false; render(); });
  });
}

function renderJoin(code: string, token?: string): void {
  nameForm(`Join room ${code}`, "I'm here", (name) => {
    busy = true; render();
    api.joinRoom(code, name, token)
      .then((j) => { formError = ""; connect(j.roomId, j.playerToken); })
      .catch((e: Error) => { formError = e.message; })
      .finally(() => { busy = false; render(); });
  });
}

/* ------------------------------------------------------------- the room */

function renderRoom(): void {
  if (room === undefined) { app.append(el(`<div class="card">Connecting…</div>`)); return; }
  const s = room;

  if (s.error !== undefined) app.append(el(`<div class="error">${esc(s.error)}</div>`));

  if (s.game === undefined || s.game.status === "COMPLETE") {
    if (s.game?.status === "COMPLETE") { renderSummary(s); return; }
    renderLobby(s); return;
  }
  renderGame(s);
}

function renderLobby(s: RoomState): void {
  app.append(el(`<div><div class="brand">Games With Words</div><h2>Your private room</h2></div>`));

  if (created !== undefined && s.isHost) {
    const url = joinUrl(location.origin, created.shortCode, created.joinToken);
    const card = el(`<div class="card stack">
      <div class="code">${esc(created.shortCode)}</div>
      <div class="qr"><canvas id="qr"></canvas></div>
      <div class="small dim" style="text-align:center">Scan to join · or enter the code at ${esc(location.host)}</div>
    </div>`);
    app.append(card);
    void QRCode.toCanvas(card.querySelector("#qr") as HTMLCanvasElement, url, { width: 220, margin: 1 });
  }

  const list = el(`<div class="card"><h2>In the room</h2><ul class="playerlist">${s.players
    .map((p) => `<li><span class="dot${p.connected ? "" : " off"}"></span><span class="grow">${esc(p.displayName)}${p.id === s.playerId ? " (you)" : ""}</span>${p.isHost ? `<span class="hostmark">HOST</span>` : ""}</li>`)
    .join("")}</ul></div>`);
  app.append(list);

  if (s.isHost) {
    const start = el(`<button class="go"${s.players.length < 2 ? " disabled" : ""}>Start Say Less${s.players.length < 2 ? " (need 2+)" : ""}</button>`);
    start.addEventListener("click", () => socket?.send({ type: "game.start" }));
    app.append(start);
  } else {
    app.append(el(`<p class="dim" style="text-align:center">Waiting for the host to start…</p>`));
  }
}

function caption(s: RoomState): HTMLElement | undefined {
  if (s.caption === undefined) return undefined;
  return el(`<div class="caption"><span class="who">RIS</span><br/>${esc(s.caption)}</div>`);
}

function renderGame(s: RoomState): void {
  const g = s.game!;
  const round = g.round;
  const role = roleOf(s);

  app.append(el(`<div class="row"><span class="rolepill ${role}">${role}</span><span class="grow"></span><span class="dim small">Round ${g.roundIndex + 1}</span></div>`));

  const cap = caption(s);
  if (cap !== undefined) app.append(cap);

  if (round === undefined) { renderBetweenRounds(s); return; }

  if (round.phase === "COMPLETE") { renderBetweenRounds(s); return; }

  // Speaker view — the secret card, only ever on this device.
  if (role === "SPEAKER" && s.secret !== undefined) {
    const c = s.secret;
    app.append(el(`<div class="card secretcard stack">
      <div class="small dim" style="text-align:center">SECRET · ${esc(c.card.category)}</div>
      <div class="secretword">${esc(c.card.secret)}</div>
      <div class="forbidden">${c.card.forbidden.map((f) => `<span>${esc(f)}</span>`).join("")}</div>
      <div class="budget">${c.budget}-word clue budget</div>
    </div>`));
    if (round.phase === "AWAITING_CLUE") {
      const form = el(`<div class="card stack">
        <input id="clue" type="text" placeholder="Your clue (${round.budget} words max)" autocomplete="off" />
        <button id="send">Send clue</button>
      </div>`);
      const input = form.querySelector("#clue") as HTMLInputElement;
      const submit = () => { if (input.value.trim().length > 0) command("clue.submit", { clue: input.value.trim() }); };
      form.querySelector("#send")!.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
      app.append(form);
    } else if (round.phase === "GUESSING") {
      app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">${round.guessCount} guess${round.guessCount === 1 ? "" : "es"} in — hold tight.</div></div>`));
    }
  }

  // Guesser view.
  if (role !== "SPEAKER") {
    if (round.phase === "AWAITING_CLUE") {
      app.append(el(`<div class="card"><h2>${esc(nameOf(s, round.speakerId))} is thinking…</h2><p class="dim">Category: ${esc(round.category)} · ${round.budget}-word budget</p></div>`));
    }
    if (round.phase === "GUESSING") {
      app.append(el(`<div class="card"><div class="cluebox">“${esc(round.clue ?? "")}”</div><div class="budget">by ${esc(nameOf(s, round.speakerId))}</div></div>`));
      if (role === "GUESSER" || (role === "HOST" && s.playerId !== round.speakerId)) {
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
      }
    }
  }

  // Vote (host resolves in v0.1; the room argues out loud — that's the game).
  if (round.phase === "VOTING") {
    app.append(el(`<div class="card"><h2>Loophole vote</h2><p class="dim">${esc(s.flagged?.reason ?? "That clue looks suspicious.")}</p></div>`));
    if (s.isHost) {
      const row = el(`<div class="row"><button class="go" id="allow">Allow it</button><button class="danger" id="reject">Reject it</button></div>`);
      row.querySelector("#allow")!.addEventListener("click", () => command("vote.resolve", { allow: true }));
      row.querySelector("#reject")!.addEventListener("click", () => command("vote.resolve", { allow: false }));
      app.append(row);
    } else {
      app.append(el(`<p class="dim" style="text-align:center">Argue your case. The host taps the verdict.</p>`));
    }
  }

  if (s.isHost && round.phase !== "VOTING") {
    const end = el(`<button class="secondary">End round</button>`);
    end.addEventListener("click", () => command("round.end"));
    app.append(end);
  }

  renderScores(s);
}

function renderBetweenRounds(s: RoomState): void {
  const r = s.lastReveal;
  if (r !== undefined) {
    app.append(el(`<div class="card reveal stack">
      <div class="small dim">THE ANSWER WAS</div>
      <div class="word">${esc(r.secret)}</div>
      <div class="dim">${r.winnerId !== undefined ? `${esc(nameOf(s, r.winnerId))} got it!` : r.reason === "TIMEOUT" ? "Nobody got it." : "Round scrapped."}</div>
    </div>`));
  }
  if (s.isHost) {
    const next = el(`<button class="go">Next round</button>`);
    next.addEventListener("click", () => command("round.start"));
    app.append(next);
  } else {
    app.append(el(`<p class="dim" style="text-align:center">Next round when the host is ready…</p>`));
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
