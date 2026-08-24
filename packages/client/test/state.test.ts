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
      data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "AWAITING_CLUE", category: "Movies", guessCount: 0, guessedPlayerIds: [], guesses: [] } },
    });
    expect(roleOf(s)).toBe("SPEAKER");
    const host = reduce(initialRoom("p2", true, "PLAYING"), {
      type: "state",
      data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "GUESSING", category: "Movies", guessCount: 0, guessedPlayerIds: [], guesses: [] } },
    });
    expect(roleOf(host)).toBe("HOST");
  });

  it("clears the secret when a NEW round starts, keeps it within the round", () => {
    let s = seeded();
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "AWAITING_CLUE", category: "Movies", guessCount: 0, guessedPlayerIds: [], guesses: [] } } });
    s = reduce(s, { type: "secret", data: { roundIndex: 0, budget: 5, card: { secret: "Titanic", aliases: [], category: "Movies", forbidden: ["ship"] } } });
    expect(s.secret?.card.secret).toBe("Titanic");

    // Same round, phase change: secret survives.
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "GUESSING", category: "Movies", clue: "big boat sad", guessCount: 0, guessedPlayerIds: [], guesses: [] } } });
    expect(s.secret).toBeDefined();

    // New round index: secret cleared.
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 1, maxRounds: 12, scores: {}, round: { index: 1, speakerId: "p2", budget: 5, phase: "AWAITING_CLUE", category: "Family", guessCount: 0, guessedPlayerIds: [], guesses: [] } } });
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
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p2", budget: 5, phase: "GUESSING", category: "Movies", guessCount: 1, guessedPlayerIds: ["p1"], guesses: [{ playerId: "p1", value: "nope", correct: false }] } } });
    expect(hasGuessed(s)).toBe(true);
  });

  it("keeps the secret through the FIRST state after game start — the live-play bug", () => {
    // Production message order: hello, events, SECRET, then the first state.
    // The old reducer compared round 0 vs undefined, called it a round change,
    // and wiped the secret it had just stored. Speaker saw "Fetching…" forever.
    let s = seeded();
    s = reduce(s, { type: "secret", data: { roundIndex: 0, budget: 5, card: { secret: "Titanic", aliases: [], category: "Movies", forbidden: ["ship"] } } });
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 0, maxRounds: 12, scores: {}, round: { index: 0, speakerId: "p1", budget: 5, phase: "AWAITING_CLUE", category: "Movies", guessCount: 0, guessedPlayerIds: [], guesses: [] } } });
    expect(s.secret?.card.secret).toBe("Titanic");

    // And a secret for round 1 must survive round 1's states but not round 2's.
    s = reduce(s, { type: "secret", data: { roundIndex: 1, budget: 5, card: { secret: "Karaoke", aliases: [], category: "Music", forbidden: ["sing"] } } });
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 1, maxRounds: 12, scores: {}, round: { index: 1, speakerId: "p1", budget: 5, phase: "AWAITING_CLUE", category: "Music", guessCount: 0, guessedPlayerIds: [], guesses: [] } } });
    expect(s.secret?.card.secret).toBe("Karaoke");
    s = reduce(s, { type: "state", data: { status: "IN_ROUND", roundIndex: 2, maxRounds: 12, scores: {}, round: { index: 2, speakerId: "p2", budget: 5, phase: "AWAITING_CLUE", category: "Family", guessCount: 0, guessedPlayerIds: [], guesses: [] } } });
    expect(s.secret).toBeUndefined();
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

// Regression: the board MUST connect with board=, never token= — a dropped
// flag here put a production board in a silent auth-refusal loop (2026-08-23).
import { wsUrl } from "../src/api.js";
import { it as bit, expect as bexpect, describe as bdescribe } from "vitest";

bdescribe("wsUrl credential selection", () => {
  bit("board flag selects the board credential", () => {
    bexpect(wsUrl("games-with-words.com", true, "r1", "tok", true)).toBe(
      "wss://games-with-words.com/ws?room=r1&board=tok",
    );
  });
  bit("players use the token credential", () => {
    bexpect(wsUrl("games-with-words.com", true, "r1", "tok", false)).toBe(
      "wss://games-with-words.com/ws?room=r1&token=tok",
    );
  });
});
