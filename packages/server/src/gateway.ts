/**
 * HTTP + WebSocket gateway (spec §09 realtime gateway, §03 happy path).
 *
 * HTTP:
 *   GET  /health                    -> { ok, rooms }
 *   GET  /api/games                 -> arcade manifests (the marketplace shelf)
 *   POST /api/rooms                 -> { roomId, shortCode, joinToken, hostToken, playerId }
 *   POST /api/rooms/:code/join      -> { roomId, playerToken, playerId, gameId }
 *
 * WS: /ws?room=<roomId>&token=<playerToken>
 *   client -> { type: "command", name, payload }
 *   server -> { type: "hello" | "state" | "event" | "secret" | "presence" | "error" }
 *
 * Identity lives on the authenticated socket; command payloads never carry it.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { createArcade, type Arcade } from "@gww/kit";
import { sayLess } from "@gww/say-less";
import { WebSocketServer, WebSocket } from "ws";
import { MemoryEventLog, type EventLog } from "./log.js";
import { RoomError, RoomStore, type Room } from "./rooms.js";
import { GameSession, SessionError } from "./session.js";
import { VoiceService, voiceConfigFromEnv } from "./voice.js";

interface JoinAttemptWindow {
  count: number;
  resetAt: number;
}

export interface Gateway {
  server: Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

export function createGateway(opts?: { log?: EventLog; now?: () => number; clientDist?: string; voice?: VoiceService }): Gateway {
  const now = opts?.now ?? (() => Date.now());
  const log = opts?.log ?? new MemoryEventLog();
  const voice = opts?.voice ?? new VoiceService(voiceConfigFromEnv());
  const clientDist = opts?.clientDist ?? process.env["GWW_CLIENT_DIST"];
  const rooms = new RoomStore();
  const sessions = new Map<string, GameSession>();
  // room.id -> player.id -> sockets (a player may hold more than one device/tab)
  const sockets = new Map<string, Map<string, Set<WebSocket>>>();
  // room.id -> board sockets (desktop/TV displays — never players, never secrets)
  const boards = new Map<string, Set<WebSocket>>();
  const joinAttempts = new Map<string, JoinAttemptWindow>();

  const arcade: Arcade = createArcade();
  arcade.register(sayLess as never);

  function roomSockets(roomId: string): Map<string, Set<WebSocket>> {
    let m = sockets.get(roomId);
    if (m === undefined) {
      m = new Map();
      sockets.set(roomId, m);
    }
    return m;
  }

  function send(ws: WebSocket, type: string, payload: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type, ...(payload as object) }));
    }
  }

  function broadcast(roomId: string, type: string, payload: unknown): void {
    for (const set of roomSockets(roomId).values()) {
      for (const ws of set) send(ws, type, { data: payload });
    }
    for (const ws of boards.get(roomId) ?? []) send(ws, type, { data: payload });
  }

  function toPlayer(roomId: string, playerId: string, type: string, payload: unknown): void {
    const set = roomSockets(roomId).get(playerId);
    if (set === undefined) return;
    for (const ws of set) send(ws, type, { data: payload });
  }

  function presence(room: Room): void {
    broadcast(room.id, "presence", {
      state: room.state,
      players: [...room.players.values()].map((p) => ({
        id: p.id,
        displayName: p.displayName,
        isHost: p.isHost,
        connected: p.connected,
      })),
    });
  }

  function rateLimit(key: string, limit: number, windowMs: number): boolean {
    const t = now();
    const w = joinAttempts.get(key);
    if (w === undefined || t >= w.resetAt) {
      joinAttempts.set(key, { count: 1, resetAt: t + windowMs });
      return true;
    }
    w.count += 1;
    return w.count <= limit;
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length === 0) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new RoomError("BAD_JSON", "Request body is not valid JSON.");
    }
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(data),
    });
    res.end(data);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (err instanceof RoomError) {
        json(res, 400, { error: err.code, message: err.message });
      } else {
        console.error("[gateway] unhandled:", err);
        json(res, 500, { error: "INTERNAL", message: "Something went wrong." });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      json(res, 200, { ok: true, service: "gww-server" });
      return;
    }

    if (req.method === "GET" && path === "/api/games") {
      json(res, 200, { games: arcade.list() });
      return;
    }

    // Ris's intro: cached voiced line when one exists, L0 caption otherwise.
    // Read-only and instant — generation happens in the background drip.
    if (req.method === "GET" && path === "/api/voice/intro") {
      const intro = voice.pickIntro();
      json(res, 200, {
        text: intro.text,
        audioUrl: intro.audioFile !== undefined ? `/api/voice/audio/${intro.audioFile}` : null,
      });
      return;
    }

    const audioMatch = /^\/api\/voice\/audio\/([a-f0-9]{16}\.wav)$/.exec(path);
    if (req.method === "GET" && audioMatch !== null) {
      const file = voice.audioPath(audioMatch[1]!);
      if (file === undefined) {
        json(res, 404, { error: "NOT_FOUND", message: "No such clip." });
        return;
      }
      res.writeHead(200, { "content-type": "audio/wav", "cache-control": "public, max-age=604800" });
      createReadStream(file).pipe(res);
      return;
    }

    if (req.method === "POST" && path === "/api/rooms") {
      const body = await readBody(req);
      const gameId = typeof body["gameId"] === "string" ? (body["gameId"] as string) : "say-less";
      if (arcade.get(gameId) === undefined) {
        json(res, 404, { error: "UNKNOWN_GAME", message: `No game "${gameId}" on the shelf.` });
        return;
      }
      // The creating device becomes the BOARD (desktop/TV): QR, scores, clues.
      // Nobody plays on the main screen; phones join and a random phone hosts.
      const { room, joinToken, boardToken } = rooms.create(gameId, now());
      json(res, 201, {
        roomId: room.id,
        shortCode: room.shortCode,
        joinToken,
        boardToken,
        gameId,
        expiresAt: room.expiresAt,
      });
      return;
    }

    const joinMatch = /^\/api\/rooms\/([A-Za-z0-9]+)\/join$/.exec(path);
    if (req.method === "POST" && joinMatch !== null) {
      const code = joinMatch[1]!;
      const ip = req.socket.remoteAddress ?? "unknown";
      if (!rateLimit(`join:${ip}`, 20, 60_000)) {
        json(res, 429, { error: "RATE_LIMITED", message: "Too many join attempts. Slow down." });
        return;
      }
      const room = rooms.getByCode(code, now());
      if (room === undefined || room.state === "EXPIRED") {
        json(res, 404, { error: "NO_SUCH_ROOM", message: "Room not found or expired." });
        return;
      }
      const body = await readBody(req);
      const displayName = typeof body["displayName"] === "string" ? (body["displayName"] as string) : "";
      const joinToken = typeof body["joinToken"] === "string" ? (body["joinToken"] as string) : undefined;
      try {
        const { player, playerToken } = rooms.join(room, displayName, now(), joinToken);
        presence(room);
        json(res, 201, { roomId: room.id, playerToken, playerId: player.id, gameId: room.gameId });
      } catch (err) {
        if (err instanceof RoomError) {
          json(res, err.code === "ROOM_EXPIRED" ? 410 : 400, { error: err.code, message: err.message });
          return;
        }
        throw err;
      }
      return;
    }

    // Static client (spec §09 web client): everything that isn't API/WS is the
    // app. SPA fallback to index.html so #/join deep links always resolve.
    if (req.method === "GET" && clientDist !== undefined && !path.startsWith("/api/")) {
      const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
      let file = join(clientDist, safe === "/" ? "index.html" : safe);
      if (!file.startsWith(clientDist) || !existsSync(file) || statSync(file).isDirectory()) {
        file = join(clientDist, "index.html");
      }
      if (existsSync(file)) {
        res.writeHead(200, {
          "content-type": MIME[extname(file)] ?? "application/octet-stream",
          "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=86400",
        });
        createReadStream(file).pipe(res);
        return;
      }
    }

    json(res, 404, { error: "NOT_FOUND", message: `No route ${req.method} ${path}` });
  }

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const roomId = url.searchParams.get("room") ?? "";
    const token = url.searchParams.get("token") ?? "";

    const room = rooms.get(roomId, now());
    if (room === undefined || room.state === "EXPIRED") {
      send(ws, "error", { error: "NO_SUCH_ROOM", message: "Room not found or expired." });
      ws.close(4404, "no such room");
      return;
    }

    // Display board: receives all public traffic, never a secret, sends nothing.
    const boardToken = url.searchParams.get("board");
    if (boardToken !== null) {
      if (!rooms.authenticateBoard(room, boardToken)) {
        send(ws, "error", { error: "BAD_TOKEN", message: "Invalid board token." });
        ws.close(4401, "bad token");
        return;
      }
      let set = boards.get(room.id);
      if (set === undefined) {
        set = new Set();
        boards.set(room.id, set);
      }
      set.add(ws);
      const session = sessions.get(room.id);
      send(ws, "hello", {
        data: { board: true, roomState: room.state, gameId: room.gameId, shortCode: room.shortCode, snapshot: session?.snapshot() },
      });
      presence(room);
      ws.on("message", () => {
        send(ws, "error", { error: "BOARD_READONLY", message: "The board watches. Phones play." });
      });
      ws.on("close", () => { set.delete(ws); });
      return;
    }

    const player = rooms.authenticate(room, token);
    if (player === undefined) {
      send(ws, "error", { error: "BAD_TOKEN", message: "Invalid player token." });
      ws.close(4401, "bad token");
      return;
    }

    const perPlayer = roomSockets(room.id);
    let set = perPlayer.get(player.id);
    if (set === undefined) {
      set = new Set();
      perPlayer.set(player.id, set);
    }
    set.add(ws);
    player.connected = true;

    const session = sessions.get(room.id);
    send(ws, "hello", {
      data: {
        playerId: player.id,
        isHost: player.isHost,
        roomState: room.state,
        gameId: room.gameId,
        snapshot: session?.snapshot(),
      },
    });
    presence(room);
    // Reconnecting Speaker gets their card back — and only the Speaker.
    session?.resendSecretIfSpeaker(player.id);

    ws.on("message", (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw)) as Record<string, unknown>;
      } catch {
        send(ws, "error", { error: "BAD_JSON", message: "Messages must be JSON." });
        return;
      }

      try {
        if (msg["type"] === "game.start") {
          // Any player may start the game; the HOST is then picked at random —
          // hosting is a job the room assigns, not a reward for scanning first.
          if (sessions.has(room.id)) throw new SessionError("ALREADY_STARTED", "Game already started.");
          if (room.players.size < 2) throw new SessionError("TOO_FEW_PLAYERS", "Need at least 2 players.");
          const seed = typeof msg["seed"] === "number" ? (msg["seed"] as number) : Math.floor(Math.random() * 2 ** 31);
          rooms.assignRandomHost(room);
          room.state = "PLAYING";
          const s = new GameSession(
            room,
            seed,
            log,
            {
              broadcast: (type, payload) => broadcast(room.id, type, payload),
              toPlayer: (pid, type, payload) => toPlayer(room.id, pid, type, payload),
            },
            now,
          );
          sessions.set(room.id, s);
          presence(room);
          // Round 1 begins the moment the game starts — no second tap needed.
          s.command("game", true, "round.start", {});
          return;
        }

        if (msg["type"] === "command") {
          const s = sessions.get(room.id);
          if (s === undefined) throw new SessionError("NOT_STARTED", "Start the game first.");
          const name = String(msg["name"] ?? "");
          const payload = (msg["payload"] ?? {}) as Record<string, unknown>;
          s.command(player.id, player.isHost, name, payload);
          if (s.status === "COMPLETE") room.state = "SUMMARY";
          return;
        }

        send(ws, "error", { error: "UNKNOWN_TYPE", message: `Unknown message type.` });
      } catch (err) {
        const e = err as { code?: string; message?: string };
        send(ws, "error", { error: e.code ?? "COMMAND_FAILED", message: e.message ?? "Command failed." });
      }
    });

    ws.on("close", () => {
      set.delete(ws);
      if (set.size === 0) {
        player.connected = false;
        presence(room);
      }
    });
  });

  return {
    server,
    listen: (port: number, host = "127.0.0.1") =>
      new Promise<number>((resolve) => {
        server.listen(port, host, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        voice.stop();
        for (const s of sessions.values()) s.dispose();
        // Terminate live sockets first — server.close() waits for open
        // connections and would otherwise hang until every phone left.
        for (const c of wss.clients) c.terminate();
        wss.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
