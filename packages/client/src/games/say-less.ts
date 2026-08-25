/**
 * Say Less — the client view. Game #1, by The Oracle.
 *
 * Every function here came out of main.ts unchanged in substance during the
 * multi-game split (2026-08-24). The UI invariants asserted by
 * test/ballot.test.ts and test/mobile.test.ts are asserted against THIS file
 * now — the assertions themselves were not touched, only the path they read.
 */

import type { RoomState } from "../state.js";
import { amHost as isHost, hasGuessed, roleOf } from "../state.js";
import type { GameView, ViewHelpers } from "./types.js";

/**
 * Who has answered, without saying WHAT — the tension without the spoiler.
 * Shown while guessing; the words themselves land at the reveal.
 */
function answeredSoFar(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const round = s.game?.round;
  if (round === undefined || round.phase !== "GUESSING") return undefined;
  const total = s.players.length - 1;
  const done = round.guessedPlayerIds ?? [];
  if (done.length === 0) return undefined;
  return h.el(`<div class="card"><h2>Locked in · ${done.length}/${total}</h2><ul class="playerlist">${done
    .map((id) => `<li><span class="dot"></span><span class="grow">${h.esc(h.nameOf(s, id))}</span><span class="dim small">answered</span></li>`)
    .join("")}</ul></div>`);
}

/** The anonymous ballot as the BOARD shows it — big, unattributed. */
function ballotBoard(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const round = s.game?.round;
  if (round?.ballot === undefined || round.phase !== "BALLOT") return undefined;
  const cast = round.votedBy?.length ?? 0;
  return h.el(`<div class="card stack">
    <h2>The guesses — vote on your phone</h2>
    <ul class="ballot">${round.ballot
      .map((b) => `<li class="ballotrow"><span class="slot">${h.esc(b.text)}</span></li>`)
      .join("")}</ul>
    <div class="budget">${cast} vote${cast === 1 ? "" : "s"} in · nobody knows who wrote what</div>
  </div>`);
}

/** The reveal: who wrote what, who was right, who the room picked. */
function revealPanel(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const round = s.game?.round;
  const rev = round?.reveal;
  if (rev === undefined) return undefined;
  const funniest = rev.funniest ?? [];
  const closest = rev.closest ?? [];
  const winners = (list: { slotId: string; playerId: string; votes: number }[]): string =>
    list.length === 0
      ? `<span class="dim">no votes</span>`
      : list.map((w) => `${h.esc(h.nameOf(s, w.playerId))} <span class="dim">(${w.votes})</span>`).join(" &amp; ");
  const rows = (round?.guesses ?? []).map((g) => {
    const funny = funniest.some((w) => w.playerId === g.playerId);
    const close = closest.some((w) => w.playerId === g.playerId);
    const badges = [g.correct ? `<span class="badge hit">CORRECT</span>` : "",
      funny ? `<span class="badge funny">FUNNIEST</span>` : "",
      close ? `<span class="badge close">CLOSEST</span>` : ""].join("");
    return `<li class="${g.correct ? "hit" : "miss"}"><b>${h.esc(h.nameOf(s, g.playerId))}</b> ${h.esc(g.value)} ${badges}</li>`;
  }).join("");
  return h.el(`<div class="card stack">
    <h2>The reveal</h2>
    <ul class="guessfeed">${rows}</ul>
    <div class="budget">Funniest: ${winners(funniest)} · Closest: ${winners(closest)}</div>
  </div>`);
}

/**
 * The phone ballot: every guess, two buttons each.
 *
 * Own guess is disabled — the server rejects a self-vote anyway, but a button
 * that errors is worse than one that is visibly not for you. A cast vote greys
 * its whole category so you can see what you already did.
 */
function ballotPhone(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const round = s.game?.round;
  if (round?.ballot === undefined || round.phase !== "BALLOT") return undefined;

  const isSpeaker = round.speakerId === s.playerId;
  const myGuess = (round.guessedPlayerIds ?? []).includes(s.playerId);
  const castF = round.votedBy?.some((v) => v.voterId === s.playerId && v.category === "FUNNIEST") === true;
  const castC = round.votedBy?.some((v) => v.voterId === s.playerId && v.category === "CLOSEST") === true;

  const wrap = h.el(`<div class="card stack">
    <h2>Vote</h2>
    <p class="dim small">Nobody can see who wrote what. ${isSpeaker
      ? "You know the answer, so you only pick the funniest."
      : "Pick the funniest and the closest."}</p>
    <ul class="ballot" id="rows"></ul>
  </div>`);
  const rows = wrap.querySelector("#rows")!;

  for (const b of round.ballot) {
    // We cannot know which slot is ours from the ballot alone — by design.
    // The server refuses a self-vote; this is belt-and-braces for the case
    // where a player has a guess in play at all.
    const row = h.el(`<li class="ballotrow">
      <span class="slot">${h.esc(b.text)}</span>
      <span class="votebtns">
        <button class="vote funny" data-cat="FUNNIEST" data-slot="${h.esc(b.slotId)}"${castF ? " disabled" : ""}>😂</button>
        ${isSpeaker ? "" : `<button class="vote close" data-cat="CLOSEST" data-slot="${h.esc(b.slotId)}"${castC ? " disabled" : ""}>🎯</button>`}
      </span>
    </li>`);
    rows.append(row);
  }
  rows.querySelectorAll("button.vote").forEach((btn) => {
    btn.addEventListener("click", () => {
      const el2 = btn as HTMLButtonElement;
      h.command("ballot.vote", { category: el2.dataset["cat"], slotId: el2.dataset["slot"] });
    });
  });

  const need = [castF ? "" : "funniest", isSpeaker || castC ? "" : "closest"].filter(Boolean);
  wrap.append(h.el(`<div class="budget">${need.length === 0
    ? "Votes in. Waiting on the room…"
    : `Still to pick: ${need.join(" and ")}`}</div>`));
  void myGuess;
  return wrap;
}

function guessFeed(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const guesses = s.game?.round?.guesses ?? [];
  if (guesses.length === 0) return undefined;
  return h.el(`<div class="card"><h2>Guesses</h2><ul class="guessfeed">${guesses
    .map((g) => `<li class="${g.correct ? "hit" : "miss"}"><b>${h.esc(h.nameOf(s, g.playerId))}</b> ${h.esc(g.value)} ${g.correct ? "✓" : "✗"}</li>`)
    .join("")}</ul></div>`);
}

/** The board's "THE ANSWER WAS" card. */
function answerCard(s: RoomState, h: ViewHelpers): HTMLElement | undefined {
  const r = s.lastReveal;
  if (r === undefined) return undefined;
  const round = s.game?.round;
  return h.el(`<div class="card reveal stack">
    <div class="small dim">THE ANSWER WAS</div>
    <div class="word">${h.esc(r.secret ?? "")}</div>
    ${round?.revealLine !== undefined ? `<div class="dim revealline">“${h.esc(round.revealLine)}”</div>` : ""}
    <div class="dim">${r.winnerId !== undefined ? `${h.esc(h.nameOf(s, r.winnerId))} got it!` : r.reason === "TIMEOUT" ? "Nobody got it." : "Round scrapped."}</div>
  </div>`);
}

export const sayLessView: GameView = {
  gameId: "say-less",
  title: "Say Less",

  role(s) {
    return roleOf(s);
  },

  board(s, h) {
    const round = s.game?.round;
    const out: HTMLElement[] = [];
    if (round === undefined || round.phase === "COMPLETE") return out;

    if (round.phase === "AWAITING_CLUE") {
      out.push(h.el(`<div class="card reveal"><h2>${h.esc(h.nameOf(s, round.speakerId))} is composing a clue…</h2><p class="dim">Category: ${h.esc(round.category ?? "")} · up to ${round.budget ?? 0} words</p></div>`));
    } else {
      out.push(h.el(`<div class="card"><div class="cluebox">“${h.esc(round.clue ?? "")}”</div><div class="budget">— ${h.esc(h.nameOf(s, round.speakerId))}${round.phase === "VOTING" ? " · LOOPHOLE VOTE IN PROGRESS" : ""}</div></div>`));
      const bb = ballotBoard(s, h);
      if (bb !== undefined) out.push(bb);
      const answered = answeredSoFar(s, h);
      if (answered !== undefined) out.push(answered);
    }
    const feed = guessFeed(s, h);
    if (feed !== undefined) out.push(feed);
    return out;
  },

  boardReveal(s, h) {
    const card = answerCard(s, h);
    return card === undefined ? [] : [card];
  },

  phone(s, h) {
    const round = s.game?.round;
    const out: HTMLElement[] = [];
    if (round === undefined || round.phase === "COMPLETE") return out;
    const role = roleOf(s);

    // The ballot replaces the guessing UI entirely — one job per screen.
    const phoneBallot = ballotPhone(s, h);
    if (phoneBallot !== undefined) {
      out.push(h.el(`<div class="card"><div class="cluebox">“${h.esc(round.clue ?? "")}”</div><div class="budget">by ${h.esc(h.nameOf(s, round.speakerId))}</div></div>`));
      out.push(phoneBallot);
      return out;
    }

    // Speaker: the secret card lives here and only here.
    if (role === "SPEAKER") {
      const c = s.secret;
      if (c?.card !== undefined) {
        out.push(h.el(`<div class="card secretcard stack">
          <div class="small dim" style="text-align:center">YOUR SECRET · ${h.esc(c.card.category)} · don't say the red words</div>
          <div class="secretword">${h.esc(c.card.secret)}</div>
          <div class="forbidden">${c.card.forbidden.map((f) => `<span>${h.esc(f)}</span>`).join("")}</div>
          <div class="budget">Make them say it — up to ${c.budget ?? round.budget ?? 0} words</div>
        </div>`));
      } else {
        out.push(h.el(`<div class="card">Fetching your secret…</div>`));
      }
      if (round.phase === "AWAITING_CLUE") {
        // A textarea, not an input: the budget now runs to 20 words, and a
        // sentence that long scrolls out of sight in a single-line field on a
        // phone. You cannot edit what you cannot read.
        const budget = round.budget ?? 0;
        const form = h.el(`<div class="card stack composer">
          <textarea id="clue" rows="3" placeholder="Write the clue that makes them say it…"
                 autocomplete="off" autocorrect="on" spellcheck="false" enterkeyhint="send"></textarea>
          <div id="count" class="wordcount">0 / ${budget} words</div>
          <button id="send">Send clue to the room</button>
        </div>`);
        const input = form.querySelector("#clue") as HTMLTextAreaElement;
        const count = form.querySelector("#count") as HTMLElement;
        const send = form.querySelector("#send") as HTMLButtonElement;
        // The budget is a CEILING, never a quota — a three-word clue that lands is
        // a perfectly good round. So the counter only ever objects to going OVER,
        // and never nags you toward spending the rest of it.
        const words = (): number => input.value.trim().split(/\s+/).filter((w) => w.length > 0).length;
        const refresh = (): void => {
          const n = words();
          const over = n > budget;
          count.textContent = over
            ? `${n} / ${budget} words — ${n - budget} over`
            : `${n} / ${budget} words`;
          count.classList.toggle("over", over);
          send.disabled = over || n === 0;
        };
        const submit = (): void => {
          if (words() > 0 && words() <= budget) h.command("clue.submit", { clue: input.value.trim() });
        };
        input.addEventListener("input", refresh);
        send.addEventListener("click", submit);
        // Enter sends; Shift+Enter is a real newline, since this is prose now.
        input.addEventListener("keydown", (e) => {
          const ev = e as KeyboardEvent;
          if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); submit(); }
        });
        refresh();
        out.push(form);
      } else if (round.phase === "GUESSING") {
        out.push(h.el(`<div class="card"><div class="cluebox">“${h.esc(round.clue ?? "")}”</div><div class="budget">Clue is out — watch them squirm.</div></div>`));
        const feed = guessFeed(s, h);
        if (feed !== undefined) out.push(feed);
      }
    }

    // Everyone else: the clue and the one-shot guess.
    if (role !== "SPEAKER") {
      if (round.phase === "AWAITING_CLUE") {
        out.push(h.el(`<div class="card"><h2>${h.esc(h.nameOf(s, round.speakerId))} is thinking…</h2><p class="dim">Category: ${h.esc(round.category ?? "")} · up to ${round.budget ?? 0} words. Get ready.</p></div>`));
      }
      if (round.phase === "GUESSING") {
        out.push(h.el(`<div class="card"><div class="cluebox">“${h.esc(round.clue ?? "")}”</div><div class="budget">by ${h.esc(h.nameOf(s, round.speakerId))} · what's the secret?</div></div>`));
        if (hasGuessed(s)) {
          out.push(h.el(`<p class="dim" style="text-align:center">Your one guess is in. Sweat it out.</p>`));
        } else {
          const form = h.el(`<div class="card stack composer">
            <input id="guess" type="text" placeholder="One guess. Make it count."
                   autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="send" />
            <button id="send" class="go">Guess!</button>
          </div>`);
          const input = form.querySelector("#guess") as HTMLInputElement;
          const submit = (): void => { if (input.value.trim().length > 0) h.command("guess.submit", { value: input.value.trim() }); };
          form.querySelector("#send")!.addEventListener("click", submit);
          input.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") submit(); });
          out.push(form);
        }
        const feed = guessFeed(s, h);
        if (feed !== undefined) out.push(feed);
      }
    }

    if (round.phase === "VOTING") {
      out.push(h.el(`<div class="card"><h2>Loophole vote</h2><p class="dim">${h.esc(s.flagged?.reason ?? "That clue looks suspicious.")} Argue it out loud!</p></div>`));
      if (isHost(s)) {
        const row = h.el(`<div class="row"><button class="go" id="allow">Allow it</button><button class="danger" id="reject">Reject it</button></div>`);
        row.querySelector("#allow")!.addEventListener("click", () => h.command("vote.resolve", { allow: true }));
        row.querySelector("#reject")!.addEventListener("click", () => h.command("vote.resolve", { allow: false }));
        out.push(row);
      } else {
        out.push(h.el(`<p class="dim" style="text-align:center">The host taps the room's verdict.</p>`));
      }
    }

    if (isHost(s) && round.phase !== "VOTING") {
      const end = h.el(`<button class="secondary">End round (host)</button>`);
      end.addEventListener("click", () => h.command("round.end"));
      out.push(end);
    }
    return out;
  },

  betweenRounds(s, h) {
    const out: HTMLElement[] = [];
    const card = answerCard(s, h);
    if (card !== undefined) out.push(card);
    // Who wrote what, who was right, who the room crowned. The comedy that used
    // to dribble out during guessing now lands here, all at once.
    const reveal = revealPanel(s, h);
    if (reveal !== undefined) out.push(reveal);
    return out;
  },
};
