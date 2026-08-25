# Games With Words

**The room is the game.**

Private-room party games for the friends and family already sitting next to you.
One person starts a room. Everyone scans in. Then the stories begin.

Games With Words is an **arcade — a community of games**. Each game is made by a
person and carries their credit on its tile. The first game, **Say Less**, was
conceived by Interchained & The Oracle.

> **Product thesis:** AI creates the game. Humans create the fun.
> Models may personalize and replenish content, but live play never depends on
> synchronous inference.

## The arcade

| Game | Maker | Status |
|------|-------|--------|
| Say Less | The Oracle | In development (flagship) |
| Ghost Writer | Vex | In development |
| Odd One Out | *the example* | Template for new makers |

Every game ships as a package implementing the `@gww/kit` `GameModule` contract:
a pure, deterministic, event-sourced engine the platform drives. The platform owns
lobbies, realtime sync, persistence, and voice; games own rules.

## Packages

| Package | Purpose |
|---------|---------|
| `@gww/kit` | Platform contract: `GameModule`, `GameManifest`, the arcade registry, the conformance harness. |
| `@gww/say-less` | Say Less — deterministic rules engine, tokenization policy, scoring, state machine, L0 starter deck. |
| `@gww/ghostwriter` | Ghost Writer — everyone answers the prompt except one player, who never saw it. |
| `@gww/example-game` | Odd One Out — the smallest complete game. Copy this to start your own. |
| `@gww/server` | Lobbies, realtime gateway, the generic session runner, Ris's voice. |
| `@gww/client` | The board and the phones. Per-game views in `src/games/`. |
| `@gww/forge` | Content pipeline: generates and freezes validated packs. |

Coming next: NEDB-backed event log, voice personalization (Phase 3).

## Adding a game

One package, two registrations:

```
packages/my-game/                    # the engine: pure, deterministic, tested
packages/server/src/gateway.ts       # arcade.register(myGame)
packages/client/src/games/index.ts   # VIEWS.push(myGameView)
```

The platform gives you private lobbies with QR join, sockets, reconnects, host
assignment, timers, the scoreboard, the event log and a voiced host. You write
rules and two render functions. Start from `packages/example-game` and read
[CONTRIBUTING.md](CONTRIBUTING.md) — `assertConformance` from `@gww/kit` enforces
the house rules for you.

## Architecture invariants

- **Inference is off the critical gameplay path.** A model outage may reduce
  novelty; it may never stop the party.
- **Server-authoritative.** The server owns timers, scoring and round order.
  Game engines are pure functions: same seed + same commands = same session.
  Identity comes from the authenticated socket (`actorId`), never from a payload.
- **The platform holds no game code.** The session runner drives any `GameModule`
  through four surfaces — `project`, `privateViews`, `effects`, `redactEvent` — so
  a new game needs no changes to the server. There is no `switch` on a phase name
  anywhere in `packages/server`.
- **Deterministic rules.** Clue budgets, forbidden terms and guess matching are
  enforced by code, not by a model. Semantic loopholes go to a room vote —
  the party retains final authority.
- **Private means access-controlled.** Invite-only lobbies, bounded retention,
  no public matchmaking, no stranger discovery.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

Requires Node 20+ and pnpm.

## License

GPL-3.0-only. See [LICENSE](LICENSE).

© Interchained LLC Labs. Say Less conceived by Interchained & The Oracle.
