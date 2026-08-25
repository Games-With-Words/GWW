/**
 * Claiming a seat back — the rules that keep it a reunion and not a hijack.
 *
 * Found in a real game (2026-08-25): a player's socket dropped after the game
 * started, join refused them with GAME_IN_PROGRESS, and because the randomly
 * assigned host was the one who went dark — and round.start is host-only — the
 * whole room deadlocked on a phone that no longer existed.
 */

import { describe, expect, it } from "vitest";
import { RoomStore } from "../src/rooms.js";

function room3() {
  const rooms = new RoomStore();
  const { room, joinToken } = rooms.create("ghostwriter", Date.now());
  const seats = ["Mark", "Vex", "Sonia"].map(
    (n) => rooms.join(room, n, Date.now(), joinToken),
  );
  for (const s of seats) s.player.connected = true;
  return { rooms, room, seats };
}

describe("reclaiming a seat", () => {
  it("returns the SAME player id, so the seat in the session is the seat you get", () => {
    const { rooms, room, seats } = room3();
    room.state = "PLAYING";
    const sonia = seats[2]!.player;
    sonia.connected = false;

    const back = rooms.reclaim(room, "Sonia", Date.now());
    expect(back).toBeDefined();
    expect(back!.player.id).toBe(sonia.id);
    // And the room did not grow a stranger.
    expect(room.players.size).toBe(3);
  });

  it("works while the game is in progress — the entire point", () => {
    const { rooms, room, seats } = room3();
    room.state = "PLAYING";
    seats[2]!.player.connected = false;

    // The front door is shut...
    // RoomError carries the code on `.code`, not in the message.
    let refusal: { code?: string } | undefined;
    try { rooms.join(room, "Anyone", Date.now()); } catch (e) { refusal = e as { code?: string }; }
    expect(refusal?.code).toBe("GAME_IN_PROGRESS");
    // ...but a returning player is not a new player.
    expect(rooms.reclaim(room, "Sonia", Date.now())).toBeDefined();
  });

  it("refuses in the LOBBY — a half-arrived player's name is not up for grabs", () => {
    /**
     * REGRESSION, caught by the existing gateway suite within a minute of the
     * first version of this feature.
     *
     * `connected` is false between joining and the socket opening, so in the
     * lobby "claim a disconnected seat" matched players who were simply still
     * arriving — and anyone who typed their name took it. Reclaim is only for a
     * session whose player list is already frozen; in the lobby a duplicate name
     * is what NAME_TAKEN is for.
     */
    const { rooms, room, seats } = room3();
    seats[2]!.player.connected = false;   // joined, socket not open yet
    expect(room.state).not.toBe("PLAYING");
    expect(rooms.reclaim(room, "Sonia", Date.now())).toBeUndefined();

    let err: { code?: string } | undefined;
    try { rooms.join(room, "Sonia", Date.now()); } catch (e) { err = e as { code?: string }; }
    expect(err?.code).toBe("NAME_TAKEN");
  });

  it("REFUSES a seat someone is currently sitting in", () => {
    /**
     * The security property. In Ghost Writer a seat carries the prompt, and in
     * Say Less it can carry the secret — so if a name match could take over a
     * live seat, "type their name" would be a way to read another player's
     * private view.
     */
    const { rooms, room } = room3();
    room.state = "PLAYING";
    expect(rooms.reclaim(room, "Sonia", Date.now())).toBeUndefined();
    expect(rooms.reclaim(room, "Mark", Date.now())).toBeUndefined();
  });

  it("rotates the token, killing the dead device's link", () => {
    const { rooms, room, seats } = room3();
    room.state = "PLAYING";
    const sonia = seats[2]!;
    sonia.player.connected = false;
    const oldToken = sonia.playerToken;

    const back = rooms.reclaim(room, "Sonia", Date.now())!;
    expect(back.playerToken).not.toBe(oldToken);
    // The new token authenticates; the old one is gone.
    expect(rooms.authenticate(room, back.playerToken)?.id).toBe(sonia.player.id);
    expect(rooms.authenticate(room, oldToken)).toBeUndefined();
  });

  it("matches a name the way a person retypes it", () => {
    const { rooms, room, seats } = room3();
    room.state = "PLAYING";
    seats[2]!.player.connected = false;
    const back = rooms.reclaim(room, "  sOnIa  ", Date.now());
    expect(back?.player.id).toBe(seats[2]!.player.id);
  });

  it("does not invent a seat for a name that was never in the room", () => {
    const { rooms, room } = room3();
    room.state = "PLAYING";
    room.players.forEach((p) => { p.connected = false; });
    expect(rooms.reclaim(room, "Gatecrasher", Date.now())).toBeUndefined();
    expect(rooms.reclaim(room, "", Date.now())).toBeUndefined();
    expect(rooms.reclaim(room, "   ", Date.now())).toBeUndefined();
  });

  it("refuses once the room has expired", () => {
    const { rooms, room, seats } = room3();
    seats[2]!.player.connected = false;
    room.state = "EXPIRED";
    expect(rooms.reclaim(room, "Sonia", Date.now())).toBeUndefined();
  });

  it("un-deadlocks the room: the host comes back and is still the host", () => {
    /**
     * The exact live failure. The host went dark, round.start is host-only, and
     * nobody else could advance the game. Reclaim has to restore the host FLAG
     * along with the seat, or the room is just as stuck with a reconnected
     * player who still cannot start anything.
     */
    const { rooms, room, seats } = room3();
    room.state = "PLAYING";
    const host = rooms.assignRandomHost(room)!;
    host.connected = false;

    const back = rooms.reclaim(room, host.displayName, Date.now())!;
    expect(back.player.id).toBe(host.id);
    expect(back.player.isHost).toBe(true);
    expect([...room.players.values()].filter((p) => p.isHost)).toHaveLength(1);
  });
});
