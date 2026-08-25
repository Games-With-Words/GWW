/**
 * Ghostwriter scoring. Centralized so a playtest can retune the whole game in
 * one file — the same discipline Say Less's scoring.ts documents, and for the
 * same reason: these are PROPOSED values, instrumented before they are trusted.
 *
 * The shape of the payout is the actual design, so it is worth stating plainly:
 * a surviving Ghost out-earns any single catcher, but a room that catches the
 * Ghost out-earns the Ghost collectively. One player against the table should be
 * able to win a round; they should not be able to win the game while the table
 * reads them every time.
 */

import { framedPlayer, isCaught, tallyVotes } from "./rules.js";
import type { RoundState, ScoreEvent } from "./types.js";

export const SCORING = {
  /** Walking out of a round nobody solved. The best single payout in the game. */
  GHOST_SURVIVED: 150,
  /** Per voter who pointed at the right slot. */
  CAUGHT_GHOST: 100,
  /**
   * A caught Ghost who still names the subject they never saw.
   *
   * Below CAUGHT_GHOST on purpose: the room was right, and a consolation prize
   * that beats being right would invert the game. But it is large enough to be
   * worth attempting, because "I knew it was about tipping" said out loud after
   * being caught is the loudest moment this game produces.
   */
  GHOST_LAST_WORD: 90,
  /** Innocent, and the room came for you anyway. */
  FRAMED: 40,
} as const;

/**
 * Score a completed round from its own record. Pure; the caller applies.
 *
 * Reads the tally back out of the round rather than taking it as an argument, so
 * the scores can never disagree with the reveal the room just watched.
 */
export function scoreRound(round: RoundState): ScoreEvent[] {
  const events: ScoreEvent[] = [];
  const r = round.index;
  if (round.endedReason === "NO_CONTEST" || round.endedReason === "HOST_ENDED") return events;

  const owners = round.slotOwners ?? {};
  const ghostSlotId = Object.keys(owners).find((slot) => owners[slot] === round.ghostId);
  const tally = tallyVotes(round.votes, owners);
  const caught = isCaught(tally, ghostSlotId);
  /**
   * Conviction counts every vote; FRAMING counts only the room's.
   *
   * The Ghost votes for cover, and that vote must not hand somebody a bonus —
   * see framedPlayer(). Caught in a live run: a catcher walked away with 140.
   */
  const roomTally = tallyVotes(round.votes.filter((v) => v.voterId !== round.ghostId), owners);

  if (caught) {
    for (const v of round.votes) {
      if (v.slotId === ghostSlotId) {
        events.push({ roundIndex: r, playerId: v.voterId, reason: "CAUGHT_GHOST", delta: SCORING.CAUGHT_GHOST });
      }
    }
    if (round.lastWord?.correct === true) {
      events.push({ roundIndex: r, playerId: round.ghostId, reason: "GHOST_LAST_WORD", delta: SCORING.GHOST_LAST_WORD });
    }
  } else {
    events.push({ roundIndex: r, playerId: round.ghostId, reason: "GHOST_SURVIVED", delta: SCORING.GHOST_SURVIVED });
  }

  const framed = framedPlayer(roomTally, ghostSlotId);
  if (framed !== undefined) {
    events.push({ roundIndex: r, playerId: framed, reason: "FRAMED", delta: SCORING.FRAMED });
  }
  return events;
}
