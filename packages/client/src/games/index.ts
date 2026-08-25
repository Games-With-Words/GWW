/**
 * The client-side shelf. Adding a game to the UI is one import and one entry.
 *
 * The FALLBACK matters as much as the registry. A client build is a static
 * bundle: the server can be newer than the phone in someone's hand, so a room
 * can legitimately be running a game this bundle has never heard of. The old
 * client would simply have drawn Say Less's UI over it — wrong labels, wrong
 * buttons, silent nonsense. Now an unknown game gets an honest screen that still
 * shows scores, captions and the clock, and says out loud that the app needs a
 * refresh.
 */

import type { RoomState } from "../state.js";
import type { GameView, ViewHelpers } from "./types.js";
import { sayLessView } from "./say-less.js";
import { ghostwriterView } from "./ghostwriter.js";

const VIEWS: GameView[] = [sayLessView, ghostwriterView];

/** The honest screen for a game this build does not know. */
function fallbackView(gameId: string): GameView {
  const notice = (s: RoomState, h: ViewHelpers): HTMLElement[] => {
    void s;
    return [
      h.el(`<div class="card stack">
        <h2>${h.esc(gameId)}</h2>
        <p class="dim">This room is playing a game this app doesn't know yet. Reload to pick up the latest build — the round is still running, and your scores are safe.</p>
      </div>`),
    ];
  };
  return {
    gameId,
    title: gameId,
    board: notice,
    phone: notice,
    betweenRounds: () => [],
  };
}

export function viewFor(gameId: string | undefined): GameView {
  const found = VIEWS.find((v) => v.gameId === gameId);
  return found ?? fallbackView(gameId ?? "unknown");
}

export type { GameView, ViewHelpers } from "./types.js";
