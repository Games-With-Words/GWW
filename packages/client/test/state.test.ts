import { describe, expect, it } from "vitest";
import {
  hasGuessed,
  initialRoom,
  joinUrl,
  nameOf,
  reduce,
  roleOf,
  type RoomState,
} from "../src/state.js";

function seeded(): RoomState {
  let s = initialRoom("p1", false, "GATHERING");
  s = reduce(s, {
    type: "presence",
    data: {
      state: "PLAYING",
      players: [
        { id: "p1", displayName: "Ris", isHost: false, connected: true },
        { id: "p2", displayName: "Mark", isHost: true, connected: true },
      ],
    },
  });
  return s;
}

describe("client state reducer", () => {
  it("projects presence and names", () => {
    const s = seeded();
    expect(s.players).toHaveLength(2);
    expect(nameOf(s, "p2")).toBe("Mark");
    expect(nameOf(s, "ghost")).toBe("?");
  });

  it("role follows the active round's speaker, host otherwise", () => {
    let s = seeded();
    expect(roleOf(s)).toBe("GUESSER");
    s = reduce(s, {
      type: "state",
      data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "AWAITING_CLUE", category: "Movies", guessCount: 0, guessedPlayerIds: [] } },
    });
    expect(roleOf(s)).toBe("SPEAKER");
    const host = reduce(initialRoom("p2", true, "PLAYING"), {
      type: "state",
      data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "GUESSING", category: "Movies", guessCount: 0, guessedPlayerIds: [] } },
    });
    expect(roleOf(host)).toBe("HOST");
  });

  it("clears the secret when a NEW round starts, keeps it within the round", () => {
    let s = seeded();
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "AWAITING_CLUE", category: "Movies", guessCount: 0, guessedPlayerIds: [] } } });
    s = reduce(s, { type: "secret", data: { roundIndex: 0, budget: 5, card: { secret: "Titanic", aliases: [], category: "Movies", forbidden: ["ship"] } } });
    expect(s.secret?.card.secret).toBe("Titanic");

    // Same round, phase change: secret survives.
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "GUESSING", category: "Movies", clue: "big boat sad", guessCount: 0, guessedPlayerIds: [] } } });
    expect(s.secret).toBeDefined();

    // New round index: secret cleared.
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 1, maxRounds: 12, scores: {}, round: { index: 1, speakerId: "p2", budget: 5, phase: "AWAITING_CLUE", category: "Family", guessCount: 0, guessedPlayerIds: [] } } });
    expect(s.secret).toBeUndefined();
  });

  it("captures reveals and captions from events", () => {
    let s = seeded();
    s = reduce(s, { type: "event", data: { type: "clue.accepted", roundIndex: 0, clue: "big boat sad", wordCount: 3 } });
    expect(s.caption).toContain("big boat sad");
    s = reduce(s, { type: "event", data: { type: "round.completed", roundIndex: 0, reason: "CORRECT", winnerId: "p2", secret: "Titanic" } });
    expect(s.lastReveal?.secret).toBe("Titanic");
    expect(s.lastReveal?.winnerId).toBe("p2");
  });

  it("tracks whether this device already guessed", () => {
    let s = seeded();
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p2", budget: 5, phase: "GUESSING", category: "Movies", guessCount: 1, guessedPlayerIds: ["p1"] } } });
    expect(hasGuessed(s)).toBe(true);
  });

  it("surfaces server errors", () => {
    const s = reduce(seeded(), { type: "error", error: "NOT_SPEAKER", message: "Only the Speaker may submit a clue." });
    expect(s.error).toContain("Speaker");
  });

  it("builds the QR join url", () => {
    expect(joinUrl("https://games-with-words.com", "ABC234", "tok_x")).toBe(
      "https://games-with-words.com/#/join/ABC234/tok_x",
    );
  });
});
