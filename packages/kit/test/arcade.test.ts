import { describe, it, expect } from "vitest";
import { createArcade, projectAll, type GameModule } from "../src/index.js";

function fakeGame(gameId: string, maker = "Vex"): GameModule {
  return {
    manifest: {
      gameId,
      title: gameId,
      tagline: "test",
      rulesVersion: `${gameId}/1`,
      credit: { maker },
      minPlayers: 2,
      maxPlayers: 8,
      sessionMinutes: [10, 20],
      categories: ["Test"],
    },
    createSession: () => ({ state: {}, events: [] }),
    command: (state) => ({ state, events: [] }),
    // Contract v2 requires a projection. A stub game has nothing to hide, which
    // is exactly the case projectAll exists for.
    project: projectAll,
  };
}

describe("createArcade", () => {
  it("lists registered games in order with credits", () => {
    const arcade = createArcade();
    arcade.register(fakeGame("say-less", "The Oracle"));
    arcade.register(fakeGame("second-game", "Vex"));
    const tiles = arcade.list();
    expect(tiles.map((t) => t.gameId)).toEqual(["say-less", "second-game"]);
    expect(tiles[0]!.credit.maker).toBe("The Oracle");
  });

  it("rejects duplicate ids", () => {
    const arcade = createArcade();
    arcade.register(fakeGame("dup"));
    expect(() => arcade.register(fakeGame("dup"))).toThrowError(/already registered/);
  });

  it("rejects invalid ids", () => {
    const arcade = createArcade();
    expect(() => arcade.register(fakeGame("Bad_ID!"))).toThrowError(/Invalid gameId/);
  });

  it("refuses a game with no projection — a state the platform cannot redact", () => {
    const arcade = createArcade();
    const noProject = fakeGame("leaky") as { project?: unknown };
    delete noProject.project;
    expect(() => arcade.register(noProject as GameModule)).toThrowError(/has no project\(\)/);
  });

  it("get returns the module or undefined", () => {
    const arcade = createArcade();
    const g = fakeGame("here");
    arcade.register(g);
    expect(arcade.get("here")).toBe(g);
    expect(arcade.get("missing")).toBeUndefined();
  });
});
