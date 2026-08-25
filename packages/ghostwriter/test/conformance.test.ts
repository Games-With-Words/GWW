import { describe, it, expect } from "vitest";
import { assertConformance, checkConformance } from "@gww/kit";
import { ghostwriter } from "../src/module.js";
import type { SessionState } from "../src/types.js";

const players = [
  { id: "p1", displayName: "Mark" },
  { id: "p2", displayName: "Ris" },
  { id: "p3", displayName: "Sonia" },
  { id: "p4", displayName: "Sam" },
];

const NEUTRAL = ["purple", "Kevin", "a stapler", "Tuesday"];

/**
 * Drive a full round through the platform's eyes: start, everyone answers,
 * everyone votes for the Ghost, the Ghost takes the last word.
 *
 * Written against the state rather than a fixed list because the Ghost is chosen
 * by seed — which is exactly the kind of thing the harness is meant to cope with.
 */
function script(state: unknown, step: number) {
  const s = state as SessionState;
  if (step === 0) return { name: "round.start", payload: {} };

  const round = s.round;
  if (round === undefined) return undefined;

  if (round.phase === "ANSWERING") {
    const next = s.players.find((p) => !round.answers.some((a) => a.playerId === p.id));
    if (next === undefined) return undefined;
    const text = NEUTRAL[s.players.indexOf(next)] ?? `answer ${step}`;
    return { name: "answer.submit", payload: { playerId: next.id, text } };
  }

  if (round.phase === "VOTING") {
    const owners = round.slotOwners ?? {};
    const ghostSlot = Object.keys(owners).find((k) => owners[k] === round.ghostId);
    const voter = s.players.find(
      (p) => p.id !== round.ghostId && !round.votes.some((v) => v.voterId === p.id),
    );
    if (voter !== undefined && ghostSlot !== undefined) {
      return { name: "vote.cast", payload: { voterId: voter.id, slotId: ghostSlot } };
    }
    // The Ghost votes last, for somebody else.
    const other = s.players.find((p) => p.id !== round.ghostId)!;
    const otherSlot = Object.keys(owners).find((k) => owners[k] === other.id)!;
    return { name: "vote.cast", payload: { voterId: round.ghostId, slotId: otherSlot } };
  }

  if (round.phase === "LAST_WORD") {
    return { name: "lastword.submit", payload: { ghostId: round.ghostId, text: round.card.essence } };
  }
  return undefined;
}

/**
 * What must never appear in a public projection or on the wire right now.
 *
 * The prompt and its essence, and only while the round is live — after the reveal
 * they are the whole point of the screen. Note what is NOT listed: the Ghost's
 * player id. Player ids are public (the room can see who has answered); the
 * Ghost is protected by nothing pointing AT them, not by hiding an id that
 * appears in every presence message anyway.
 */
function secrets(state: unknown): string[] {
  const s = state as SessionState;
  const round = s.round;
  if (round === undefined || round.phase === "COMPLETE") return [];
  return [round.card.prompt, round.card.essence];
}

describe("kit conformance", () => {
  it("passes the platform's house rules", () => {
    assertConformance(ghostwriter, { players, seed: 42, next: script, secrets });
  });

  it("passes on several seeds — the Ghost is a different player each time", () => {
    for (const seed of [1, 7, 42, 99, 1234]) {
      const r = checkConformance(ghostwriter, { players, seed, next: script, secrets });
      expect(r.failures).toEqual([]);
      expect(r.steps).toBeGreaterThan(4);
    }
  });

  it("would CATCH a leak if the projection stopped redacting", () => {
    // Proof the harness can fail, not just pass: a projection that hands over
    // the whole state must be reported. A leak test that has never failed is a
    // leak test nobody should trust.
    const leaky = { ...ghostwriter, project: (s: unknown) => s };
    const r = checkConformance(leaky, { players, seed: 42, next: script, secrets });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/leaks a private value/);
  });

  it("would CATCH a timer whose expiry command does not exist", () => {
    const typo = {
      ...ghostwriter,
      effects: () => ({ timer: { ms: 1000, onExpire: "answers.clsoe" } }),
    };
    const r = checkConformance(typo, { players, seed: 42, next: script, secrets });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/would hang/);
  });

  it("would CATCH non-determinism", () => {
    const flaky = {
      ...ghostwriter,
      createSession: (p: { id: string; displayName: string }[], seed: number) =>
        ghostwriter.createSession(p, seed + Math.floor(Math.random() * 1000)),
    };
    const r = checkConformance(flaky, { players, seed: 42, next: script, secrets });
    expect(r.ok).toBe(false);
    expect(r.failures.join(" ")).toMatch(/not deterministic/);
  });
});
