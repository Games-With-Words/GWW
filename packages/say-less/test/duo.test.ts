/**
 * Say Less at TWO (Mark, 2026-08-25: "Say Less can be 2+").
 *
 * The manifest floor moved; this proves the RULES actually hold at two, because
 * a lobby that lets a duo in and then hangs is worse than one that refuses them.
 */

import { describe, expect, it } from "vitest";
import { createSession, startRound, submitClue, submitGuess } from "../src/machine.js";
import { STARTER_DECK } from "../src/deck.js";
import { SAY_LESS_MANIFEST } from "../src/module.js";

const two = () => createSession(
  [{ id: "p1", displayName: "Mark" }, { id: "p2", displayName: "Vex" }],
  STARTER_DECK,
  { seed: 4242 },
).state;

describe("a two-player room", () => {
  it("is what the manifest now advertises", () => {
    expect(SAY_LESS_MANIFEST.minPlayers).toBe(2);
  });

  it("plays a whole round: clue in, guess in, round complete", () => {
    const started = startRound(two()).state;
    const round = started.round!;
    const speaker = round.speakerId;
    const guesser = started.players.find((p) => p.id !== speaker)!.id;

    const clued = submitClue(started, speaker, "totally harmless generic hint", 1_000).state;
    expect(clued.round!.phase).toBe("GUESSING");

    // The one guesser answers — and with a single guess there is nothing to
    // vote on, so the round must COMPLETE rather than sit in an empty ballot.
    const done = submitGuess(clued, guesser, "a wrong answer", 2_000).state;
    expect(done.round!.phase).toBe("COMPLETE");
    expect(done.round!.ballot).toBeUndefined();
  });

  it("still scores, and the secret reaches the reveal", () => {
    const started = startRound(two()).state;
    const speaker = started.round!.speakerId;
    const guesser = started.players.find((p) => p.id !== speaker)!.id;
    const clued = submitClue(started, speaker, "a perfectly safe clue here", 1_000).state;
    const secret = clued.round!.card.secret;

    const done = submitGuess(clued, guesser, secret, 2_000).state;
    expect(done.round!.phase).toBe("COMPLETE");
    expect(done.round!.winnerId).toBe(guesser);
    expect(Object.values(done.scores).some((v) => v > 0)).toBe(true);
  });

  it("refuses ONE player — a room of one is not a game", () => {
    expect(() => createSession([{ id: "p1", displayName: "Mark" }], STARTER_DECK, { seed: 1 }))
      .toThrow(/at least 2/);
  });
});
