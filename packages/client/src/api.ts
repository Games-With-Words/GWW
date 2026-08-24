/** REST + WebSocket client for @gww/server. */

export interface CreatedRoom {
  roomId: string;
  shortCode: string;
  joinToken: string;
  /** Display-board credential — the creating device watches, phones play. */
  boardToken: string;
  gameId: string;
}

export interface JoinedRoom {
  roomId: string;
  playerToken: string;
  playerId: string;
  gameId: string;
}

export interface GameTile {
  gameId: string;
  title: string;
  tagline: string;
  credit: { maker: string; line?: string };
  minPlayers: number;
  maxPlayers: number;
  sessionMinutes: [number, number];
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string; message?: string };
  if (!res.ok) throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`);
  return json;
}

export const api = {
  games: async (): Promise<GameTile[]> => {
    const res = await fetch("/api/games");
    const json = (await res.json()) as { games: GameTile[] };
    return json.games;
  },
  createRoom: (gameId: string): Promise<CreatedRoom> =>
    post("/api/rooms", { gameId }),
  joinRoom: (code: string, displayName: string, joinToken?: string): Promise<JoinedRoom> =>
    post(`/api/rooms/${encodeURIComponent(code)}/join`, { displayName, joinToken }),
};

export interface Socket {
  send(msg: unknown): void;
  close(): void;
}

/** Pure URL builder — the board/player credential choice lives HERE and is tested. */
export function wsUrl(host: string, secure: boolean, roomId: string, token: string, asBoard: boolean): string {
  const proto = secure ? "wss" : "ws";
  const cred = asBoard ? `board=${encodeURIComponent(token)}` : `token=${encodeURIComponent(token)}`;
  return `${proto}://${host}/ws?room=${encodeURIComponent(roomId)}&${cred}`;
}

export function openSocket(
  roomId: string,
  token: string,
  onMessage: (msg: { type: string; [k: string]: unknown }) => void,
  onClose: (code: number) => void,
  asBoard = false,
): Socket {
  const ws = new WebSocket(wsUrl(location.host, location.protocol === "https:", roomId, token, asBoard));
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)));
    } catch {
      /* ignore non-JSON frames */
    }
  };
  ws.onclose = (ev) => onClose(ev.code);
  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
