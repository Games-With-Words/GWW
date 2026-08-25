import { describe, it, expect, afterEach } from "vitest";
import { createArcade } from "@gww/kit";
import { ghostwriter, GHOSTWRITER_MANIFEST, configureDeck, deckSize } from "../src/module.js";
import { STARTER_DECK } from "../src/deck.js";
import { EngineError } from "../src/machine.js";
import type { PromptCard, SessionState } from "../src/types.js";

const players = [
  { id: "p1", displayName: "Mark" },
  { id: "p2", displayName: "Ris" },
  { id: "p3", displayName: "Sonia" },
];

afterEach(() => {
  configureDeck(STARTER_DECK);
});

describe("manifest", () => {
  it("satisfies the arcade contract and carries its maker", () => {
    expect(GHOSTWRITER_MANIFEST.gameId).toBe("ghostwriter");
    expect(GHOSTWRITER_MANIFEST.rulesVersion).toBe("ghostwriter/1");
    expect(GHOSTWRITER_MANIFEST.credit.maker).toBe("Vex");
    expect(GHOSTWRITER_MANIFEST.minPlayers).toBeGreaterThanOrEqual(3);
    expect(GHOSTWRITER_MANIFEST.maxPlayers).toBeGreaterThan(GHOSTWRITER_MANIFEST.minPlayers);
  });

  it("registers on the shelf next to other games", () => {
    const arcade = createArcade();
    arcade.register(ghostwriter as never);
    expect(arcade.list().map((m) => m.gameId)).toContain("ghostwriter");
    expect(arcade.get("ghostwriter")).toBeDefined();
    // The registry rejects a duplicate id, which is what keeps tiles unique.
    expect(() => arcade.register(ghostwriter as never)).toThrow();
  });
});

describe("deck configuration", () => {
  it("defaults to the starter deck", () => {
    expect(deckSize()).toBe(STARTER_DECK.length);
  });
  it("refuses an empty deck rather than dealing nothing at boot", () => {
    expect(() => configureDeck([])).toThrow(EngineError);
  });
  it("deals from a configured deck", () => {
    const one: PromptCard[] = [{ ...STARTER_DECK[0]!, id: "only" }];
    configureDeck(one);
    expect(deckSize()).toBe(1);
    const t = ghostwriter.createSession(players, 1) as { state: SessionState };
    const started = ghostwriter.command(t.state, "round.start", {}, 100) as { state: SessionState };
    expect(started.state.round!.card.id).toBe("only");
  });
});

describe("command routing", () => {
  function open() {
    const created = ghostwriter.createSession(players, 42) as { state: SessionState };
    return ghostwriter.command(created.state, "round.start", {}, 100) as { state: SessionState };
  }

  it("routes the whole round through the kit surface", () => {
    let s = open().state;
    const ghostId = s.round!.ghostId;
    const texts = ["purple", "Kevin", "a stapler"];
    players.forEach((p, i) => {
      s = (ghostwriter.command(s, "answer.submit", { playerId: p.id, text: texts[i] }, 200 + i) as { state: SessionState }).state;
    });
    expect(s.round!.phase).toBe("VOTING");

    const owners = s.round!.slotOwners!;
    const slotOf = (pid: string) => Object.keys(owners).find((k) => owners[k] === pid)!;
    for (const p of players) {
      const target = players.find((q) => q.id !== p.id)!;
      s = (ghostwriter.command(s, "vote.cast", { voterId: p.id, slotId: slotOf(target.id) }, 300) as { state: SessionState }).state;
    }
    if (s.round!.phase === "LAST_WORD") {
      s = (ghostwriter.command(s, "lastword.submit", { ghostId, text: s.round!.card.essence }, 400) as { state: SessionState }).state;
    }
    expect(s.round!.phase).toBe("COMPLETE");
    expect(s.round!.reveal!.ghostId).toBe(ghostId);
  });

  it("exposes the server's timer commands", () => {
    const s = open().state;
    // answers.close from ANSWERING is legal; votes.close from ANSWERING is not.
    expect(() => ghostwriter.command(s, "answers.close", {}, 500)).not.toThrow();
    expect(() => ghostwriter.command(s, "votes.close", {}, 500)).toThrow(EngineError);
    expect(() => ghostwriter.command(s, "round.end", { reason: "HOST_ENDED" }, 500)).not.toThrow();
  });

  it("rejects an unknown command by name", () => {
    const s = open().state;
    expect(() => ghostwriter.command(s, "clue.submit", {}, 500)).toThrow(EngineError);
  });

  it("is deterministic through the kit surface for a given seed", () => {
    const a = JSON.stringify((ghostwriter.createSession(players, 9) as { state: SessionState }).state);
    const b = JSON.stringify((ghostwriter.createSession(players, 9) as { state: SessionState }).state);
    expect(a).toBe(b);
  });
});

describe("starter deck content bar", () => {
  it("every card is complete, and no essence is left unmatched by its own text", () => {
    for (const c of STARTER_DECK) {
      expect(c.id).toMatch(/^gw-l0-\d{3}$/);
      expect(c.prompt.length).toBeGreaterThan(10);
      expect(c.essence.length).toBeGreaterThan(2);
      expect(c.telling.length).toBeGreaterThan(0);
      expect(c.category.length).toBeGreaterThan(0);
      expect([1, 2, 3, 4]).toContain(c.difficulty);
    }
  });

  it("has unique ids and unique prompts", () => {
    expect(new Set(STARTER_DECK.map((c) => c.id)).size).toBe(STARTER_DECK.length);
    expect(new Set(STARTER_DECK.map((c) => c.prompt)).size).toBe(STARTER_DECK.length);
  });

  it("declares only categories the manifest offers", () => {
    for (const c of STARTER_DECK) {
      expect(GHOSTWRITER_MANIFEST.categories).toContain(c.category);
    }
  });

  it("has enough cards for a full session at default maxRounds", () => {
    expect(STARTER_DECK.length).toBeGreaterThanOrEqual(12);
  });
});
