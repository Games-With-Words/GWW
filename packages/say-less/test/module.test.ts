import { describe, it, expect } from "vitest";
import { createArcade } from "@gww/kit";
import { sayLess, SAY_LESS_MANIFEST } from "../src/module.js";

describe("arcade integration", () => {
  it("registers Say Less with The Oracle's credit on the tile", () => {
    const arcade = createArcade();
    arcade.register(sayLess as never);
    const tiles = arcade.list();
    expect(tiles).toHaveLength(1);
    expect(tiles[0]!.gameId).toBe("say-less");
    expect(tiles[0]!.credit.maker).toBe("The Oracle");
  });

  it("rejects duplicate registration", () => {
    const arcade = createArcade();
    arcade.register(sayLess as never);
    expect(() => arcade.register(sayLess as never)).toThrowError(/already registered/);
  });

  it("drives a round through the generic command surface", () => {
    const players = [
      { id: "a", displayName: "A" },
      { id: "b", displayName: "B" },
      { id: "c", displayName: "C" },
    ];
    let { state } = sayLess.createSession(players, 1234);
    ({ state } = sayLess.command(state, "round.start", {}, 0));
    const sp = state.round!.speakerId;
    ({ state } = sayLess.command(state, "clue.submit", { speakerId: sp, clue: "totally safe generic hint" }, 100));
    const guesser = players.find((p) => p.id !== sp)!.id;
    const secret = state.round!.card.secret;
    let t = sayLess.command(state, "guess.submit", { playerId: guesser, value: secret }, 500);
    // A correct guess no longer ends the round; the last guess does. With 3
    // players the room is under the ballot floor, so it completes right away.
    expect(t.state.round!.phase).toBe("GUESSING");
    const other = players.find((p) => p.id !== sp && p.id !== guesser)!.id;
    t = sayLess.command(t.state, "guess.submit", { playerId: other, value: "nope" }, 600);
    expect(t.state.round!.endedReason).toBe("CORRECT");
    expect(SAY_LESS_MANIFEST.rulesVersion).toBe("say-less/1");
  });

  it("throws a coded error on unknown commands", () => {
    const { state } = sayLess.createSession(
      [
        { id: "a", displayName: "A" },
        { id: "b", displayName: "B" },
      ],
      1,
    );
    expect(() => sayLess.command(state, "nope", {}, 0)).toThrowError(/no command/);
  });
});

// ---- deck injection: the arcade deals from whatever the server configured ----
import { describe as ddesc, expect as dexp, it as dit, afterEach } from "vitest";
import { configureDeck, deckSize, sayLess as mod, STARTER_DECK as STARTER } from "../src/index.js";
import type { Card as DCard } from "../src/index.js";

ddesc("configureDeck", () => {
  afterEach(() => configureDeck(STARTER));

  dit("defaults to the hand-authored starter deck", () => {
    dexp(deckSize()).toBe(STARTER.length);
  });

  dit("deals from an installed deck without touching the pure engine", () => {
    const extra: DCard = {
      id: "sl-gen-test-card", secret: "Test card", aliases: [], category: "Family",
      forbidden: ["one", "two", "three"], budget: 3, difficulty: 2,
    };
    configureDeck([...STARTER, extra]);
    dexp(deckSize()).toBe(STARTER.length + 1);
    const players = [{ id: "a", displayName: "A" }, { id: "b", displayName: "B" }, { id: "c", displayName: "C" }];
    const t = mod.createSession(players, 42);
    dexp(t.state.deck).toHaveLength(STARTER.length + 1);
  });

  dit("refuses an empty deck rather than dealing nothing", () => {
    dexp(() => configureDeck([])).toThrow();
  });
});
