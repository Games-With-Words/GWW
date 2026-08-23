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
    const t = sayLess.command(state, "guess.submit", { playerId: guesser, value: secret }, 500);
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
