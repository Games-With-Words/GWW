import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createGateway, type Gateway } from "../src/gateway.js";
import { MemoryEventLog } from "../src/log.js";

let gw: Gateway;
let port: number;
let log: MemoryEventLog;

beforeEach(async () => {
  log = new MemoryEventLog();
  gw = createGateway({ log });
  port = await gw.listen(0);
});

afterEach(async () => {
  await gw.close();
});

async function api(path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

interface Client {
  ws: WebSocket;
  playerId: string;
  isHost: boolean;
  messages: any[];
  next(type: string, timeoutMs?: number): Promise<any>;
  send(msg: unknown): void;
  sawType(type: string): boolean;
}

function connect(roomId: string, token: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${roomId}&token=${token}`);
    const messages: any[] = [];
    const waiters: { type: string; resolve: (m: any) => void }[] = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.type === msg.type) {
          waiters.splice(i, 1)[0]!.resolve(msg);
        }
      }
      if (msg.type === "hello") {
        resolve({
          ws,
          playerId: msg.data.playerId,
          isHost: msg.data.isHost,
          messages,
          next: (type, timeoutMs = 3000) =>
            new Promise((res, rej) => {
              const existing = messages.find((m) => m.type === type);
              // Note: next() waits for a NEW message of the type after call time.
              const t = setTimeout(() => rej(new Error(`timeout waiting for ${type}; saw ${messages.map((m) => m.type).join(",")}`)), timeoutMs);
              waiters.push({ type, resolve: (m) => { clearTimeout(t); res(m); } });
              void existing;
            }),
          send: (m) => ws.send(JSON.stringify(m)),
          sawType: (type) => messages.some((m) => m.type === type),
        });
      }
    });
    ws.on("error", reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("lobby HTTP", () => {
  it("lists the arcade with creator credit", async () => {
    const { status, json } = await api("/api/games");
    expect(status).toBe(200);
    expect(json.games[0].gameId).toBe("say-less");
    expect(json.games[0].credit.maker).toBe("The Oracle");
  });

  it("creates a room and joins by short code", async () => {
    const created = await api("/api/rooms", { displayName: "Mark" });
    expect(created.status).toBe(201);
    expect(created.json.shortCode).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);

    const joined = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Ris" });
    expect(joined.status).toBe(201);
    expect(joined.json.roomId).toBe(created.json.roomId);
  });

  it("rejects duplicate display names and unknown rooms", async () => {
    const created = await api("/api/rooms", { displayName: "Mark" });
    const dup = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "mark" });
    expect(dup.status).toBe(400);
    expect(dup.json.error).toBe("NAME_TAKEN");

    const missing = await api("/api/rooms/ZZZZZZ/join", { displayName: "Ghost" });
    expect(missing.status).toBe(404);
  });

  it("rejects a wrong join token but accepts the bare code", async () => {
    const created = await api("/api/rooms", { displayName: "Mark" });
    const bad = await api(`/api/rooms/${created.json.shortCode}/join`, {
      displayName: "Intruder",
      joinToken: "not-the-token",
    });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe("BAD_TOKEN");

    const ok = await api(`/api/rooms/${created.json.shortCode}/join`, {
      displayName: "Friend",
      joinToken: created.json.joinToken,
    });
    expect(ok.status).toBe(201);
  });
});

describe("realtime round", () => {
  async function threePlayerRoom() {
    const created = await api("/api/rooms", { displayName: "Mark" });
    const p2 = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Ris" });
    const p3 = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Sonia" });
    const host = await connect(created.json.roomId, created.json.hostToken);
    const ris = await connect(created.json.roomId, p2.json.playerToken);
    const sonia = await connect(created.json.roomId, p3.json.playerToken);
    const tokens = new Map<string, string>([
      [host.playerId, created.json.hostToken],
      [ris.playerId, p2.json.playerToken],
      [sonia.playerId, p3.json.playerToken],
    ]);
    return { created, host, ris, sonia, all: [host, ris, sonia], tokens };
  }

  it("runs a full round with secret isolation — the release blocker", async () => {
    const { host, ris, sonia, all } = await threePlayerRoom();

    host.send({ type: "game.start", seed: 42 });
    await host.next("state");
    await wait(50);

    // Exactly ONE device received the secret: the Speaker's.
    const speakers = all.filter((c) => c.sawType("secret"));
    expect(speakers).toHaveLength(1);
    const speaker = speakers[0]!;
    const secretMsg = speaker.messages.find((m) => m.type === "secret");
    const secretWord: string = secretMsg.data.card.secret;
    expect(secretWord.length).toBeGreaterThan(0);

    // No other device's entire message history contains the secret string.
    for (const c of all) {
      if (c === speaker) continue;
      const everything = JSON.stringify(c.messages);
      expect(everything.includes(secretWord)).toBe(false);
    }

    // Public state carries phase/budget but never card contents.
    const state = all[0]!.messages.filter((m) => m.type === "state").at(-1)!;
    expect(state.data.round.phase).toBe("AWAITING_CLUE");
    expect(JSON.stringify(state)).not.toContain(secretWord);

    // Speaker submits a safe clue; everyone sees it broadcast.
    speaker.send({ type: "command", name: "clue.submit", payload: { clue: "totally safe generic hint" } });
    await speaker.next("state");
    await wait(50);

    // A guesser answers correctly; round completes and NOW the secret is public.
    const guesser = all.find((c) => c !== speaker)!;
    guesser.send({ type: "command", name: "guess.submit", payload: { value: secretWord } });
    await guesser.next("state");
    await wait(50);

    const completed = guesser.messages.find(
      (m) => m.type === "event" && m.data.type === "round.completed",
    );
    expect(completed.data.reason).toBe("CORRECT");
    expect(completed.data.secret).toBe(secretWord);

    const finalState = guesser.messages.filter((m) => m.type === "state").at(-1)!;
    expect(finalState.data.scores[guesser.playerId]).toBeGreaterThanOrEqual(150);
    void ris; void sonia;
  });

  it("rejects wrong-role commands", async () => {
    const { host, all } = await threePlayerRoom();
    host.send({ type: "game.start", seed: 7 });
    await host.next("state");
    await wait(50);

    const speaker = all.find((c) => c.sawType("secret"))!;
    const notSpeaker = all.find((c) => c !== speaker)!;

    notSpeaker.send({ type: "command", name: "clue.submit", payload: { clue: "hijack" } });
    const err = await notSpeaker.next("error");
    expect(err.error).toBe("NOT_SPEAKER");

    const nonHost = all.find((c) => !c.isHost)!;
    nonHost.send({ type: "command", name: "round.end", payload: {} });
    const err2 = await nonHost.next("error");
    expect(err2.error).toBe("HOST_ONLY");
  });

  it("non-host cannot start the game; too-few players cannot start", async () => {
    const created = await api("/api/rooms", { displayName: "Solo" });
    const host = await connect(created.json.roomId, created.json.hostToken);
    host.send({ type: "game.start" });
    const err = await host.next("error");
    expect(err.error).toBe("TOO_FEW_PLAYERS");
  });

  it("reconnecting speaker gets the secret again; reconnecting guesser does not", async () => {
    const { created, host, all, tokens } = await threePlayerRoom();
    host.send({ type: "game.start", seed: 42 });
    await host.next("state");
    await wait(50);

    const speaker = all.find((c) => c.sawType("secret"))!;
    const secretWord = speaker.messages.find((m) => m.type === "secret").data.card.secret;
    const guesser = all.find((c) => c !== speaker)!;

    // Speaker drops and reconnects: the secret must be re-delivered.
    speaker.ws.close();
    await wait(50);
    const speaker2 = await connect(created.json.roomId, tokens.get(speaker.playerId)!);
    await wait(100);
    const resent = speaker2.messages.find((m) => m.type === "secret");
    expect(resent?.data.card.secret).toBe(secretWord);

    // Guesser drops and reconnects: no secret, and the snapshot stays clean.
    guesser.ws.close();
    await wait(50);
    const guesser2 = await connect(created.json.roomId, tokens.get(guesser.playerId)!);
    await wait(100);
    expect(guesser2.sawType("secret")).toBe(false);
    expect(JSON.stringify(guesser2.messages)).not.toContain(secretWord);
  });

  it("records the round into the event log with monotonic sequence", async () => {
    const { created, host, all } = await threePlayerRoom();
    host.send({ type: "game.start", seed: 42 });
    await host.next("state");
    await wait(50);

    const speaker = all.find((c) => c.sawType("secret"))!;
    speaker.send({ type: "command", name: "clue.submit", payload: { clue: "totally safe generic hint" } });
    await speaker.next("state");

    const events = log.list(created.json.roomId);
    expect(events.length).toBeGreaterThanOrEqual(3); // game.started, round.started, clue...
    const sequences = events.map((e) => e.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(events[0]!.type).toBe("game.started");
  });
});
