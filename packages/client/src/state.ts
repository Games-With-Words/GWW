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

/**
 * A round as any game describes it.
 *
 * MULTI-GAME: this used to be Say Less's round, field for field, with a phase
 * union of its own five phases. Now it is the union of what any game may publish,
 * every game-specific field optional, plus an index signature for fields a game
 * the client has never heard of might send.
 *
 * That sounds looser than it is. The client cannot enforce a game's shape anyway
 * — the server sends whatever `project()` returned — so pretending otherwise only
 * bought a type error at the boundary of a value that was already `unknown`. The
 * real safety lives in each game's view module, which reads its own fields and is
 * the only code that assumes they exist.
 */
export interface PublicRound {
  index: number;
  /** Game-defined phase name. COMPLETE is the one value every game shares. */
  phase: string;
  category?: string;

  // ---- Say Less ----------------------------------------------------------
  speakerId?: string;
  budget?: number;
  clue?: string;
  guessCount?: number;
  guessedPlayerIds?: string[];
  /** Public guess feed — wrong guesses are half the comedy. */
  guesses?: { playerId: string; value: string; correct: boolean }[];
  winnerId?: string;
  /** The ANONYMIZED ballot. Never carries a player id — that is the point. */
  ballot?: { slotId: string; text: string }[];
  /** Who has voted in which category, so a phone can grey out what it cast. */
  votedBy?: { voterId: string; category: VoteCategory }[];

  // ---- Ghostwriter -------------------------------------------------------
  answerCount?: number;
  answeredPlayerIds?: string[];
  /** Anonymized answers on the board. No authorship until the reveal. */
  slots?: { slotId: string; text: string }[];
  votedPlayerIds?: string[];

  // ---- shared ------------------------------------------------------------
  endedReason?: string;
  /** Card's reveal line, public once the round completes. */
  revealLine?: string;
  /** Present only once the round completes. Identity drops HERE. */
  reveal?: RoundReveal;
  [key: string]: unknown;
}

export type VoteCategory = "FUNNIEST" | "CLOSEST";

/**
 * The reveal, as any game publishes it. All optional for the same reason
 * PublicRound's fields are: the shape belongs to the game, and its view module
 * is the only code that should assume which half arrived.
 */
export interface RoundReveal {
  /** Say Less: the answer. */
  secret?: string;
  /** Ghostwriter: the question, and who was writing blind. */
  prompt?: string;
  essence?: string;
  ghostId?: string;
  ghostSlotId?: string;
  caught?: boolean;
  catcherIds?: string[];
  framedId?: string;
  lastWord?: { text: string; correct: boolean };
  tally?: { slotId: string; playerId: string; votes: number }[];
  /** slotId -> playerId. Arrives only at the reveal. */
  owners?: Record<string, string>;
  correctPlayerIds?: string[];
  funniest?: { slotId: string; playerId: string; votes: number }[];
  closest?: { slotId: string; playerId: string; votes: number }[];
  [key: string]: unknown;
}

export interface PublicGameState {
  status: "IDLE" | "IN_ROUND" | "COMPLETE";
  roundIndex: number;
  maxRounds: number;
  scores: Record<string, number>;
  round?: PublicRound;
  /** Server-time deadline of the running phase timer (countdowns). */
  deadline?: number;
  serverTime?: number;
}

/**
 * Whatever is privately mine this round.
 *
 * The wire type is still "secret" and the shape is still Say Less's card, plus
 * Ghostwriter's prompt-or-blindfold. A game's private view is delivered by the
 * platform on change, so a client just holds the latest one and lets the game's
 * view module read the fields it knows.
 */
export interface SecretCard {
  roundIndex: number;
  budget?: number;
  card?: {
    secret: string;
    aliases: string[];
    category: string;
    forbidden: string[];
    revealLine?: string;
  };
  /** Ghostwriter: am I the one who never saw the prompt? */
  isGhost?: boolean;
  prompt?: string;
  category?: string;
  answerWords?: number;
  [key: string]: unknown;
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
  /** True when this device is the display board (desktop/TV). */
  isBoard: boolean;
  roomState: string;
  players: PresencePlayer[];
  game?: PublicGameState | undefined;
  secret?: SecretCard | undefined;
  lastReveal?: RevealInfo | undefined;
  /** Host caption rail — Phase 2 gives these Ris's voice; text ships now. */
  caption?: string | undefined;
  error?: string | undefined;
  flagged?: { roundIndex: number; reason: string } | undefined;
  /** Client-clock timestamp when the latest state arrived (countdown anchor). */
  stateReceivedAt?: number | undefined;
}

export function initialRoom(playerId: string, isHost: boolean, roomState: string, isBoard = false): RoomState {
  return { playerId, isHost, isBoard, roomState, players: [] };
}

/** Host badge follows presence — the server assigns it randomly at game start. */
export function amHost(s: RoomState): boolean {
  return s.players.find((p) => p.id === s.playerId)?.isHost ?? s.isHost;
}

/** Milliseconds left on the phase clock, clamped at zero. */
export function msLeft(s: RoomState, clientNow: number): number | undefined {
  const g = s.game;
  if (g?.deadline === undefined || g.serverTime === undefined) return undefined;
  // Anchor to server time to survive client clock skew.
  return Math.max(0, g.deadline - g.serverTime - (clientNow - (s.stateReceivedAt ?? clientNow)));
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
    case "ballot.opened":
      return "Everyone's in. Nobody knows who wrote what — vote on your phones!";
    case "round.revealed":
      return "Hands off the phones. Let's see who wrote what.";
    case "round.completed": {
      const reason = String(ev["reason"] ?? "");
      if (reason === "TIMEOUT") return "Time! Nobody got it.";
      if (reason === "VOTE_REJECTED") return "The room has spoken: rejected.";
      return undefined;
    }
    case "game.completed":
      return "That's the game! Tell the story afterward — the best rounds become inside jokes.";

    // ---- Ghostwriter ----------------------------------------------------
    // Captions stay here rather than moving into the view modules: they are
    // CONTENT keyed by event name, the reducer is pure and easy to test, and
    // event names are already namespaced enough not to collide.
    case "answers.closed":
      return "Answers are in, and nobody knows who wrote what. One of them was guessing.";
    case "ghost.caught":
      return "CAUGHT! Now — do they even know what the question was?";
    case "ghost.survived":
      return "The Ghost walks. You were right there.";
    case "lastword.submitted":
      return String(ev["correct"]) === "true"
        ? "They named it. Blind. Give them that one."
        : "Not even close. Beautiful.";
    case "answer.rejected":
      return "That one would've given the game away. Say it sideways.";
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
      // Keep the secret exactly while it belongs to the CURRENT round.
      // Key on the secret's own roundIndex — comparing previous game state
      // wiped a just-received secret on the FIRST state after game start
      // (round 0 vs undefined read as "round changed"), leaving the Speaker
      // staring at "Fetching your secret…" forever. Found in live play.
      const secretStillCurrent =
        s.secret !== undefined && game.round !== undefined && s.secret.roundIndex === game.round.index;
      return {
        ...s,
        game,
        stateReceivedAt: Date.now(),
        secret: secretStillCurrent ? s.secret : undefined,
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

/**
 * The DEFAULT role for a device. A game's view may override the label (Ghostwriter
 * calls its roles GHOST and WRITER) — this stays the fallback, and the answer for
 * any game that has a speaker-shaped role or none at all.
 */
export function roleOf(s: RoomState): "BOARD" | "HOST" | "SPEAKER" | "GUESSER" {
  if (s.isBoard) return "BOARD";
  if (s.game?.round !== undefined && s.game.round.phase !== "COMPLETE" && s.game.round.speakerId === s.playerId) {
    return "SPEAKER";
  }
  return amHost(s) ? "HOST" : "GUESSER";
}

export function nameOf(s: RoomState, playerId: string | undefined): string {
  if (playerId === undefined) return "?";
  return s.players.find((p) => p.id === playerId)?.displayName ?? "?";
}

export function hasGuessed(s: RoomState): boolean {
  return (s.game?.round?.guessedPlayerIds ?? []).includes(s.playerId);
}

/** Build the join URL a QR code carries. */
export function joinUrl(origin: string, shortCode: string, joinToken: string): string {
  return `${origin}/#/join/${shortCode}/${joinToken}`;
}
