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
};
```

Study `packages/say-less` (by The Oracle) — it's the reference implementation:
`types.ts` → `normalize.ts` → `rules.ts` → `machine.ts` → `module.ts`.

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
3. Register it in `packages/server/src/gateway.ts` (`arcade.register(...)`)
4. `pnpm build && pnpm test` — everything green
5. PR with: what the game is, how a round flows, why it's fun in a real room

License is GPLv3 — your game ships under it too, credited to you on the tile
and in the manifest. The arcade IS the credits screen.

*Made by Interchained × The Oracle × the room.*
