/**
 * The client-side half of the arcade contract.
 *
 * A game ships two things: an engine (pure rules, `@gww/kit` GameModule) and a
 * VIEW (how a phone and a board draw it). The engine can't own the view — it
 * must stay DOM-free and deterministic — and the platform can't own it either,
 * because "what does a round look like" is the most game-specific question there
 * is. So the view is its own small registry, and adding a game to the client is
 * one file plus one line, mirroring `arcade.register(...)` on the server.
 *
 * A view is given helpers rather than importing them, for one concrete reason:
 * `command` and `render` are closures over module state in main.ts (the socket,
 * the current room). Passing them in keeps a view a pure function of state and
 * helpers, which is what makes it readable — and testable without a socket.
 */

import type { RoomState } from "../state.js";

export interface ViewHelpers {
  /** Build an element from an HTML string. */
  el(html: string): HTMLElement;
  /** Escape untrusted text for interpolation. Player-authored text is untrusted. */
  esc(s: string): string;
  /** Send a command to the server on the authenticated socket. */
  command(name: string, payload?: Record<string, unknown>): void;
  /** Resolve a player id to a display name. */
  nameOf(s: RoomState, playerId: string | undefined): string;
  /** Is this device the host right now? */
  amHost(s: RoomState): boolean;
  /** The shared scoreboard. */
  scores(s: RoomState): HTMLElement;
}

export interface GameView {
  /** Must match the engine's manifest.gameId. */
  gameId: string;
  /** Shown on the board header and the lobby start button. */
  title: string;

  /**
   * The phone's role pill, e.g. "SPEAKER", "GHOST", "WRITER".
   * Return undefined to use the platform default (BOARD/HOST/GUESSER).
   */
  role?(s: RoomState): string | undefined;

  /**
   * The board's round area — everything between the header and the scoreboard.
   * Return [] and the board shows only the header, clock and caption.
   */
  board(s: RoomState, h: ViewHelpers): HTMLElement[];

  /**
   * The phone's round area during a live round.
   *
   * Return [] to signal "nothing to do here" and let the platform fall through
   * to betweenRounds — which is how a game says the round is over without the
   * platform needing to know its phase names.
   */
  phone(s: RoomState, h: ViewHelpers): HTMLElement[];

  /** The phone's between-rounds screen: the reveal, and the next-round button. */
  betweenRounds(s: RoomState, h: ViewHelpers): HTMLElement[];

  /** The board's between-rounds panel. Defaults to the phone's if absent. */
  boardReveal?(s: RoomState, h: ViewHelpers): HTMLElement[];

  /**
   * The board's lower-third line: HTML for the strip along the bottom.
   *
   * Return undefined to get the platform's standings. Use it for the thing the
   * room is actually wondering about mid-phase — who is still writing, how many
   * votes are in — which is game-specific by nature. Open with
   * `<span class="lt-label">LABEL</span>` to match the broadcast look.
   */
  lowerThird?(s: RoomState, h: ViewHelpers): string | undefined;
}
