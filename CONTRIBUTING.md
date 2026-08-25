# Make a game for the arcade

Games With Words is a **community of games**. Every game is made by a person,
and the arcade tile carries your credit forever. Fork this repo, build your
game, open a PR. That's the whole pipeline.

## What a game is

A game is one package in `packages/` implementing the `@gww/kit` `GameModule`
contract: a **pure, deterministic, event-sourced engine**. No I/O, no clocks,
no network — the platform owns lobbies, sockets, timers, persistence, and
voice. You own rules and fun.

```ts
import type { GameModule, GameManifest } from "@gww/kit";

export const MY_MANIFEST: GameManifest = {
  gameId: "my-game",            // lowercase, url-safe, unique
  title: "My Game",
  tagline: "One line that sells the fun.",
  rulesVersion: "my-game/1",
  credit: { maker: "YourName", line: "Conceived by YourName" },
  minPlayers: 3,
  maxPlayers: 12,
  sessionMinutes: [15, 30],
  categories: ["Mixed Chaos"],
};

export const myGame: GameModule<MyState, MyEvent> = {
  manifest: MY_MANIFEST,
  createSession(players, seed) { /* same seed + players = same session */ },
  command(state, name, payload, now) { /* pure transition -> { state, events } */ },
  project(state, ctx) { /* what THIS viewer may see */ },
};
```

**Start from `packages/example-game`** — Odd One Out, about 200 lines including
comments, using every platform surface exactly once. Copy the package, rename it,
start deleting. `packages/say-less` (by The Oracle) and `packages/ghostwriter`
(by Vex) are the full reference implementations when you want to see a real one:
`types.ts` → `normalize.ts` → `rules.ts` → `machine.ts` → `module.ts`.

## What the platform asks of your game

Four optional surfaces beyond the three above. They exist because the platform
runs *any* game and can't know your vocabulary — so instead of the server holding
a `switch` on your phase names, you answer four questions.

| Surface | The question it answers | Required? |
|---------|------------------------|-----------|
| `project(state, ctx)` | What may THIS device see? | **Yes** |
| `privateViews(state)` | Who must be told something nobody else may know? | If you keep secrets |
| `effects(state, event)` | Which clock do I arm, and what command does it send when it dies? | If you have timers |
| `redactEvent(event)` | Does this event say too much to go on the wire? | Rarely |
| `hostOnlyCommands` | Which commands are the host's alone? | Usually |
| `narrate(event, nameOf)` | One log line for the operator. | Optional |

The three that repay careful thought:

**`project` is required, and it fails closed.** There is deliberately no default.
A game that forgot to write one would broadcast its entire state — secrets, deck,
unrevealed authorship — to every phone and the television. `createArcade().register()`
refuses a module without it. If your game genuinely has nothing to hide, write
`project: projectAll` and the decision is explicit and reviewable.

**`privateViews` is a description, not a delivery.** Return who should know what
*right now*, every time it's called. The platform diffs against what it already
sent and delivers only changes — so reconnects, second tabs and late joins all
work without you writing a line for them. Say Less returns one entry (the
Speaker's card); Ghostwriter returns an entry for everyone *except* the Ghost.

**`effects().timer.onExpire` names your own command.** The platform arms the clock
and, when it fires, calls that command. It never guesses what a dead clock means.
A typo here would hang a living room silently — which is why the conformance
harness dispatches every `onExpire` you declare and fails if the engine doesn't
know it.

Identity: the platform sets **`actorId`** on every payload from the authenticated
socket. Read that, never a `playerId` the client put in the body. Both shipped
games use a two-line `actor()` helper — copy it.

## Prove it with one function

```ts
import { assertConformance } from "@gww/kit";

assertConformance(myGame, {
  players: [{ id: "p1", displayName: "A" }, /* … */],
  seed: 7,
  next: (state, step) => /* the next command, or undefined when done */,
  secrets: (state) => [/* strings that must not be public YET */],
});
```

It plays your scripted session twice and fails on: non-determinism, any secret
appearing in a public projection or on the wire, a private view addressed to a
player who isn't in the session, a timer whose `onExpire` isn't a real command,
and anything that isn't JSON-serializable. Every one of those failures is
otherwise **silent** — which is the whole reason it exists. See
`packages/ghostwriter/test/conformance.test.ts`, which also proves the harness can
fail rather than merely pass.

## House rules (non-negotiable)

1. **Deterministic.** `createSession(players, seed)` and every `command` must
   be pure. Same inputs, same outputs, forever. Use the seeded RNG pattern
   from `@gww/say-less`'s `rotation.ts` — never `Math.random()` in a game.
2. **Server-authoritative.** Never trust payload identity — the platform hands
   your command handler the authenticated actor. Cheating must be structurally
   impossible, not discouraged.
3. **Secrets are private channels.** Anything one player must see and others
   must not goes through the platform's private delivery, never public state.
   A leaked secret is a release blocker.
4. **Inference off the critical path.** Your game must be fully playable with
   zero AI. Models may personalize and replenish content between rounds; they
   may never block a turn.
5. **Tested.** Rules, edge cases, and a full happy-path session. Look at the
   existing suites for the bar — a game PR without tests doesn't ship.
6. **Kind by default.** Roast the move, never the person (spec §11). Bundled
   content must be playable at a family table unless the manifest clearly
   gates it.

## Shipping it

1. Fork, branch: `game/<your-game-id>`
2. `packages/<your-game-id>/` implementing the contract + tests
   (copy `packages/example-game` to start)
3. Register the engine in `packages/server/src/gateway.ts` — `arcade.register(...)`
4. Register the UI in `packages/client/src/games/index.ts` — add your `GameView`
   to `VIEWS`. A view draws the board and the phone; the platform owns the lobby,
   the clock, the caption rail and the scoreboard. Skip this and your game runs
   over the wire but has no screen.
5. `pnpm build && pnpm test` — everything green
6. PR with: what the game is, how a round flows, why it's fun in a real room

License is GPLv3 — your game ships under it too, credited to you on the tile
and in the manifest. The arcade IS the credits screen.

*Made by Interchained × The Oracle × the room.*
