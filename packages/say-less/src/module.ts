/**
 * Say Less as a Games With Words arcade module (@gww/kit GameModule).
 * Game #1. Conceived by Interchained & The Oracle.
 */

import type { Effects, GameManifest, GameModule, ViewContext } from "@gww/kit";
import {
  createSession,
  startRound,
  submitClue,
  submitGuess,
  submitVote,
  closeGuessing,
  closeBallot,
  resolveVote,
  endRound,
  shuffleRemaining,
  EngineError,
} from "./machine.js";
import { STARTER_DECK } from "./deck.js";
import type { Card, EngineEvent, RoundState, SessionState } from "./types.js";

export const SAY_LESS_MANIFEST: GameManifest = {
  gameId: "say-less",
  title: "Say Less",
  tagline: "Make your friends guess the secret using as few words as possible.",
  rulesVersion: "say-less/1",
  credit: {
    maker: "The Oracle",
    line: "Conceived by Interchained & The Oracle",
  },
  /**
   * TWO (Mark, 2026-08-25: "Say Less can be 2+").
   *
   * The engine already allowed it — createSession's floor has always been 2, and
   * closeGuessing skips the community ballot below `minPlayersForBallot` (4),
   * because a ballot needs at least two guesses to be a vote rather than a
   * coronation. The only thing keeping a duo out of a room was THIS NUMBER,
   * which the gateway reads as the lobby floor.
   *
   * At two it is Speaker plus one guesser: write the clue under the word
   * budget, one person guesses, the round scores and the reveal lands. The
   * ballot simply never opens, which is the same small-room path three players
   * already took.
   *
   * Ghost Writer stays at 3 for a rules reason, not a symmetry one — see its
   * manifest.
   */
  minPlayers: 2,
  maxPlayers: 12,
  sessionMinutes: [20, 35],
  categories: ["Family", "Adults", "Pop Culture", "Music", "Movies and TV", "Mixed Chaos"],
};

interface CluePayload {
  speakerId: string;
  clue: string;
}
interface GuessPayload {
  playerId: string;
  value: string;
}
interface VotePayload {
  allow: boolean;
}
interface EndPayload {
  reason: "TIMEOUT" | "HOST_ENDED";
}
interface BallotVotePayload {
  voterId: string;
  category: "FUNNIEST" | "CLOSEST";
  slotId: string;
}

/**
 * The deck this adapter deals from. Defaults to the hand-authored starter deck
 * so the engine and its tests stay self-contained and I/O-free. The server
 * calls configureDeck() at boot with starter + forged packs merged.
 *
 * The pure engine still takes its deck as an argument — only this adapter,
 * which exists to satisfy kit's fixed GameModule signature, holds it.
 */
let activeDeck: Card[] = STARTER_DECK;

/** Install the deck the arcade deals from. Called once, at server boot. */
export function configureDeck(cards: Card[]): void {
  if (cards.length === 0) throw new EngineError("EMPTY_DECK", "Refusing to configure an empty deck.");
  activeDeck = cards;
}

/** How many cards are currently dealable — for boot logging. */
export function deckSize(): number {
  return activeDeck.length;
}

/**
 * Who is really acting.
 *
 * The platform injects `actorId` from the authenticated socket, and it WINS over
 * anything in the body — otherwise one phone could guess as another player by
 * writing their id in a payload. The explicit field remains as the fallback so
 * the engine stays directly drivable in tests and replays.
 */
function actor(payload: unknown, claimed: string | undefined): string {
  const injected = (payload as { actorId?: unknown }).actorId;
  return typeof injected === "string" && injected !== "" ? injected : (claimed ?? "");
}

export const sayLess: GameModule<SessionState, EngineEvent> = {
  manifest: SAY_LESS_MANIFEST,

  /** The host owns the round clock and adjudicates loophole votes (v0.1). */
  hostOnlyCommands: ["round.start", "round.end", "vote.resolve", "deck.shuffle"],

  createSession(players, seed) {
    return createSession(players, activeDeck, { seed });
  },

  command(state, name, payload, now) {
    switch (name) {
      case "round.start":
        return startRound(state);
      case "clue.submit": {
        const p = payload as CluePayload;
        return submitClue(state, actor(payload, p.speakerId), p.clue, now);
      }
      case "guess.submit": {
        const p = payload as GuessPayload;
        return submitGuess(state, actor(payload, p.playerId), p.value, now);
      }
      case "vote.resolve": {
        const p = payload as VotePayload;
        return resolveVote(state, p.allow, now);
      }
      case "ballot.vote": {
        const p = payload as BallotVotePayload;
        return submitVote(state, actor(payload, p.voterId), p.category, p.slotId);
      }
      // Timers, driven by the server clock rather than a player action.
      case "guessing.close":
        return closeGuessing(state);
      case "ballot.close":
        return closeBallot(state);
      case "round.end": {
        const p = payload as EndPayload;
        return endRound(state, p.reason);
      }
      // The host can cut the deck between rounds — see shuffleRemaining().
      case "deck.shuffle":
        return shuffleRemaining(state);
      default:
        throw new EngineError("UNKNOWN_COMMAND", `Say Less has no command "${name}".`);
    }
  },

  project(state, ctx) {
    return publicState(state, ctx);
  },

  privateViews(state) {
    return privateViews(state);
  },

  effects(state, event) {
    return effectsFor(state, event);
  },

  redactEvent(event) {
    return redactEvent(event);
  },

  narrate(event, nameOf) {
    return narrate(event, nameOf);
  },
};

/* ------------------------------------------------------------------------- *
 * Platform surfaces (kit contract v2).
 *
 * Every function below used to live in packages/server/src/session.ts, where it
 * was the reason the server could only run one game. The code is unchanged in
 * substance — this is a move, not a rewrite, and Say Less's existing test suites
 * are the proof of that. What changed is ownership: the knowledge of which field
 * is a secret now sits next to the field.
 * ------------------------------------------------------------------------- */

/** Public projection of a round — no card contents until the round completes. */
function publicRound(round: RoundState | undefined) {
  if (round === undefined) return undefined;
  return {
    index: round.index,
    speakerId: round.speakerId,
    budget: round.budget,
    phase: round.phase,
    category: round.card.category,
    clue: round.clue,
    guessCount: round.guesses.length,
    // WHO has answered is public — the room needs "waiting on two more".
    guessedPlayerIds: round.guesses.map((g) => g.playerId),
    // WHAT they answered is NOT, until the round is over.
    //
    // The guess feed used to broadcast playerId + value live, because wrong
    // guesses are half the comedy (spec §04). That is still true — but the
    // community ballot is anonymous, and a live feed naming every author makes
    // the anonymity pure theatre. The comedy now lands at the reveal, all at
    // once, which is a better beat anyway.
    guesses: round.phase === "COMPLETE"
      ? round.guesses.map((g) => ({ playerId: g.playerId, value: g.value, correct: g.correct }))
      : [],
    winnerId: round.winnerId,
    endedReason: round.endedReason,
    // The ANONYMIZED ballot. ballotOwners is deliberately absent — the owner
    // map never crosses the wire until it arrives inside `reveal`.
    ...(round.ballot !== undefined ? { ballot: round.ballot } : {}),
    votedBy: round.votes.map((v) => ({ voterId: v.voterId, category: v.category })),
    ...(round.reveal !== undefined ? { reveal: round.reveal } : {}),
    // The card's reveal line goes public the moment the round completes.
    ...(round.phase === "COMPLETE" ? { revealLine: round.card.revealLine } : {}),
  };
}

/**
 * Public projection of the whole session — NEVER includes the deck.
 *
 * Identical for every viewer, including the board: Say Less puts nothing
 * viewer-specific in the public state, because the one viewer-specific thing it
 * has (the Speaker's card) travels on the private channel instead. `ctx` is
 * accepted and ignored on purpose — a future variant that shows the Speaker a
 * different board has somewhere to put it.
 */
export function publicState(state: SessionState, _ctx: ViewContext = {}) {
  return {
    status: state.status,
    roundIndex: state.roundIndex,
    maxRounds: state.config.maxRounds,
    scores: state.scores,
    round: publicRound(state.round),
  };
}

/**
 * The Speaker's card, and nobody else's business (spec §04 step 2).
 *
 * Returned for as long as the round is live, rather than pushed once at
 * round.started. The platform delivers only what changed and re-delivers on
 * reconnect, so describing the CURRENT truth here replaced the old
 * resendSecretIfSpeaker special case entirely.
 */
export function privateViews(state: SessionState): Record<string, unknown> {
  const round = state.round;
  if (round === undefined || round.phase === "COMPLETE") return {};
  return {
    [round.speakerId]: {
      roundIndex: round.index,
      card: {
        secret: round.card.secret,
        aliases: round.card.aliases,
        category: round.card.category,
        forbidden: round.card.forbidden,
        revealLine: round.card.revealLine,
      },
      budget: round.budget,
    },
  };
}

/**
 * Clocks and cues.
 *
 * The three clocks are the ones the server used to hold as constructor
 * arguments, now read from the session config so a room can be configured
 * without touching the platform. What an expiring clock MEANS is expressed as
 * the command it sends — which is how the server stopped needing to know that
 * "GUESSING" and "BALLOT" are phases at all.
 */
export function effectsFor(state: SessionState, event: EngineEvent): Effects | undefined {
  const cfg = state.config;
  switch (event.type) {
    case "round.started":
      return { timer: { ms: cfg.clueTimeoutMs, onExpire: "round.end", payload: { reason: "TIMEOUT" } }, cue: "round" };
    case "clue.accepted":
      return { timer: { ms: cfg.guessTimeoutMs, onExpire: "guessing.close" }, cue: "clue" };
    // The ballot gets its own, much shorter clock — a vote is a reflex, not a
    // deliberation, and party games die on dead time.
    case "ballot.opened":
      return { timer: { ms: cfg.ballotTimeoutMs, onExpire: "ballot.close" } };
    case "guess.accepted":
      return { cue: "correct" };
    case "round.completed":
      return { clearTimer: true, ...(event.reason === "TIMEOUT" ? { cue: "timeout" } : {}) };
    case "game.completed":
      return { clearTimer: true, cue: "outro" };
    default:
      return undefined;
  }
}

/**
 * Public projection of an EVENT.
 *
 * The log keeps the full event; the wire gets a redacted one. `guess.submitted`
 * carries playerId AND value, which would hand every device the exact authorship
 * the anonymous ballot exists to hide — a state-level redaction alone is not
 * enough when the event stream says the same thing out loud.
 */
export function redactEvent(event: EngineEvent): unknown {
  if (event.type === "guess.submitted") {
    // Who answered, not what. The text lands at the reveal, all at once.
    return { type: event.type, roundIndex: event.roundIndex, playerId: event.playerId };
  }
  if (event.type === "guess.accepted") {
    // "Somebody got it" would tell the room which ballot slot is correct before
    // they vote on CLOSEST. Withhold until the reveal.
    return { type: event.type, roundIndex: event.roundIndex };
  }
  return event;
}

/** One narration line per engine event. The secret stays dark until reveal. */
export function narrate(event: EngineEvent, nameOf: (id: string | undefined) => string): string | undefined {
  switch (event.type) {
    case "game.started":
      return `game.started (${event.playerIds.length} players)`;
    case "round.started":
      return `R${event.roundIndex + 1} started — speaker "${nameOf(event.speakerId)}", card ${event.cardId}, ${event.budget}-word budget (secret withheld from log until reveal)`;
    case "clue.submitted":
      return `R${event.roundIndex + 1} clue submitted by "${nameOf(event.speakerId)}": "${event.clue}"`;
    case "clue.accepted":
      return `R${event.roundIndex + 1} clue ACCEPTED (${event.wordCount} words) — guessing open`;
    case "clue.rejected":
      return `R${event.roundIndex + 1} clue REJECTED (${event.reason}): ${event.detail}`;
    case "clue.flagged":
      return `R${event.roundIndex + 1} clue FLAGGED — loophole vote: ${event.reason}`;
    case "guess.submitted":
      return `R${event.roundIndex + 1} guess by "${nameOf(event.playerId)}": "${event.value}"`;
    case "guess.accepted":
      return `R${event.roundIndex + 1} CORRECT — "${nameOf(event.playerId)}" got it!`;
    case "round.completed":
      return `R${event.roundIndex + 1} complete (${event.reason}) — the secret was "${event.secret}"${event.winnerId !== undefined ? `, winner "${nameOf(event.winnerId)}"` : ""}`;
    case "score.updated":
      return `scores: ${Object.entries(event.totals).map(([id, v]) => `${nameOf(id)}=${v}`).join(" ")}`;
    case "deck.shuffled":
      return `deck shuffled — ${event.remaining} card(s) still unplayed`;
    case "game.completed":
      return `GAME COMPLETE — final: ${Object.entries(event.totals).map(([id, v]) => `${nameOf(id)}=${v}`).join(" ")}`;
    default:
      return undefined;
  }
}
