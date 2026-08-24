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
  /**
   * Per-cycle CEILING on the clue length, in words. A clue must come in at or
   * under it — spending the whole allowance is never required.
   *
   * This used to be [7, 5, 3, 1], tightening to a single word by the last
   * rotation, and that was the worst design call in the game. A one-word budget
   * is not a challenge, it is a chore: there is nothing to write, so nobody
   * wants their turn. Playtest verdict, first outside player: "nobody wants to
   * make a 1 word clue."
   *
   * So the curve now RISES. It opens tight while the room is still warming up
   * and reading each other, then hands over real writing room once everyone is
   * loose — by the late rounds a clue can be a whole shared memory, which is
   * the thing people actually repeat back to each other afterwards. Tension
   * comes from the clock and the forbidden words, never from a word count that
   * makes the Speaker's job unpleasant.
   */
  phaseBudgets: number[];
  /** Hard cap on total rounds. */
  maxRounds: number;
  /** Milliseconds for a clue to be composed. Enforced by the server clock, not the engine. */
  clueTimeoutMs: number;
  /** Milliseconds for guessing after a clue is broadcast. */
  guessTimeoutMs: number;
  /** Bonus window for fast answers (spec §04 scoring: within first 10 seconds). */
  fastAnswerMs: number;
  /** Milliseconds the room gets to vote. Party games die on dead time. */
  ballotTimeoutMs: number;
  /**
   * Fewest players for the community ballot to run at all.
   * Below this the round goes straight from GUESSING to COMPLETE — two guesses
   * is too thin a ballot to be worth the pause.
   */
  minPlayersForBallot: number;
}

/**
 * The floor no round may go below, whatever the card or the cycle says.
 *
 * Six words is enough to build a sentence with a joke in it. Below that the
 * Speaker is solving a puzzle instead of performing, which is the failure this
 * whole change exists to undo.
 */
export const MIN_CLUE_BUDGET = 6;

export const DEFAULT_CONFIG: Omit<SessionConfig, "seed"> = {
  phaseBudgets: [6, 8, 10, 15, 20],
  maxRounds: 24,
  clueTimeoutMs: 45_000,
  guessTimeoutMs: 60_000,
  fastAnswerMs: 10_000,
  ballotTimeoutMs: 15_000,
  minPlayersForBallot: 4,
};

export type RoundPhase =
  | "AWAITING_CLUE"
  | "GUESSING"
  /** SUSPICIOUS clue under room vote. NOT the community ballot — see BALLOT. */
  | "VOTING"
  /** Community ballot: guesses shown anonymously, room votes funniest + closest. */
  | "BALLOT"
  | "COMPLETE";

/** The two awards the room votes on. Independent; a guess can win both. */
export type VoteCategory = "FUNNIEST" | "CLOSEST";

/**
 * One anonymized guess on the ballot.
 *
 * Deliberately carries NO player id. The owner mapping lives in a separate
 * field (`ballotOwners`) so that broadcasting the ballot is safe by
 * construction — leaking identity has to be an explicit act, not an oversight.
 */
export interface BallotSlot {
  slotId: string;
  text: string;
}

export interface VoteRecord {
  voterId: string;
  category: VoteCategory;
  slotId: string;
}

/** What the board shows once the round is scored. Identity is revealed HERE. */
export interface RoundReveal {
  secret: string;
  /** slotId -> playerId. The anonymity boundary drops at reveal, not before. */
  owners: Record<string, string>;
  correctPlayerIds: string[];
  funniest: { slotId: string; playerId: string; votes: number }[];
  closest: { slotId: string; playerId: string; votes: number }[];
}

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
  /** Anonymized, deterministically shuffled. Present from BALLOT onward. */
  ballot?: BallotSlot[];
  /** slotId -> playerId. Server-side only until the reveal. */
  ballotOwners?: Record<string, string>;
  votes: VoteRecord[];
  reveal?: RoundReveal;
  /** First correct guesser, by submission time. Undefined if nobody was right. */
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
    | "ALL_SOLVED"
    | "FUNNIEST"
    | "CLOSEST";
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
  | { type: "ballot.opened"; roundIndex: number; slots: BallotSlot[] }
  | { type: "vote.submitted"; roundIndex: number; voterId: string; category: VoteCategory }
  | { type: "ballot.closed"; roundIndex: number }
  | { type: "round.revealed"; roundIndex: number; reveal: RoundReveal }
  | { type: "round.completed"; roundIndex: number; reason: NonNullable<RoundState["endedReason"]>; winnerId?: string; secret: string }
  | { type: "score.updated"; events: ScoreEvent[]; totals: Record<string, number> }
  | { type: "game.completed"; totals: Record<string, number> };
