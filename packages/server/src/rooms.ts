/**
 * Private lobby service (spec §02 room model, §03 lobby states, §11 safeguards).
 * In-memory store behind an interface — the NEDB-backed store lands in its own PR
 * and drops in behind RoomStore without touching the gateway.
 */

import { hashToken, newShortCode, newToken } from "./tokens.js";

export type LobbyState = "CREATED" | "GATHERING" | "PLAYING" | "SUMMARY" | "EXPIRED";

export interface RoomPlayer {
  id: string;
  displayName: string;
  tokenHash: string;
  connected: boolean;
  isHost: boolean;
  joinedAt: number;
}

export interface Room {
  id: string;
  shortCode: string;
  joinTokenHash: string;
  /** Display-board credential (desktop/TV). A board is never a player. */
  boardTokenHash: string;
  state: LobbyState;
  gameId: string;
  players: Map<string, RoomPlayer>;
  createdAt: number;
  expiresAt: number;
  /** Bumped when the host rotates the join token; old links die instantly. */
  tokenVersion: number;
}

export const DEFAULT_ROOM_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

const MAX_PLAYERS = 20; // spec §02: tolerate at least 20 invited devices

let nextId = 0;
function newId(prefix: string): string {
  nextId += 1;
  return `${prefix}_${Date.now().toString(36)}_${nextId.toString(36)}_${newToken().slice(0, 8)}`;
}

export class RoomError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export class RoomStore {
  private rooms = new Map<string, Room>();
  private byCode = new Map<string, string>();

  create(gameId: string, now: number, ttlMs: number = DEFAULT_ROOM_TTL_MS): {
    room: Room;
    joinToken: string;
    boardToken: string;
  } {
    const joinToken = newToken();
    const boardToken = newToken();
    let shortCode = newShortCode();
    while (this.byCode.has(shortCode)) shortCode = newShortCode();

    const room: Room = {
      id: newId("room"),
      shortCode,
      joinTokenHash: hashToken(joinToken),
      boardTokenHash: hashToken(boardToken),
      state: "CREATED",
      gameId,
      players: new Map(),
      createdAt: now,
      expiresAt: now + ttlMs,
      tokenVersion: 1,
    };
    this.rooms.set(room.id, room);
    this.byCode.set(shortCode, room.id);
    return { room, joinToken, boardToken };
  }

  get(roomId: string, now: number): Room | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;
    if (room.state !== "EXPIRED" && now >= room.expiresAt) {
      this.expire(room);
    }
    return room;
  }

  getByCode(code: string, now: number): Room | undefined {
    const id = this.byCode.get(code.toUpperCase());
    return id === undefined ? undefined : this.get(id, now);
  }

  /**
   * Join by short code + join token (QR carries both; manual entry types the code).
   * v0.1 accepts EITHER a valid join token or the bare short code — the code IS
   * the low-friction path (spec §13: QR always has an accessible code alternative).
   * Rate limiting on code attempts belongs to the HTTP layer.
   */
  join(room: Room, displayName: string, now: number, joinToken?: string): {
    player: RoomPlayer;
    playerToken: string;
  } {
    if (room.state === "EXPIRED") throw new RoomError("ROOM_EXPIRED", "This room has ended.");
    if (room.state === "PLAYING") throw new RoomError("GAME_IN_PROGRESS", "The game already started.");
    if (room.players.size >= MAX_PLAYERS) throw new RoomError("ROOM_FULL", "This room is full.");
    if (joinToken !== undefined && hashToken(joinToken) !== room.joinTokenHash) {
      throw new RoomError("BAD_TOKEN", "Invalid or rotated join link.");
    }

    const name = displayName.trim().slice(0, 24);
    if (name.length === 0) throw new RoomError("BAD_NAME", "Display name required.");
    const taken = [...room.players.values()].some(
      (p) => p.displayName.toLowerCase() === name.toLowerCase(),
    );
    if (taken) throw new RoomError("NAME_TAKEN", "That name is taken in this room.");

    const playerToken = newToken();
    const player: RoomPlayer = {
      id: newId("p"),
      displayName: name,
      tokenHash: hashToken(playerToken),
      connected: false,
      // Nobody is host at join time. The host is picked at RANDOM when the
      // game starts — hosting is a job, not a reward for scanning first.
      isHost: false,
      joinedAt: now,
    };
    room.players.set(player.id, player);
    if (room.state === "CREATED") room.state = "GATHERING";
    return { player, playerToken };
  }

  /**
   * CLAIM A SEAT BACK BY NAME.
   *
   * Mark, from a live game (2026-08-25): "you need to let the game let people
   * back in to claim their names."
   *
   * A party game runs on phones, and phones die. Before this, a player whose
   * socket dropped after the game started could not get back in at all — join
   * refused with GAME_IN_PROGRESS, because the session's player list is fixed
   * when the game begins and a NEW player has no seat to sit in.
   *
   * But they already HAVE a seat. Their id is in the session, their score is on
   * the board, and the round may be waiting on their answer. So this reunites a
   * person with the seat that is already theirs instead of pretending they are a
   * stranger. It found us during a real game: the randomly-assigned host went
   * dark, round.start is host-only, and the whole room deadlocked on a phone
   * that no longer existed.
   *
   * RULES, and each one matters:
   * - only a DISCONNECTED seat can be claimed. A connected seat is somebody
   *   sitting in it, and letting a name match take it over would be a way to
   *   steal another player's identity — and in Ghost Writer, their prompt.
   * - the token is ROTATED on reclaim, so the dead device's old link is dead.
   * - names match case-insensitively and trimmed, because a person retyping
   *   their own name is not going to reproduce their capitalisation.
   */
  reclaim(room: Room, displayName: string, now: number): {
    player: RoomPlayer;
    playerToken: string;
  } | undefined {
    if (room.state === "EXPIRED") return undefined;

    /**
     * ONLY once the game has started. This is not caution, it is a hole I opened
     * and the existing gateway suite caught within a minute.
     *
     * `connected` is false from the moment someone joins until their socket
     * actually opens. So while the room is still gathering, "claim a seat whose
     * socket is down" matches a player who has simply not finished arriving —
     * and anyone typing their name would take the seat out from under them. In a
     * living room that is the person next to you stealing your identity by
     * spelling it correctly.
     *
     * In the lobby there is nothing to reclaim anyway: a normal join works, and
     * a duplicate name is exactly what NAME_TAKEN is for. Reclaim exists only
     * for the window where the session's player list is already frozen.
     */
    if (room.state !== "PLAYING" && room.state !== "SUMMARY") return undefined;
    const name = displayName.trim().slice(0, 24).toLowerCase();
    if (name.length === 0) return undefined;

    for (const p of room.players.values()) {
      if (p.displayName.toLowerCase() !== name) continue;
      // Someone is holding this seat right now — not up for grabs.
      if (p.connected) return undefined;
      const playerToken = newToken();
      p.tokenHash = hashToken(playerToken);
      p.joinedAt = now;
      return { player: p, playerToken };
    }
    return undefined;
  }

  /** Resolve a player token to its player (reconnection, spec §12). */
  authenticate(room: Room, playerToken: string): RoomPlayer | undefined {
    const h = hashToken(playerToken);
    for (const p of room.players.values()) {
      if (p.tokenHash === h) return p;
    }
    return undefined;
  }

  /** Authenticate a display board by its token. */
  authenticateBoard(room: Room, boardToken: string): boolean {
    return hashToken(boardToken) === room.boardTokenHash;
  }

  /** Pick a random connected player as host (called once, at game start). */
  assignRandomHost(room: Room): RoomPlayer | undefined {
    const candidates = [...room.players.values()].filter((p) => p.connected);
    const pool = candidates.length > 0 ? candidates : [...room.players.values()];
    if (pool.length === 0) return undefined;
    for (const p of room.players.values()) p.isHost = false;
    const chosen = pool[Math.floor(Math.random() * pool.length)]!;
    chosen.isHost = true;
    return chosen;
  }

  /** Host revokes the join link; a new token is issued (spec §11). */
  rotateJoinToken(room: Room): string {
    const t = newToken();
    room.joinTokenHash = hashToken(t);
    room.tokenVersion += 1;
    return t;
  }

  removePlayer(room: Room, playerId: string): boolean {
    return room.players.delete(playerId);
  }

  expire(room: Room): void {
    room.state = "EXPIRED";
    this.byCode.delete(room.shortCode);
  }

  close(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (room) this.expire(room);
  }
}
