/**
 * Live smoke: a real Ghostwriter round over real HTTP + WebSockets.
 *
 * Not a unit test. This boots the actual gateway, joins four phones and a board,
 * and plays a round end to end — the only way to know the multi-game runner works
 * outside the test harness that was written by the same hand as the code.
 */
import { createGateway } from "./dist/gateway.js";
import { WebSocket } from "ws";

const gw = createGateway({});
const port = await gw.listen(0);
const base = `http://127.0.0.1:${port}`;
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("  ok —", m);

const post = async (p, b) => (await fetch(base + p, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b),
})).json();

// ---- the shelf ------------------------------------------------------------
const { games } = await (await fetch(`${base}/api/games`)).json();
console.log("\nARCADE:", games.map((g) => `${g.title} (${g.credit.maker}, ${g.minPlayers}-${g.maxPlayers}p)`).join(" · "));
if (!games.some((g) => g.gameId === "ghostwriter")) fail("ghostwriter not on the shelf");
if (!games.some((g) => g.gameId === "say-less")) fail("say-less fell off the shelf");

// ---- a ghostwriter room --------------------------------------------------
const room = await post("/api/rooms", { gameId: "ghostwriter" });
console.log(`\nROOM ${room.shortCode} game=${room.gameId}`);

function open(url, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const c = { label, ws, msgs: [], private: [], states: [] };
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      c.msgs.push(m);
      if (m.type === "secret") c.private.push(m.data);
      if (m.type === "state") c.states.push(m.data);
      if (m.type === "error") console.log(`  [${label}] error:`, m.message);
    });
    ws.on("open", () => setTimeout(() => resolve(c), 120));
  });
}

const board = await open(`ws://127.0.0.1:${port}/ws?room=${room.roomId}&board=${room.boardToken}`, "board");

const phones = [];
for (const name of ["Mark", "Ris", "Sonia", "Sam"]) {
  const j = await post(`/api/rooms/${room.shortCode}/join`, { displayName: name, joinToken: room.joinToken });
  const c = await open(`ws://127.0.0.1:${port}/ws?room=${room.roomId}&token=${j.playerToken}`, name);
  c.playerId = j.playerId;
  phones.push(c);
}
ok(`4 phones + 1 board connected`);

// The board's title card reads the game id from this hello. It said SAY LESS on a
// Ghostwriter room in live play, so the input the fix depends on gets asserted.
const boardHello = board.msgs.find((m) => m.type === "hello");
if (boardHello?.data?.gameId !== "ghostwriter") {
  fail(`board hello carries gameId=${JSON.stringify(boardHello?.data?.gameId)} — the marquee would be wrong`);
} else {
  ok(`board hello names the game (${boardHello.data.gameId}) — marquee reads the room, not a literal`);
}

// ---- start from the board (the one gesture it is allowed) -----------------
board.ws.send(JSON.stringify({ type: "game.start", seed: 4242 }));
await new Promise((r) => setTimeout(r, 400));

// ---- the private channel is the game ------------------------------------
const withPrompt = phones.filter((p) => p.private.at(-1)?.prompt !== undefined);
const ghosts = phones.filter((p) => p.private.at(-1)?.isGhost === true);
console.log(`\nPRIVATE: ${withPrompt.length} phones got the prompt, ${ghosts.length} got the blindfold`);
if (ghosts.length !== 1) fail(`expected exactly 1 ghost, got ${ghosts.length}`);
if (withPrompt.length !== 3) fail(`expected 3 phones with the prompt, got ${withPrompt.length}`);
const ghost = ghosts[0];
if (ghost.private.at(-1).prompt !== undefined) fail("the GHOST received the prompt — release blocker");
const prompt = withPrompt[0].private.at(-1).prompt;
console.log(`  prompt: "${prompt}"`);
console.log(`  ghost:  ${ghost.label} (told: ${JSON.stringify(ghost.private.at(-1))})`);
ok("exactly one blindfold, and it carries no prompt");

// ---- the board must never see the prompt --------------------------------
const boardText = JSON.stringify(board.msgs);
if (boardText.includes(prompt)) fail("THE BOARD SHOWED THE PROMPT — the ghost can read the TV");
ok("board never received the prompt");

// ---- everyone answers ---------------------------------------------------
const answers = { Mark: "wet socks", Ris: "my uncle Gary", Sonia: "a haunted Toyota", Sam: "Tuesday" };
for (const p of phones) {
  p.ws.send(JSON.stringify({ type: "command", name: "answer.submit", payload: { text: answers[p.label] } }));
  await new Promise((r) => setTimeout(r, 90));
}
const phase = () => phones[0].states.at(-1)?.round?.phase;
console.log(`\nphase after answers: ${phase()}`);
if (phase() !== "VOTING") fail(`expected VOTING, got ${phase()}`);
const slots = phones[0].states.at(-1).round.slots;
console.log("  board slots:", slots.map((s) => `${s.slotId}="${s.text}"`).join(" "));
if (JSON.stringify(slots).match(/p_|player/)) fail("slots carry authorship");
ok("answers anonymized into slots, no authorship on the wire");

// ---- everyone votes for the ghost ---------------------------------------
const ghostAnswer = answers[ghost.label];
const ghostSlot = slots.find((s) => s.text === ghostAnswer);
for (const p of phones) {
  const target = p === ghost ? slots.find((s) => s.text !== ghostAnswer) : ghostSlot;
  p.ws.send(JSON.stringify({ type: "command", name: "vote.cast", payload: { slotId: target.slotId } }));
  await new Promise((r) => setTimeout(r, 90));
}
console.log(`\nphase after votes: ${phase()}`);
if (phase() !== "LAST_WORD") fail(`a unanimous room should catch the ghost; phase=${phase()}`);
ok("ghost caught, last word opened");

// ---- the ghost names the prompt blind ------------------------------------
ghost.ws.send(JSON.stringify({ type: "command", name: "lastword.submit", payload: { text: "something about hotels" } }));
await new Promise((r) => setTimeout(r, 250));

const final = phones[0].states.at(-1);
console.log(`\nphase: ${final.round.phase}  reason: ${final.round.endedReason}`);
const reveal = final.round.reveal;
console.log("REVEAL prompt:", reveal.prompt);
console.log("REVEAL ghost:", reveal.ghostId === ghost.playerId ? `${ghost.label} ✓` : "MISMATCH");
console.log("REVEAL caught:", reveal.caught, "· lastWord:", JSON.stringify(reveal.lastWord));
console.log("SCORES:", JSON.stringify(final.scores));
if (reveal.ghostId !== ghost.playerId) fail("reveal named the wrong ghost");
if (reveal.caught !== true) fail("reveal says the ghost escaped a unanimous vote");
if (reveal.prompt !== prompt) fail("reveal prompt does not match what was delivered");
const catchers = phones.filter((p) => p !== ghost);
let scoresClean = true;
for (const c of catchers) {
  const got = final.scores[c.playerId] ?? 0;
  if (got !== 100) { fail(`${c.label} caught the ghost but scored ${got} — the ghost's cover vote must not pay a bonus`); scoresClean = false; }
}
if ((final.scores[ghost.playerId] ?? 0) !== 0) { fail(`caught ghost scored ${final.scores[ghost.playerId]} on a wrong last word`); scoresClean = false; }
if (scoresClean) ok("reveal is correct and every catcher scored exactly 100");

// ---- and say-less still works under the same runner ---------------------
const slRoom = await post("/api/rooms", { gameId: "say-less" });
const slBoard = await open(`ws://127.0.0.1:${port}/ws?room=${slRoom.roomId}&board=${slRoom.boardToken}`, "sl-board");
const slPhones = [];
for (const name of ["A", "B", "C"]) {
  const j = await post(`/api/rooms/${slRoom.shortCode}/join`, { displayName: name, joinToken: slRoom.joinToken });
  const c = await open(`ws://127.0.0.1:${port}/ws?room=${slRoom.roomId}&token=${j.playerToken}`, name);
  c.playerId = j.playerId;
  slPhones.push(c);
}
slBoard.ws.send(JSON.stringify({ type: "game.start", seed: 99 }));
await new Promise((r) => setTimeout(r, 400));
const speakers = slPhones.filter((p) => p.private.at(-1)?.card !== undefined);
console.log(`\nSAY LESS in the same server: ${speakers.length} speaker holds a card, phase=${slPhones[0].states.at(-1)?.round?.phase}`);
if (speakers.length !== 1) fail(`expected exactly 1 speaker with a card, got ${speakers.length}`);
const secret = speakers[0].private.at(-1).card.secret;
if (JSON.stringify(slBoard.msgs).includes(secret)) fail("the board saw the say-less secret");
ok(`say-less unaffected — one card ("${secret}" withheld from the board)`);

// ---- the floor comes from the manifest ----------------------------------
const tooSmall = await post("/api/rooms", { gameId: "ghostwriter" });
const tsBoard = await open(`ws://127.0.0.1:${port}/ws?room=${tooSmall.roomId}&board=${tooSmall.boardToken}`, "ts-board");
const j1 = await post(`/api/rooms/${tooSmall.shortCode}/join`, { displayName: "Solo", joinToken: tooSmall.joinToken });
await open(`ws://127.0.0.1:${port}/ws?room=${tooSmall.roomId}&token=${j1.playerToken}`, "solo");
const j2 = await post(`/api/rooms/${tooSmall.shortCode}/join`, { displayName: "Duo", joinToken: tooSmall.joinToken });
await open(`ws://127.0.0.1:${port}/ws?room=${tooSmall.roomId}&token=${j2.playerToken}`, "duo");
tsBoard.ws.send(JSON.stringify({ type: "game.start", seed: 1 }));
await new Promise((r) => setTimeout(r, 250));
const refusal = tsBoard.msgs.find((m) => m.type === "error");
console.log("\ntwo-player ghostwriter start:", refusal ? `${refusal.error} — "${refusal.message}"` : "ALLOWED");
if (refusal?.error !== "TOO_FEW_PLAYERS") fail("a 2-player Ghostwriter room was allowed to start");
if (!String(refusal.message).includes("3")) fail("refusal did not cite the game's own minimum");
ok("the minimum table size came from the manifest, not a hardcoded 2");

await gw.close();
console.log(process.exitCode ? "\nSMOKE FAILED" : "\nSMOKE PASSED — one runner, two games, no leaks");
process.exit(process.exitCode ?? 0);
