/**
 * Ghostwriter as a Games With Words arcade module (@gww/kit GameModule).
 * Game #2. Made by Vex.
 */

import type { Effects, GameManifest, GameModule, ViewContext } from "@gww/kit";
import {
  createSession,
  startRound,
  submitAnswer,
  submitVote,
  submitLastWord,
  closeAnswers,
  closeVotes,
  closeLastWord,
  endRound,
  shuffleRemaining,
  EngineError,
} from "./machine.js";
import { STARTER_DECK } from "./deck.js";
import type { EngineEvent, PromptCard, RoundState, SessionState } from "./types.js";

export const GHOSTWRITER_MANIFEST: GameManifest = {
  gameId: "ghostwriter",
  /**
   * TWO WORDS, deliberately (Mark, 2026-08-25).
   *
   * "GHOSTWRITER" is 11 unbroken characters, and the board's title card is one
   * line of Archivo 900 at 13vw — it rendered as "GHOSTWRI…" on the television.
   * Measured: 1,737px of text into a 710px box. A space is the whole fix, because
   * the marquee can then wrap; "ODD ONE OUT" is the same 11 characters and
   * overflowed by zero.
   *
   * The gameId stays "ghostwriter" — it is a url-safe key that rooms, packs and
   * the registry bind to, and it is never shown to anyone.
   */
  title: "Ghost Writer",
  tagline: "Everyone answers the prompt. One of you never saw it.",
  rulesVersion: "ghostwriter/1",
  credit: {
    maker: "Vex",
    line: "Made by Vex — the inverse of Say Less",
  },
  /**
   * THREE, and this one cannot move (asked and answered, 2026-08-25).
   *
   * Say Less went to 2 the same day; this game mathematically cannot. At two
   * players the vote is Writer and Ghost, neither may vote for their own slot,
   * so each is forced onto the other: a guaranteed 1-1 tie, every round,
   * forever. Ties acquit — so the Ghost could never be caught, which is the
   * entire game. Three is the smallest room where a vote can actually convict.
   */
  minPlayers: 3,
  maxPlayers: 12,
  sessionMinutes: [15, 25],
  categories: ["Family", "Mixed Chaos", "Pop Culture", "Work"],
};

interface AnswerPayload {
  playerId: string;
  text: string;
}
interface VotePayload {
  voterId: string;
  slotId: string;
}
interface LastWordPayload {
  ghostId: string;
  text: string;
}
interface EndPayload {
  reason: "TIMEOUT" | "HOST_ENDED";
}

/**
 * The deck this adapter deals from, defaulting to the hand-authored starter deck
 * so the engine and its tests stay I/O-free. The server calls configureDeck() at
 * boot with starter + forged packs merged.
 *
 * Same split as Say Less: the pure machine still takes its deck as an argument,
 * and only this adapter — which exists solely to satisfy kit's fixed
 * GameModule signature — holds module state.
 */
let activeDeck: PromptCard[] = STARTER_DECK;

/** Install the deck the arcade deals from. Called once, at server boot. */
export function configureDeck(cards: PromptCard[]): void {
  if (cards.length === 0) throw new EngineError("EMPTY_DECK", "Refusing to configure an empty deck.");
  activeDeck = cards;
}

/** How many prompts are currently dealable — for boot logging. */
export function deckSize(): number {
  return activeDeck.length;
}

/**
 * Who is really acting. The platform's injected `actorId` beats any id in the
 * body; the explicit field stays as a fallback so the engine remains directly
 * drivable in tests and replays.
 *
 * This matters more here than in most games: an unchecked `ghostId` in a payload
 * would let any player claim the Ghost's last word, and an unchecked `voterId`
 * would let one phone stuff the vote that decides the round.
 */
function actor(payload: unknown, claimed: string | undefined): string {
  const injected = (payload as { actorId?: unknown }).actorId;
  return typeof injected === "string" && injected !== "" ? injected : (claimed ?? "");
}

export const ghostwriter: GameModule<SessionState, EngineEvent> = {
  manifest: GHOSTWRITER_MANIFEST,

  /** The host owns the round clock. Everything else is a player action. */
  hostOnlyCommands: ["round.start", "round.end", "deck.shuffle"],

  createSession(players, seed) {
    return createSession(players, activeDeck, { seed });
  },

  command(state, name, payload, now) {
    switch (name) {
      case "round.start":
        return startRound(state);
      case "answer.submit": {
        const p = payload as AnswerPayload;
        return submitAnswer(state, actor(payload, p.playerId), p.text, now);
      }
      case "vote.cast": {
        const p = payload as VotePayload;
        return submitVote(state, actor(payload, p.voterId), p.slotId, now);
      }
      case "lastword.submit": {
        const p = payload as LastWordPayload;
        return submitLastWord(state, actor(payload, p.ghostId), p.text, now);
      }
      // Timers, driven by the server clock rather than a player action.
      case "answers.close":
        return closeAnswers(state);
      case "votes.close":
        return closeVotes(state);
      case "lastword.close":
        return closeLastWord(state);
      case "round.end": {
        const p = payload as EndPayload;
        return endRound(state, p.reason);
      }
      // The host can cut the deck between rounds.
      case "deck.shuffle":
        return shuffleRemaining(state);
      default:
        throw new EngineError("UNKNOWN_COMMAND", `Ghostwriter has no command "${name}".`);
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

  narrate(event, nameOf) {
    return narrate(event, nameOf);
  },
};

/* ------------------------------------------------------------------------- *
 * Platform surfaces (kit contract v2).
 * ------------------------------------------------------------------------- */

/**
 * Public projection of a round.
 *
 * The prompt is absent until the round completes, and that is not a
 * belt-and-braces precaution — the Ghost is sitting in the same room as the
 * board. Anything the board shows, the Ghost reads. So the public projection is
 * built for the most exposed viewer in the house, and the prompt travels only on
 * the private channel to the players who are allowed to have it.
 *
 * Notably absent for the same reason: `ghostId`, `slotOwners`, and which slot
 * each vote went to. Who has voted is public (the room needs to know who it is
 * waiting on); what they voted is not, or the last voter would watch the
 * conviction assemble itself before casting.
 */
function publicRound(round: RoundState | undefined) {
  if (round === undefined) return undefined;
  const complete = round.phase === "COMPLETE";
  return {
    index: round.index,
    phase: round.phase,
    category: round.card.category,
    answerCount: round.answers.length,
    // WHO has written is public; WHAT they wrote arrives anonymized at the vote.
    answeredPlayerIds: round.answers.map((a) => a.playerId),
    ...(round.slots !== undefined ? { slots: round.slots } : {}),
    votedPlayerIds: round.votes.map((v) => v.voterId),
    endedReason: round.endedReason,
    ...(round.reveal !== undefined ? { reveal: round.reveal } : {}),
    ...(complete ? { revealLine: round.card.revealLine } : {}),
  };
}

/** Public projection of the whole session — never the deck, never the prompt. */
export function publicState(state: SessionState, _ctx: ViewContext = {}) {
  return {
    status: state.status,
    roundIndex: state.roundIndex,
    maxRounds: state.config.maxRounds,
    answerWords: state.config.answerWords,
    scores: state.scores,
    round: publicRound(state.round),
  };
}

/**
 * The private channel, which in this game is the game.
 *
 * Everyone but the Ghost gets the prompt. The Ghost gets told they ARE the Ghost
 * — that is itself private information, and it has to be delivered, or the one
 * player with the hardest job in the round would have no idea it had started.
 *
 * Both shapes are the same field (`isGhost`) with a different value, so a client
 * renders one panel rather than branching on identity it should not be inferring.
 */
export function privateViews(state: SessionState): Record<string, unknown> {
  const round = state.round;
  if (round === undefined || round.phase === "COMPLETE") return {};
  const out: Record<string, unknown> = {};
  for (const p of state.players) {
    const isGhost = p.id === round.ghostId;
    out[p.id] = {
      roundIndex: round.index,
      isGhost,
      category: round.card.category,
      answerWords: state.config.answerWords,
      // The Ghost's copy carries no prompt at all — not an empty string, not a
      // redacted placeholder. There is nothing on their device to leak.
      ...(isGhost ? {} : { prompt: round.card.prompt }),
    };
  }
  return out;
}

/** Clocks and cues. Each phase names the command its own dead clock should send. */
export function effectsFor(state: SessionState, event: EngineEvent): Effects | undefined {
  const cfg = state.config;
  switch (event.type) {
    case "round.started":
      return { timer: { ms: cfg.answerTimeoutMs, onExpire: "answers.close" }, cue: "round" };
    case "answers.closed":
      return { timer: { ms: cfg.voteTimeoutMs, onExpire: "votes.close" }, cue: "vote" };
    case "ghost.caught":
      return { timer: { ms: cfg.lastWordTimeoutMs, onExpire: "lastword.close" }, cue: "caught" };
    case "ghost.survived":
      return { cue: "survived" };
    case "round.completed":
      return { clearTimer: true };
    case "game.completed":
      return { clearTimer: true, cue: "outro" };
    default:
      return undefined;
  }
}

/**
 * No redactEvent, deliberately.
 *
 * The event vocabulary in types.ts was designed so that nothing needing
 * redaction is ever emitted: `answer.submitted` names the author without the
 * text, `answers.closed` carries slots without owners, `vote.submitted` names
 * the voter without the target. Say Less needs a redactor because its events
 * predate its anonymous ballot; this game got the ordering right the first time,
 * and the absence of the method is the evidence.
 */

/** One narration line per engine event. The prompt stays dark until reveal. */
export function narrate(event: EngineEvent, nameOf: (id: string | undefined) => string): string | undefined {
  switch (event.type) {
    case "game.started":
      return `game.started (${event.playerIds.length} players)`;
    case "round.started":
      return `R${event.roundIndex + 1} started — card ${event.cardId}, category ${event.category} (ghost and prompt withheld from log until reveal)`;
    case "answer.submitted":
      return `R${event.roundIndex + 1} answer in from "${nameOf(event.playerId)}"`;
    case "answer.rejected":
      return `R${event.roundIndex + 1} answer REJECTED for "${nameOf(event.playerId)}" (${event.reason}): ${event.detail}`;
    case "answers.closed":
      return `R${event.roundIndex + 1} answers closed — ${event.slots.length} on the board, voting open`;
    case "vote.submitted":
      return `R${event.roundIndex + 1} vote cast by "${nameOf(event.voterId)}"`;
    case "ghost.caught":
      return `R${event.roundIndex + 1} GHOST CAUGHT — last word open`;
    case "ghost.survived":
      return `R${event.roundIndex + 1} ghost SURVIVED`;
    case "lastword.submitted":
      return `R${event.roundIndex + 1} last word: "${event.text}" — ${event.correct ? "NAILED IT" : "no"}`;
    case "round.revealed":
      return `R${event.roundIndex + 1} revealed — the ghost was "${nameOf(event.reveal.ghostId)}", prompt: "${event.reveal.prompt}"`;
    case "round.completed":
      return `R${event.roundIndex + 1} complete (${event.reason})`;
    case "score.updated":
      return `scores: ${Object.entries(event.totals).map(([id, v]) => `${nameOf(id)}=${v}`).join(" ")}`;
    case "deck.shuffled":
      return `deck shuffled — ${event.remaining} prompt(s) still unplayed`;
    case "game.completed":
      return `GAME COMPLETE — final: ${Object.entries(event.totals).map(([id, v]) => `${nameOf(id)}=${v}`).join(" ")}`;
    default:
      return undefined;
  }
}
