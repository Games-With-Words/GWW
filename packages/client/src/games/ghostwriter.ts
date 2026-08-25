/**
 * Ghostwriter — the client view. Game #2, by Vex.
 *
 * The one hard rule this file lives by: THE BOARD NEVER SHOWS THE PROMPT while a
 * round is live. The Ghost is sitting in the same room as the television. Every
 * other client decision here follows from that — the board shows a category, a
 * count and eventually the answers, and the question itself only appears at the
 * reveal, when it belongs to everybody.
 */

import type { RoomState } from "../state.js";
import { amHost as isHost } from "../state.js";
import type { GameView, ViewHelpers } from "./types.js";

/**
 * What this device wrote this round, remembered locally.
 *
 * The server refuses a self-vote, so this is not a security measure — it is so
 * the player's own answer is visibly not-for-voting instead of being a button
 * that errors. Nothing on the wire can tell us which slot is ours (that is the
 * entire point of the anonymized board), so the only honest source is what this
 * device typed. Module-level state survives re-render; it is cleared when the
 * round index moves.
 */
let mine: { roundIndex: number; text: string } | undefined;

function normalizeLoosely(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function isMine(s: RoomState, text: string): boolean {
  const idx = s.game?.round?.index;
  if (mine === undefined || idx === undefined || mine.roundIndex !== idx) return false;
  return normalizeLoosely(mine.text) === normalizeLoosely(text);
}

function haveAnswered(s: RoomState): boolean {
  return (s.game?.round?.answeredPlayerIds ?? []).includes(s.playerId);
}

function haveVoted(s: RoomState): boolean {
  return (s.game?.round?.votedPlayerIds ?? []).includes(s.playerId);
}

/** Who has written, without a word of what — the board's whole job while writing. */
function writtenSoFar(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const round = s.game?.round;
  if (round === undefined) return undefined;
  const done = round.answeredPlayerIds ?? [];
  const total = s.players.length;
  return h.el(`<div class="card"><h2>Written · ${done.length}/${total}</h2><ul class="playerlist">${s.players
    .map((p) => `<li><span class="dot"></span><span class="grow">${h.esc(p.displayName)}</span><span class="dim small">${done.includes(p.id) ? "in" : "writing…"}</span></li>`)
    .join("")}</ul></div>`);
}

/** The anonymized answers, as the board shows them. */
function slotsBoard(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const round = s.game?.round;
  if (round?.slots === undefined) return undefined;
  const cast = round.votedPlayerIds?.length ?? 0;
  return h.el(`<div class="card stack">
    <h2>One of these was written blind — vote on your phone</h2>
    <ul class="ballot">${round.slots
      .map((b) => `<li class="ballotrow"><span class="slot">${h.esc(b.text)}</span></li>`)
      .join("")}</ul>
    <div class="budget">${cast} vote${cast === 1 ? "" : "s"} in · read them out loud first</div>
  </div>`);
}

/** The reveal: the question, the Ghost, the verdict, the last word. */
function revealPanel(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const round = s.game?.round;
  const rev = round?.reveal;
  if (rev === undefined) return undefined;

  const ghostName = h.esc(h.nameOf(s, rev.ghostId));
  /**
   * A NO_CONTEST round is not an escape.
   *
   * Seen in live play (2026-08-25): the Ghost never wrote an answer, the engine
   * correctly scored the round as NO_CONTEST worth nothing to anybody — and this
   * panel announced "ESCAPED — Vex walked out clean", congratulating a no-show
   * for a bluff that never happened. It only looked at `caught`, so "not caught"
   * and "never played" rendered identically.
   *
   * The scoreboard said 0 while the board said well done, and when two things in
   * one screen contradict each other, the contradiction is the bug.
   */
  const noContest = round?.endedReason === "NO_CONTEST";
  const verdict = noContest
    ? `<span class="badge">NO CONTEST</span> ${ghostName} never wrote an answer — nobody scores.`
    : rev.caught === true
      ? `<span class="badge hit">CAUGHT</span> The room got ${ghostName}.`
      : `<span class="badge funny">ESCAPED</span> ${ghostName} walked out clean.`;

  const owners = rev.owners ?? {};
  const rows = (round?.slots ?? []).map((slot) => {
    const owner = owners[slot.slotId];
    const isGhost = slot.slotId === rev.ghostSlotId;
    const votes = (rev.tally ?? []).find((t) => t.slotId === slot.slotId)?.votes ?? 0;
    const badges = [
      isGhost ? `<span class="badge hit">THE GHOST</span>` : "",
      owner !== undefined && owner === rev.framedId ? `<span class="badge funny">FRAMED</span>` : "",
    ].join("");
    return `<li class="${isGhost ? "hit" : "miss"}"><b>${h.esc(h.nameOf(s, owner))}</b> ${h.esc(slot.text)} <span class="dim">(${votes})</span> ${badges}</li>`;
  }).join("");

  const lastWord = rev.lastWord === undefined
    ? ""
    : `<div class="budget">Last word: “${h.esc(rev.lastWord.text)}” — ${rev.lastWord.correct ? "NAMED IT, blind" : "not the question"}</div>`;

  return h.el(`<div class="card reveal stack">
    <div class="small dim">THE QUESTION WAS</div>
    <div class="word">${h.esc(rev.prompt ?? "")}</div>
    ${round?.revealLine !== undefined ? `<div class="dim revealline">“${h.esc(round.revealLine)}”</div>` : ""}
    <div class="dim">${verdict}</div>
    <ul class="guessfeed">${rows}</ul>
    ${lastWord}
  </div>`);
}

export const ghostwriterView: GameView = {
  gameId: "ghostwriter",
  // Two words so the board's marquee can wrap — see the engine manifest.
  title: "Ghost Writer",

  lowerThird(s, h) {
    const round = s.game?.round;
    if (round === undefined) return undefined;
    if (round.phase === "ANSWERING") {
      const done = (round.answeredPlayerIds ?? []).length;
      const waiting = s.players.filter((p) => !(round.answeredPlayerIds ?? []).includes(p.id));
      return `<span class="lt-label">WRITING</span><span>${done} of ${s.players.length} in${
        waiting.length > 0 && waiting.length <= 3 ? ` · waiting on ${h.esc(waiting.map((p) => p.displayName).join(" · "))}` : ""
      }</span>`;
    }
    if (round.phase === "VOTING") {
      const cast = (round.votedPlayerIds ?? []).length;
      return `<span class="lt-label">HUNTING</span><span>${cast} of ${s.players.length} voted · one of these was written blind</span>`;
    }
    if (round.phase === "LAST_WORD") {
      return `<span class="lt-label">LAST WORD</span><span>the Ghost is naming the question they never saw</span>`;
    }
    return undefined;
  },

  role(s) {
    if (s.isBoard) return "BOARD";
    const round = s.game?.round;
    if (round === undefined || round.phase === "COMPLETE") return isHost(s) ? "HOST" : "WRITER";
    // The private view is the ONLY place this device learns it is the Ghost.
    return s.secret?.isGhost === true ? "GHOST" : "WRITER";
  },

  board(s, h) {
    const round = s.game?.round;
    const out: HTMLElement[] = [];
    if (round === undefined || round.phase === "COMPLETE") return out;

    if (round.phase === "ANSWERING") {
      // Category only. The question stays off the television.
      out.push(h.el(`<div class="card reveal stack">
        <div class="small dim">CATEGORY</div>
        <div class="word">${h.esc(round.category ?? "")}</div>
        <div class="dim">The question is on your phones — except for one of you.</div>
      </div>`));
      const written = writtenSoFar(s, h);
      if (written !== undefined) out.push(written);
      return out;
    }

    if (round.phase === "LAST_WORD") {
      out.push(h.el(`<div class="card reveal stack">
        <div class="small dim">CAUGHT</div>
        <div class="word">Last word</div>
        <div class="dim">The Ghost is trying to name the question they never saw.</div>
      </div>`));
      const slots = slotsBoard(s, h);
      if (slots !== undefined) out.push(slots);
      return out;
    }

    const slots = slotsBoard(s, h);
    if (slots !== undefined) out.push(slots);
    return out;
  },

  boardReveal(s, h) {
    const panel = revealPanel(s, h);
    return panel === undefined ? [] : [panel];
  },

  phone(s, h) {
    const round = s.game?.round;
    const out: HTMLElement[] = [];
    if (round === undefined || round.phase === "COMPLETE") return out;
    const priv = s.secret;

    if (round.phase === "ANSWERING") {
      if (priv === undefined) {
        out.push(h.el(`<div class="card">Getting your card…</div>`));
        return out;
      }
      const limit = priv.answerWords ?? 6;

      if (priv.isGhost === true) {
        out.push(h.el(`<div class="card secretcard stack">
          <div class="small dim" style="text-align:center">YOU ARE THE GHOST · ${h.esc(priv.category ?? "")}</div>
          <div class="secretword">No question</div>
          <div class="budget">Everyone else got one. Write an answer that belongs — ${limit} words max.</div>
        </div>`));
      } else {
        out.push(h.el(`<div class="card secretcard stack">
          <div class="small dim" style="text-align:center">THE QUESTION · ${h.esc(priv.category ?? "")} · one of you can't see this</div>
          <div class="secretword">${h.esc(priv.prompt ?? "")}</div>
          <div class="budget">Answer in ${limit} words or fewer. Don't give the question away.</div>
        </div>`));
      }

      if (haveAnswered(s)) {
        out.push(h.el(`<p class="dim" style="text-align:center">Your answer is in. Watch the others sweat.</p>`));
        return out;
      }

      const form = h.el(`<div class="card stack composer">
        <input id="answer" type="text" placeholder="${priv.isGhost === true ? "Bluff. Make it sound obvious." : "Short, funny, not a giveaway."}"
               autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" />
        <div id="count" class="wordcount">0 / ${limit} words</div>
        <button id="send" class="go">Send it</button>
      </div>`);
      const input = form.querySelector("#answer") as HTMLInputElement;
      const count = form.querySelector("#count") as HTMLElement;
      const send = form.querySelector("#send") as HTMLButtonElement;
      const words = (): number => input.value.trim().split(/\s+/).filter((w) => w.length > 0).length;
      const refresh = (): void => {
        const n = words();
        const over = n > limit;
        count.textContent = over ? `${n} / ${limit} words — ${n - limit} over` : `${n} / ${limit} words`;
        count.classList.toggle("over", over);
        send.disabled = over || n === 0;
      };
      const submit = (): void => {
        const text = input.value.trim();
        if (words() === 0 || words() > limit) return;
        // Remember it so the vote screen can mark our own slot.
        mine = { roundIndex: round.index, text };
        h.command("answer.submit", { text });
      };
      input.addEventListener("input", refresh);
      send.addEventListener("click", submit);
      input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
      refresh();
      out.push(form);
      return out;
    }

    if (round.phase === "VOTING") {
      const voted = haveVoted(s);
      const wrap = h.el(`<div class="card stack">
        <h2>Who was writing blind?</h2>
        <p class="dim small">${voted ? "Your vote is in." : "One vote. Nobody can see who wrote what."}</p>
        <ul class="ballot" id="rows"></ul>
      </div>`);
      const rows = wrap.querySelector("#rows")!;
      for (const slot of round.slots ?? []) {
        const own = isMine(s, slot.text);
        rows.append(h.el(`<li class="ballotrow">
          <span class="slot">${h.esc(slot.text)}</span>
          <span class="votebtns">
            ${own
              ? `<span class="dim small">yours</span>`
              : `<button class="vote close" data-slot="${h.esc(slot.slotId)}"${voted ? " disabled" : ""}>🫵</button>`}
          </span>
        </li>`));
      }
      rows.querySelectorAll("button.vote").forEach((btn) => {
        btn.addEventListener("click", () => {
          h.command("vote.cast", { slotId: (btn as HTMLButtonElement).dataset["slot"] });
        });
      });
      out.push(wrap);
      return out;
    }

    if (round.phase === "LAST_WORD") {
      if (priv?.isGhost === true) {
        out.push(h.el(`<div class="card stack">
          <h2>They got you.</h2>
          <p class="dim">One shot: what was the question? Name the subject, not the wording.</p>
        </div>`));
        const form = h.el(`<div class="card stack composer">
          <input id="lastword" type="text" placeholder="It was about…"
                 autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" />
          <button id="send" class="go">Say it</button>
        </div>`);
        const input = form.querySelector("#lastword") as HTMLInputElement;
        const submit = (): void => {
          if (input.value.trim().length > 0) h.command("lastword.submit", { text: input.value.trim() });
        };
        form.querySelector("#send")!.addEventListener("click", submit);
        input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
        out.push(form);
      } else {
        out.push(h.el(`<div class="card"><h2>Caught them.</h2><p class="dim">The Ghost is guessing what the question was. Watch this.</p></div>`));
      }
      return out;
    }

    return out;
  },

  betweenRounds(s, h) {
    const out: HTMLElement[] = [];
    const panel = revealPanel(s, h);
    if (panel !== undefined) out.push(panel);
    return out;
  },
};
