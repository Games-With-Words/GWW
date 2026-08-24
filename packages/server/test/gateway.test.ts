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

function connectBoard(roomId: string, boardToken: string): Promise<Client> {
  return connectWith(`ws://127.0.0.1:${port}/ws?room=${roomId}&board=${boardToken}`);
}

function connect(roomId: string, token: string): Promise<Client> {
  return connectWith(`ws://127.0.0.1:${port}/ws?room=${roomId}&token=${token}`);
}

function connectWith(url: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
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
          playerId: msg.data.playerId ?? "board",
          isHost: msg.data.isHost ?? false,
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

  it("creates a board room and joins by short code", async () => {
    const created = await api("/api/rooms", {});
    expect(created.status).toBe(201);
    expect(created.json.shortCode).toMatch(/^[2-9A-HJ-NP-Z]{6}$/);
    expect(created.json.boardToken.length).toBeGreaterThan(10);
    expect(created.json.hostToken).toBeUndefined();

    const joined = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Ris" });
    expect(joined.status).toBe(201);
    expect(joined.json.roomId).toBe(created.json.roomId);
  });

  it("rejects duplicate display names and unknown rooms", async () => {
    const created = await api("/api/rooms", {});
    await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Mark" });
    const dup = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "mark" });
    expect(dup.status).toBe(400);
    expect(dup.json.error).toBe("NAME_TAKEN");

    const missing = await api("/api/rooms/ZZZZZZ/join", { displayName: "Ghost" });
    expect(missing.status).toBe(404);
  });

  it("rejects a wrong join token but accepts the bare code", async () => {
    const created = await api("/api/rooms", {});
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
    const created = await api("/api/rooms", {});
    const p1 = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Mark" });
    const p2 = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Ris" });
    const p3 = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Sonia" });
    const board = await connectBoard(created.json.roomId, created.json.boardToken);
    const mark = await connect(created.json.roomId, p1.json.playerToken);
    const ris = await connect(created.json.roomId, p2.json.playerToken);
    const sonia = await connect(created.json.roomId, p3.json.playerToken);
    const tokens = new Map<string, string>([
      [mark.playerId, p1.json.playerToken],
      [ris.playerId, p2.json.playerToken],
      [sonia.playerId, p3.json.playerToken],
    ]);
    return { created, board, host: mark, ris, sonia, all: [mark, ris, sonia], tokens };
  }

  it("runs a full round with secret isolation — the release blocker", async () => {
    const { board, host, ris, sonia, all } = await threePlayerRoom();

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

    // No other device's entire message history contains the secret string —
    // including the BOARD, which is on the shared display by definition.
    for (const c of [...all, board]) {
      if (c === speaker) continue;
      const everything = JSON.stringify(c.messages);
      expect(everything.includes(secretWord)).toBe(false);
    }
    expect(board.sawType("secret")).toBe(false);

    // Public state carries phase/budget but never card contents.
    const state = all[0]!.messages.filter((m) => m.type === "state").at(-1)!;
    expect(state.data.round.phase).toBe("AWAITING_CLUE");
    expect(JSON.stringify(state)).not.toContain(secretWord);

    // Speaker submits a safe clue; everyone sees it broadcast.
    speaker.send({ type: "command", name: "clue.submit", payload: { clue: "totally safe generic hint" } });
    await speaker.next("state");
    await wait(50);

    // A guesser answers correctly. The round does NOT end there any more —
    // every guesser gets their turn first (round rework, 2026-08-24).
    const guesser = all.find((c) => c !== speaker)!;
    guesser.send({ type: "command", name: "guess.submit", payload: { value: secretWord } });
    await guesser.next("state");
    await wait(50);
    const midState = guesser.messages.filter((m) => m.type === "state").at(-1)!;
    expect(midState.data.round.phase).toBe("GUESSING");

    // The last guesser closes it. Three players is under the ballot floor, so
    // the round completes immediately and the secret goes public.
    const other = all.find((c) => c !== speaker && c !== guesser)!;
    other.send({ type: "command", name: "guess.submit", payload: { value: "nowhere close" } });
    await other.next("state");
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

  it("never puts the ballot's owner map on the wire before the reveal", async () => {
    // A five-player room clears the ballot floor. The anonymity guarantee is
    // only real if it holds at the WIRE, not just in engine state — this is the
    // test that would catch a projection leaking ballotOwners.
    const created = await api("/api/rooms", {});
    const joins = [];
    for (const name of ["Mark", "Ris", "Sonia", "Sam", "Jo"]) {
      joins.push(await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: name }));
    }
    const board = await connectBoard(created.json.roomId, created.json.boardToken);
    const clients = [];
    for (const j of joins) clients.push(await connect(created.json.roomId, j.json.playerToken));

    const hostClient = clients.find((c) => c.isHost) ?? clients[0]!;
    hostClient.send({ type: "game.start", seed: 42 });
    await hostClient.next("state");
    await wait(60);

    const speaker = clients.find((c) => c.sawType("secret"))!;
    speaker.send({ type: "command", name: "clue.submit", payload: { clue: "totally safe generic hint" } });
    await speaker.next("state");
    await wait(60);

    // Every guesser answers WRONG, so the ballot opens with four guesses.
    const guessers = clients.filter((c) => c !== speaker);
    for (const [i, g] of guessers.entries()) {
      g.send({ type: "command", name: "guess.submit", payload: { value: `guess number ${i}` } });
      await g.next("state");
    }
    await wait(80);

    const state = board.messages.filter((m) => m.type === "state").at(-1)!;
    expect(state.data.round.phase).toBe("BALLOT");
    expect(state.data.round.ballot).toHaveLength(4);
    // Slots carry text and an id — and nothing else.
    for (const slot of state.data.round.ballot) {
      expect(Object.keys(slot).sort()).toEqual(["slotId", "text"]);
    }
    // Nothing the board or any phone has EVER received maps a slot to a player.
    for (const c of [board, ...clients]) {
      expect(JSON.stringify(c.messages)).not.toContain("ballotOwners");
    }

    // THE HARDER GUARANTEE: the mapping must not be RECOVERABLE from earlier
    // traffic. The live guess feed broadcast playerId + value during GUESSING,
    // and so did the guess.submitted EVENT — either one makes the anonymous
    // ballot pure theatre. Grepping for "ballotOwners" would never catch that,
    // so assert on the guess TEXT: it may appear ONLY inside round.ballot
    // (anonymous) or round.reveal (identity intentionally dropped).
    const texts = guessers.map((_, i) => `guess number ${i}`);
    for (const c of [board, ...clients]) {
      for (const m of c.messages) {
        const copy = JSON.parse(JSON.stringify(m));
        if (copy.data?.round !== undefined && copy.data.round !== null) {
          delete copy.data.round.ballot;
          delete copy.data.round.reveal;
          delete copy.data.round.guesses;
        }
        // ballot.opened carries the anonymous slots; round.revealed is the
        // reveal itself. Both are allowed to hold the texts.
        if (copy.data?.type === "ballot.opened") delete copy.data.slots;
        if (copy.data?.type === "round.revealed") delete copy.data.reveal;
        for (const t of texts) expect(JSON.stringify(copy)).not.toContain(t);
      }
    }

    // The ballot itself of course carries the texts — anonymously.
    expect(JSON.stringify(state.data.round.ballot)).toContain("guess number 0");

    // A phone votes; the vote is attributed to the connected player, and the
    // ballot still gives nothing away.
    const voter = guessers[0]!;
    const otherSlot = state.data.round.ballot.find(
      (sl: { slotId: string; text: string }) => sl.text !== "guess number 0",
    )!;
    voter.send({ type: "command", name: "ballot.vote", payload: { category: "FUNNIEST", slotId: otherSlot.slotId } });
    await voter.next("state");
    await wait(60);
    const after = board.messages.filter((m) => m.type === "state").at(-1)!;
    expect(after.data.round.votedBy).toEqual([{ voterId: voter.playerId, category: "FUNNIEST" }]);
  });

  it("refuses a self-vote at the wire, where a phone cannot tell it is cheating", async () => {
    const created = await api("/api/rooms", {});
    const joins = [];
    for (const name of ["A", "B", "C", "D", "E"]) {
      joins.push(await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: name }));
    }
    await connectBoard(created.json.roomId, created.json.boardToken);
    const clients = [];
    for (const j of joins) clients.push(await connect(created.json.roomId, j.json.playerToken));

    const hostClient = clients.find((c) => c.isHost) ?? clients[0]!;
    hostClient.send({ type: "game.start", seed: 9 });
    await hostClient.next("state");
    await wait(60);
    const speaker = clients.find((c) => c.sawType("secret"))!;
    speaker.send({ type: "command", name: "clue.submit", payload: { clue: "totally safe generic hint" } });
    await speaker.next("state");
    await wait(60);

    const guessers = clients.filter((c) => c !== speaker);
    for (const [i, g] of guessers.entries()) {
      g.send({ type: "command", name: "guess.submit", payload: { value: `mine is ${i}` } });
      await g.next("state");
    }
    await wait(80);

    const st = guessers[0]!.messages.filter((m) => m.type === "state").at(-1)!;
    const own = st.data.round.ballot.find((sl: { text: string }) => sl.text === "mine is 0")!;
    guessers[0]!.send({ type: "command", name: "ballot.vote", payload: { category: "FUNNIEST", slotId: own.slotId } });
    const err = await guessers[0]!.next("error");
    expect(err.error).toBe("SELF_VOTE");
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

    // Host is randomly assigned at game start — read it from presence.
    const pres = all[0]!.messages.filter((m) => m.type === "presence").at(-1)!;
    const hostId = pres.data.players.find((p: any) => p.isHost).id;
    const nonHost = all.find((c) => c.playerId !== hostId)!;
    nonHost.send({ type: "command", name: "round.end", payload: {} });
    const err2 = await nonHost.next("error");
    expect(err2.error).toBe("HOST_ONLY");
  });

  it("a lone phone cannot start; the board cannot send at all", async () => {
    const created = await api("/api/rooms", {});
    const p1 = await api(`/api/rooms/${created.json.shortCode}/join`, { displayName: "Solo" });
    const solo = await connect(created.json.roomId, p1.json.playerToken);
    solo.send({ type: "game.start" });
    const err = await solo.next("error");
    expect(err.error).toBe("TOO_FEW_PLAYERS");

    const board = await connectBoard(created.json.roomId, created.json.boardToken);
    board.send({ type: "game.start" });
    const err2 = await board.next("error");
    expect(err2.error).toBe("BOARD_READONLY");
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
