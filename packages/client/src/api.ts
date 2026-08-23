/** REST + WebSocket client for @gww/server. */

export interface CreatedRoom {
  roomId: string;
  shortCode: string;
  joinToken: string;
  hostToken: string;
  playerId: string;
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
  createRoom: (displayName: string, gameId: string): Promise<CreatedRoom> =>
    post("/api/rooms", { displayName, gameId }),
  joinRoom: (code: string, displayName: string, joinToken?: string): Promise<JoinedRoom> =>
    post(`/api/rooms/${encodeURIComponent(code)}/join`, { displayName, joinToken }),
};

export interface Socket {
  send(msg: unknown): void;
  close(): void;
}

export function openSocket(
  roomId: string,
  token: string,
  onMessage: (msg: { type: string; [k: string]: unknown }) => void,
  onClose: () => void,
): Socket {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(roomId)}&token=${encodeURIComponent(token)}`);
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)));
    } catch {
      /* ignore non-JSON frames */
    }
  };
  ws.onclose = onClose;
  return {
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
  };
}
