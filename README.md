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

Every game ships as a package implementing the `@gww/kit` `GameModule` contract:
a pure, deterministic, event-sourced engine the platform drives. The platform owns
lobbies, realtime sync, persistence, and voice; games own rules.

## Packages

| Package | Purpose |
|---------|---------|
| `@gww/kit` | Platform contract: `GameModule`, `GameManifest`, the arcade registry. |
| `@gww/say-less` | Say Less — deterministic rules engine, tokenization policy, scoring, state machine, L0 starter deck. |

Coming next: lobby service, realtime gateway (WebSockets, server-authoritative),
web client, voice service (Chatterbox Turbo, cache-first), NEDB-backed event log.

## Architecture invariants

- **Inference is off the critical gameplay path.** A model outage may reduce
  novelty; it may never stop the party.
- **Server-authoritative.** The server owns timers, scoring and round order.
  Game engines are pure functions: same seed + same commands = same session.
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
