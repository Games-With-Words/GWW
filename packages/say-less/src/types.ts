/**
 * Core Say Less types.
 * Spec: Games With Words Design Spec v0.1 §04 (flagship game), §10 (data model).
 */

export interface Card {
  id: string;
  secret: string;
  /** Predeclared alternates accepted deterministically (spec §04 core round, step 7). */
  aliases: string[];
  category: string;
  /** Terms the Speaker may not use in a clue. */
  forbidden: string[];
  /** Default clue word budget for this card (rounds may override per difficulty curve). */
  budget: number;
  /** 1 = warm-up … 4 = final. */
  difficulty: 1 | 2 | 3 | 4;
  /** Host reveal line spoken/shown at round end. */
  revealLine?: string;
}

export type ClueVerdict =
  | { status: "ACCEPTED"; normalized: string; wordCount: number }
  | { status: "REJECTED"; reason: RejectionReason; detail: string }
  /** Semantic loophole suspicion — routed to a room-visible vote (spec §04 rule boundaries). */
  | { status: "SUSPICIOUS"; reason: string; normalized: string; wordCount: number };

export type RejectionReason =
  | "OVER_BUDGET"
  | "ANSWER_TOKEN"
  | "ALIAS_TOKEN"
  | "FORBIDDEN_TERM"
  | "OBVIOUS_SUBSTRING"
  | "INITIALS"
  | "SOUNDS_LIKE_LOOPHOLE"
  | "EMPTY";

export interface Player {
  id: string;
  displayName: string;
}

export interface SessionConfig {
  /** Deterministic seed — same seed + same events = same session. */
  seed: number;
  /** Escalating budgets by phase (spec §04 difficulty curve). Applied per full rotation cycle. */
  phaseBudgets: number[];
  /** Hard cap on total rounds. */
  maxRounds: number;
  /** Milliseconds for a clue to be composed. Enforced by the server clock, not the engine. */
  clueTimeoutMs: number;
  /** Milliseconds for guessing after a clue is broadcast. */
  guessTimeoutMs: number;
  /** Bonus window for fast answers (spec §04 scoring: within first 10 seconds). */
  fastAnswerMs: number;
}

export const DEFAULT_CONFIG: Omit<SessionConfig, "seed"> = {
  phaseBudgets: [7, 5, 3, 1],
  maxRounds: 24,
  clueTimeoutMs: 45_000,
  guessTimeoutMs: 60_000,
  fastAnswerMs: 10_000,
};

export type RoundPhase =
  | "AWAITING_CLUE"
  | "GUESSING"
  | "VOTING" // SUSPICIOUS clue under room vote
  | "COMPLETE";

export interface RoundState {
  index: number;
  speakerId: string;
  card: Card;
  budget: number;
  phase: RoundPhase;
  clue?: string;
  clueNormalized?: string;
  clueAcceptedAt?: number;
  /** playerId -> submitted (dedup, one guess per player per clue in v0.1 playtest rules). */
  guesses: GuessRecord[];
  winnerId?: string;
  endedReason?: "CORRECT" | "TIMEOUT" | "HOST_ENDED" | "CLUE_REJECTED" | "VOTE_REJECTED";
}

export interface GuessRecord {
  playerId: string;
  value: string;
  normalized: string;
  at: number;
  correct: boolean;
}

export interface ScoreEvent {
  roundIndex: number;
  playerId: string;
  reason:
    | "SPEAKER_CORRECT"
    | "GUESSER_CORRECT"
    | "FIRST_CORRECT"
    | "UNUSED_WORDS"
    | "SPEAKER_FAST"
    | "GUESSER_FAST"
    | "ALL_SOLVED";
  delta: number;
}

export interface SessionState {
  config: SessionConfig;
  players: Player[];
  /** Deterministic speaker order for the current rotation cycle. */
  rotation: string[];
  rotationCursor: number;
  cycle: number;
  deck: Card[];
  deckCursor: number;
  roundIndex: number;
  round?: RoundState;
  scores: Record<string, number>;
  scoreLog: ScoreEvent[];
  status: "IDLE" | "IN_ROUND" | "COMPLETE";
}

/**
 * Room event envelope payloads produced by the engine (spec §09 minimum event vocabulary).
 * The engine emits these; the lobby/gateway layer wraps them in the full envelope
 * (event_id, room_id, sequence, server_time) and persists them to the NEDB event log.
 */
export type EngineEvent =
  | { type: "game.started"; playerIds: string[]; seed: number }
  | { type: "round.started"; roundIndex: number; speakerId: string; cardId: string; budget: number }
  | { type: "clue.submitted"; roundIndex: number; speakerId: string; clue: string }
  | { type: "clue.accepted"; roundIndex: number; clue: string; wordCount: number }
  | { type: "clue.flagged"; roundIndex: number; reason: string }
  | { type: "clue.rejected"; roundIndex: number; reason: RejectionReason; detail: string }
  | { type: "guess.submitted"; roundIndex: number; playerId: string; value: string }
  | { type: "guess.accepted"; roundIndex: number; playerId: string }
  | { type: "round.completed"; roundIndex: number; reason: NonNullable<RoundState["endedReason"]>; winnerId?: string; secret: string }
  | { type: "score.updated"; events: ScoreEvent[]; totals: Record<string, number> }
  | { type: "game.completed"; totals: Record<string, number> };
