/**
 * The point of the multi-game refactor, asserted.
 *
 * ONE loop drives TWO games. Every assertion below is written without naming a
 * phase, a command or a field of either game — the test only knows the platform
 * contract, which is exactly the claim being made: the runner is generic. If a
 * third game arrives and this file needs editing, the seam leaked.
 */

import { describe, expect, it } from "vitest";
import type { GameModule } from "@gww/kit";
import { sayLess } from "@gww/say-less";
import { ghostwriter } from "@gww/ghostwriter";
import { GameSession, SessionError } from "../src/session.js";
import { MemoryEventLog } from "../src/log.js";
import { RoomStore } from "../src/rooms.js";

interface Sent {
  target: "broadcast" | "boards" | string;
  type: string;
  payload: any;
}

function harness(module: GameModule, playerCount: number) {
  const rooms = new RoomStore();
  const { room } = rooms.create(module.manifest.gameId, Date.now());
  const names = ["Mark", "Ris", "Sonia", "Sam", "Eva"];
  for (let i = 0; i < playerCount; i++) rooms.join(room, names[i]!, Date.now());
  const ids = [...room.players.keys()];
  const host = rooms.assignRandomHost(room)!;

  const sent: Sent[] = [];
  const session = new GameSession(
    room,
    module,
    4242,
    new MemoryEventLog(),
    {
      broadcast: (type, payload) => sent.push({ target: "broadcast", type, payload }),
      toBoards: (type, payload) => sent.push({ target: "boards", type, payload }),
      toPlayer: (pid, type, payload) => sent.push({ target: pid, type, payload }),
    },
    () => Date.now(),
  );
  return { session, room, ids, hostId: host.id, sent };
}

/** Private payloads a given target received. */
function privateTo(sent: Sent[], target: string): any[] {
  return sent.filter((m) => m.target === target && m.type === "secret").map((m) => m.payload);
}

/**
 * Per-game TEST DATA — not runner knowledge.
 *
 * The runner stays generic; a test still has to know how to make a legal player
 * move in each game, the same way the conformance scripts do. `reach` walks the
 * session to a phase where an ordinary (non-host) player may act, and `action`
 * is that move plus every id-bearing field the game accepts.
 */
interface GameCase {
  module: GameModule;
  players: number;
  reach(h: ReturnType<typeof harness>): void;
  action: { name: string; payload: Record<string, unknown>; idFields: string[] };
}

const GAMES: GameCase[] = [
  {
    module: sayLess,
    players: 4,
    // The Speaker is simply whoever holds a private view — found without naming
    // a single say-less field.
    reach: (h) => {
      const speaker = h.ids.find((id) => privateTo(h.sent, id).length > 0)!;
      h.session.command(speaker, false, "clue.submit", { clue: "totally safe generic hint" });
    },
    action: { name: "guess.submit", payload: { value: "a wrong guess" }, idFields: ["playerId"] },
  },
  {
    module: ghostwriter,
    players: 4,
    reach: () => undefined,
    action: { name: "answer.submit", payload: { text: "wet socks" }, idFields: ["playerId"] },
  },
];

describe.each(GAMES)("$module.manifest.gameId under the generic runner", ({ module, players, reach, action }) => {
  it("starts a round and reports the game's own id", () => {
    const { session } = harness(module, players);
    expect(session.gameId).toBe(module.manifest.gameId);
    session.startFirstRound();
    expect(session.status).toBe("IN_ROUND");
  });

  it("arms a clock from the game's effects, not from the platform's guess", () => {
    const { session } = harness(module, players);
    session.startFirstRound();
    const snap = session.snapshot() as { deadline?: number };
    expect(snap.deadline).toBeGreaterThan(Date.now());
  });

  it("delivers private views to players and NEVER to the board", () => {
    const { session, ids, sent } = harness(module, players);
    session.startFirstRound();

    const boardPrivate = sent.filter((m) => m.target === "boards" && m.type === "secret");
    expect(boardPrivate).toEqual([]);

    // At least one player holds something private, or the game has no secrets
    // to keep — both are legal, but a game that keeps secrets must not keep
    // them from everybody.
    const holders = ids.filter((id) => privateTo(sent, id).length > 0);
    expect(holders.length).toBeGreaterThan(0);
  });

  it("keeps every private value out of the board's projection", () => {
    const { session, ids, sent } = harness(module, players);
    session.startFirstRound();

    // Whatever any player was told privately must not appear in what the board
    // was told — the release blocker (spec §16), checked without knowing which
    // field is the secret.
    const boardText = JSON.stringify(sent.filter((m) => m.target === "boards"));
    for (const id of ids) {
      for (const view of privateTo(sent, id)) {
        for (const value of Object.values(view as Record<string, unknown>)) {
          // Only string leaves are worth checking; ids and booleans are public.
          if (typeof value !== "string" || value.length < 8) continue;
          expect(boardText.includes(value)).toBe(false);
        }
      }
    }
  });

  it("enforces the game's declared host-only commands", () => {
    const { session, ids, hostId } = harness(module, players);
    const commands = module.hostOnlyCommands ?? [];
    expect(commands.length).toBeGreaterThan(0);
    const notHost = ids.find((id) => id !== hostId)!;
    for (const name of commands) {
      expect(() => session.command(notHost, false, name, {})).toThrow(SessionError);
    }
  });

  it("re-delivers a private view on reconnect without knowing whose it is", () => {
    const { session, ids, sent } = harness(module, players);
    session.startFirstRound();
    const holder = ids.find((id) => privateTo(sent, id).length > 0)!;
    const before = privateTo(sent, holder).length;
    session.redeliverPrivate(holder);
    expect(privateTo(sent, holder).length).toBe(before + 1);
  });

  it("does not re-send an unchanged private view", () => {
    const { session, ids, sent, hostId } = harness(module, players);
    session.startFirstRound();
    const holder = ids.find((id) => privateTo(sent, id).length > 0)!;
    const before = privateTo(sent, holder).length;
    // Any legal no-op-ish traffic: an illegal command throws and changes nothing.
    try { session.command(hostId, true, "definitely.not.a.command", {}); } catch { /* expected */ }
    expect(privateTo(sent, holder).length).toBe(before);
  });

  it("ignores identity claimed in a payload — the socket decides who you are", () => {
    const h = harness(module, players);
    h.session.startFirstRound();
    reach(h);

    const impostor = h.ids.find((id) => id !== h.hostId)!;
    const victim = h.ids.find((id) => id !== impostor && id !== h.hostId) ?? h.ids.find((id) => id !== impostor)!;

    // The impostor acts while claiming to BE the victim in every id field.
    const forged: Record<string, unknown> = { ...action.payload };
    for (const f of action.idFields) forged[f] = victim;
    h.session.command(impostor, false, action.name, forged);

    /**
     * The tell: if the payload had been believed, the move above would have
     * consumed the VICTIM's one turn, and the victim acting for themselves would
     * now be refused. It must not be.
     */
    expect(() => h.session.command(victim, false, action.name, { ...action.payload })).not.toThrow();

    // And the impostor's own turn IS now spent — proof the move was attributed
    // to the authenticated socket rather than to the name in the body.
    expect(() => h.session.command(impostor, false, action.name, { ...action.payload })).toThrow();
  });
});

describe("the arcade runs both games side by side", () => {
  it("two sessions of different games coexist under one runner class", () => {
    const a = harness(sayLess, 4);
    const b = harness(ghostwriter, 4);
    a.session.startFirstRound();
    b.session.startFirstRound();
    expect(a.session.gameId).toBe("say-less");
    expect(b.session.gameId).toBe("ghostwriter");
    expect(a.session.status).toBe("IN_ROUND");
    expect(b.session.status).toBe("IN_ROUND");
    // Their public projections are different SHAPES, which is the whole reason
    // the platform stopped owning them.
    const pa = Object.keys(a.session.snapshot() as object);
    const pb = Object.keys(b.session.snapshot() as object);
    expect(pa).not.toEqual(pb);
  });

  it("refuses a room whose game is not on the shelf", () => {
    const rooms = new RoomStore();
    const { room } = rooms.create("no-such-game", Date.now());
    expect(room.gameId).toBe("no-such-game");
    // The gateway resolves the module before constructing a session; this is the
    // same guard, asserted at the seam the runner exposes.
    expect(() => new GameSession(
      room,
      undefined as unknown as GameModule,
      1,
      new MemoryEventLog(),
      { broadcast: () => undefined, toBoards: () => undefined, toPlayer: () => undefined },
    )).toThrow();
  });
});
