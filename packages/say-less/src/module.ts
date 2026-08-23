/**
 * Say Less as a Games With Words arcade module (@gww/kit GameModule).
 * Game #1. Conceived by Interchained & The Oracle.
 */

import type { GameManifest, GameModule } from "@gww/kit";
import {
  createSession,
  startRound,
  submitClue,
  submitGuess,
  resolveVote,
  endRound,
  EngineError,
} from "./machine.js";
import { STARTER_DECK } from "./deck.js";
import type { EngineEvent, SessionState } from "./types.js";

export const SAY_LESS_MANIFEST: GameManifest = {
  gameId: "say-less",
  title: "Say Less",
  tagline: "Make your friends guess the secret using as few words as possible.",
  rulesVersion: "say-less/1",
  credit: {
    maker: "The Oracle",
    line: "Conceived by Interchained & The Oracle",
  },
  minPlayers: 3,
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

export const sayLess: GameModule<SessionState, EngineEvent> = {
  manifest: SAY_LESS_MANIFEST,

  createSession(players, seed) {
    return createSession(players, STARTER_DECK, { seed });
  },

  command(state, name, payload, now) {
    switch (name) {
      case "round.start":
        return startRound(state);
      case "clue.submit": {
        const p = payload as CluePayload;
        return submitClue(state, p.speakerId, p.clue, now);
      }
      case "guess.submit": {
        const p = payload as GuessPayload;
        return submitGuess(state, p.playerId, p.value, now);
      }
      case "vote.resolve": {
        const p = payload as VotePayload;
        return resolveVote(state, p.allow, now);
      }
      case "round.end": {
        const p = payload as EndPayload;
        return endRound(state, p.reason);
      }
      default:
        throw new EngineError("UNKNOWN_COMMAND", `Say Less has no command "${name}".`);
    }
  },
};
