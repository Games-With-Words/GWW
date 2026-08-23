/**
 * Client state — a pure reducer over server messages so the realtime logic is
 * testable without a DOM or a socket. The server is the authority; this is
 * only a projection of what it told us.
 */

export interface PresencePlayer {
  id: string;
  displayName: string;
  isHost: boolean;
  connected: boolean;
}

export interface PublicRound {
  index: number;
  speakerId: string;
  budget: number;
  phase: "AWAITING_CLUE" | "GUESSING" | "VOTING" | "COMPLETE";
  category: string;
  clue?: string;
  guessCount: number;
  guessedPlayerIds: string[];
  winnerId?: string;
  endedReason?: string;
}

export interface PublicGameState {
  status: "IDLE" | "IN_ROUND" | "COMPLETE";
  roundIndex: number;
  maxRounds: number;
  scores: Record<string, number>;
  round?: PublicRound;
}

export interface SecretCard {
  roundIndex: number;
  budget: number;
  card: {
    secret: string;
    aliases: string[];
    category: string;
    forbidden: string[];
    revealLine?: string;
  };
}

export interface RevealInfo {
  roundIndex: number;
  secret: string;
  reason: string;
  winnerId?: string;
}

export interface RoomState {
  playerId: string;
  isHost: boolean;
  roomState: string;
  players: PresencePlayer[];
  game?: PublicGameState | undefined;
  secret?: SecretCard | undefined;
  lastReveal?: RevealInfo | undefined;
  /** Host caption rail — Phase 2 gives these Ris's voice; text ships now. */
  caption?: string | undefined;
  error?: string | undefined;
  flagged?: { roundIndex: number; reason: string } | undefined;
}

export function initialRoom(playerId: string, isHost: boolean, roomState: string): RoomState {
  return { playerId, isHost, roomState, players: [] };
}

function captionFor(s: RoomState, ev: { type: string; [k: string]: unknown }): string | undefined {
  switch (ev["type"]) {
    case "game.started":
      return "Welcome to the room. No strangers, no awkward accounts — just your circle.";
    case "round.started":
      return "New round. Speaker, your secret is on your screen. Everyone else — eyes up.";
    case "clue.accepted":
      return `The clue is in: “${String(ev["clue"])}”. Guess!`;
    case "clue.rejected":
      return "Ohh, that clue broke the rules. Round over — zero points, maximum shame.";
    case "clue.flagged":
      return "Hmm. That clue smells like a loophole. The room decides.";
    case "guess.accepted":
      return "YES! That's it!";
    case "round.completed": {
      const reason = String(ev["reason"] ?? "");
      if (reason === "TIMEOUT") return "Time! Nobody got it.";
      if (reason === "VOTE_REJECTED") return "The room has spoken: rejected.";
      return undefined;
    }
    case "game.completed":
      return "That's the game! Tell the story afterward — the best rounds become inside jokes.";
    default:
      return undefined;
  }
}

/** Apply one server message. Returns a NEW state (pure). */
export function reduce(s: RoomState, msg: { type: string; [k: string]: unknown }): RoomState {
  const data = msg["data"] as Record<string, unknown> | undefined;
  switch (msg.type) {
    case "presence": {
      const d = data as { state: string; players: PresencePlayer[] };
      return { ...s, roomState: d.state, players: d.players };
    }
    case "state": {
      const game = data as unknown as PublicGameState;
      // Entering a new round clears the previous round's secret and reveal.
      const changedRound = game.round?.index !== s.game?.round?.index;
      return {
        ...s,
        game,
        secret: changedRound ? undefined : s.secret,
        flagged: game.round?.phase === "VOTING" ? s.flagged : undefined,
      };
    }
    case "secret": {
      return { ...s, secret: data as unknown as SecretCard };
    }
    case "event": {
      const ev = data as { type: string; [k: string]: unknown };
      const caption = captionFor(s, ev) ?? s.caption;
      let next: RoomState = { ...s, caption };
      if (ev.type === "round.completed") {
        next = {
          ...next,
          lastReveal: {
            roundIndex: Number(ev["roundIndex"]),
            secret: String(ev["secret"]),
            reason: String(ev["reason"]),
            ...(ev["winnerId"] !== undefined ? { winnerId: String(ev["winnerId"]) } : {}),
          },
        };
      }
      if (ev.type === "clue.flagged") {
        next = { ...next, flagged: { roundIndex: Number(ev["roundIndex"]), reason: String(ev["reason"]) } };
      }
      return next;
    }
    case "error": {
      return { ...s, error: String(msg["message"] ?? "Something went wrong.") };
    }
    default:
      return s;
  }
}

/** What role does this device hold right now? */
export function roleOf(s: RoomState): "HOST" | "SPEAKER" | "GUESSER" {
  if (s.game?.round !== undefined && s.game.round.phase !== "COMPLETE" && s.game.round.speakerId === s.playerId) {
    return "SPEAKER";
  }
  return s.isHost ? "HOST" : "GUESSER";
}

export function nameOf(s: RoomState, playerId: string | undefined): string {
  if (playerId === undefined) return "?";
  return s.players.find((p) => p.id === playerId)?.displayName ?? "?";
}

export function hasGuessed(s: RoomState): boolean {
  return s.game?.round?.guessedPlayerIds.includes(s.playerId) ?? false;
}

/** Build the join URL a QR code carries. */
export function joinUrl(origin: string, shortCode: string, joinToken: string): string {
  return `${origin}/#/join/${shortCode}/${joinToken}`;
}
