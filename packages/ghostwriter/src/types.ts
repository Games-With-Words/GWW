/**
 * Ghostwriter — core types.
 *
 * Game #2 in the arcade, by Vex. The mechanical inverse of Say Less: where Say
 * Less is compression under a budget, Ghostwriter is inference under exposure.
 * Everyone answers the prompt except one player, who never saw it and has to
 * write something that sounds like it belongs.
 *
 * Design constraint that shaped every type below: the whole game IS the private
 * channel (spec §16, CONTRIBUTING house rule 3). So the shapes here are built so
 * that leaking the prompt to the Ghost, or authorship to the room, requires an
 * explicit act rather than an oversight. Anything one player must not see lives
 * in a separate field from the thing the room is allowed to look at.
 */

/**
 * One prompt card.
 *
 * `essence` and `aliases` exist because the Ghost's last-word bonus asks them to
 * name the prompt they never saw — and nobody can reproduce a question verbatim.
 * What they can do is name the SUBJECT ("overrated tourist traps"), so that is
 * what gets matched.
 */
export interface PromptCard {
  id: string;
  /** The question the room answers, shown verbatim to everyone but the Ghost. */
  prompt: string;
  /**
   * Canonical short subject of the prompt, for the Ghost's last-word guess.
   * Not shown to anyone until the reveal.
   */
  essence: string;
  /** Additional accepted phrasings of the essence. Deterministic, predeclared. */
  aliases: string[];
  category: string;
  /**
   * Terms that would hand the prompt to the Ghost if they appeared in an answer.
   * A non-Ghost who writes one is told to try again — see rules.ts TOO_TELLING.
   * This is the Say Less `forbidden` idea pointed at a different failure: there,
   * a forbidden term makes the round too easy; here, it ends the game outright.
   */
  telling: string[];
  /** 1 = warm-up … 4 = final. Drives nothing yet; the forge gates on it. */
  difficulty: 1 | 2 | 3 | 4;
  /** Host line shown/spoken when the round is revealed. */
  revealLine?: string;
}

export interface Player {
  id: string;
  displayName: string;
}

export type AnswerVerdict =
  | { status: "ACCEPTED"; normalized: string; wordCount: number }
  | { status: "REJECTED"; reason: AnswerRejection; detail: string };

export type AnswerRejection =
  | "EMPTY"
  | "TOO_LONG"
  /** Contains a term that would reveal the prompt to the Ghost. */
  | "TOO_TELLING"
  /** Identical to an answer already in. Copying is a safety play, not a bluff. */
  | "DUPLICATE";

export interface SessionConfig {
  /** Deterministic seed — same seed + same commands = same session. */
  seed: number;
  /**
   * Ceiling on an answer, in words.
   *
   * Short on purpose, and it is the single most load-bearing number in the game.
   * A long answer is where a real player accidentally proves they saw the prompt
   * (context, clauses, specifics), which makes the Ghost's job trivial. Six words
   * is enough for a joke and not enough for an alibi.
   */
  answerWords: number;
  maxRounds: number;
  /** Milliseconds to write an answer. Server clock, not the engine's. */
  answerTimeoutMs: number;
  /** Milliseconds the room gets to vote on who the Ghost is. */
  voteTimeoutMs: number;
  /** Milliseconds a caught Ghost gets to name the prompt. */
  lastWordTimeoutMs: number;
  /**
   * Fewest answers in before a vote is worth running.
   *
   * With one answer on the board there is nothing to compare, so the round is
   * scored as a wipeout instead of staging a vote nobody can lose.
   */
  minAnswersForVote: number;
}

export const DEFAULT_CONFIG: Omit<SessionConfig, "seed"> = {
  answerWords: 6,
  maxRounds: 20,
  answerTimeoutMs: 60_000,
  voteTimeoutMs: 30_000,
  lastWordTimeoutMs: 20_000,
  minAnswersForVote: 3,
};

export type RoundPhase =
  /** Prompt is out (to everyone but the Ghost). Everyone writes at once. */
  | "ANSWERING"
  /** Answers are on the board, anonymized. The room hunts the Ghost. */
  | "VOTING"
  /** The Ghost was caught and gets one shot at naming the prompt. */
  | "LAST_WORD"
  | "COMPLETE";

/**
 * One answer as the room sees it: text and a slot id, and no author.
 *
 * The owner mapping lives in `slotOwners` on the round, exactly like Say Less
 * keeps `ballotOwners` away from `ballot`. Broadcasting the board is safe by
 * construction; revealing authorship has to be deliberate.
 */
export interface AnswerSlot {
  slotId: string;
  text: string;
}

export interface AnswerRecord {
  playerId: string;
  text: string;
  normalized: string;
  at: number;
}

export interface VoteRecord {
  voterId: string;
  /** The slot the voter believes was written blind. */
  slotId: string;
  at: number;
}

/** What the board shows once the round is scored. Identity drops HERE. */
export interface RoundReveal {
  prompt: string;
  essence: string;
  ghostId: string;
  /** slotId -> playerId. Absent from every projection before this moment. */
  owners: Record<string, string>;
  /** The Ghost's own slot, so the board can point at it. */
  ghostSlotId?: string;
  /** Vote tally per slot, highest first. */
  tally: { slotId: string; playerId: string; votes: number }[];
  caught: boolean;
  /** Who voted correctly. */
  catcherIds: string[];
  /** The innocent player who drew the most suspicion, if anyone did. */
  framedId?: string;
  /** The Ghost's attempt at naming the prompt, when they got one. */
  lastWord?: { text: string; correct: boolean };
}

export interface RoundState {
  index: number;
  ghostId: string;
  card: PromptCard;
  phase: RoundPhase;
  answers: AnswerRecord[];
  /** Anonymized and deterministically shuffled. Present from VOTING onward. */
  slots?: AnswerSlot[];
  /** slotId -> playerId. Engine-side only until the reveal. */
  slotOwners?: Record<string, string>;
  votes: VoteRecord[];
  lastWord?: { text: string; correct: boolean };
  reveal?: RoundReveal;
  endedReason?: "SCORED" | "NO_CONTEST" | "TIMEOUT" | "HOST_ENDED";
}

export interface ScoreEvent {
  roundIndex: number;
  playerId: string;
  reason:
    | "GHOST_SURVIVED"
    | "CAUGHT_GHOST"
    | "GHOST_LAST_WORD"
    | "FRAMED";
  delta: number;
}

export interface SessionState {
  config: SessionConfig;
  players: Player[];
  /** Deterministic Ghost order for the current cycle. */
  rotation: string[];
  rotationCursor: number;
  cycle: number;
  deck: PromptCard[];
  deckCursor: number;
  roundIndex: number;
  round?: RoundState;
  scores: Record<string, number>;
  scoreLog: ScoreEvent[];
  status: "IDLE" | "IN_ROUND" | "COMPLETE";
}

/**
 * Engine events (spec §09 minimum event vocabulary). The engine emits these; the
 * platform wraps them in the room envelope, redacts, and persists.
 *
 * Note what is NOT here: no event carries the prompt text or an author id before
 * `round.revealed`. `answer.submitted` names the player without their text, and
 * `answers.closed` carries the anonymized slots without owners — so an
 * implementation that simply forwards the event stream still cannot leak.
 */
export type EngineEvent =
  | { type: "game.started"; playerIds: string[]; seed: number }
  | { type: "round.started"; roundIndex: number; cardId: string; category: string }
  | { type: "answer.submitted"; roundIndex: number; playerId: string }
  | { type: "answer.rejected"; roundIndex: number; playerId: string; reason: AnswerRejection; detail: string }
  | { type: "answers.closed"; roundIndex: number; slots: AnswerSlot[] }
  | { type: "vote.submitted"; roundIndex: number; voterId: string }
  | { type: "votes.closed"; roundIndex: number }
  | { type: "ghost.caught"; roundIndex: number }
  | { type: "ghost.survived"; roundIndex: number }
  | { type: "lastword.submitted"; roundIndex: number; text: string; correct: boolean }
  | { type: "round.revealed"; roundIndex: number; reveal: RoundReveal }
  | { type: "round.completed"; roundIndex: number; reason: NonNullable<RoundState["endedReason"]> }
  | { type: "score.updated"; events: ScoreEvent[]; totals: Record<string, number> }
  | { type: "game.completed"; totals: Record<string, number> };
