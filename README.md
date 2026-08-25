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
| `@gww/server` | Lobbies, realtime gateway, the generic session runner, Ris's voice, the blog. |
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

## The blog

`/blog` is server-rendered HTML — the prose is in the response body, so a crawler
gets the article without executing a line of JavaScript. Each post carries its own
title, description, canonical, OG card and `BlogPosting` JSON-LD; `/sitemap.xml`
and `/feed.xml` are generated from the published set. Posts live as one JSON file
each under `GWW_BLOG_DIR` — data, not source, and gitignored.

Muse drafts posts on a timer. Autopublish is ON, and three independent gates are
what make that safe: a quality check (length, structure, subject, model tells), a
novelty check (duplicate slug, near-identical title), and a cadence — a daily cap,
a minimum gap, random jitter and quiet hours. The interval is how often we *think*
about publishing; the cadence is how often anything actually lands.

| Knob | Default | What it does |
|------|---------|--------------|
| `GWW_BLOG_ENABLED` | `1` | Master switch. Off means no drafting, no publishing. |
| `GWW_BLOG_AUTOPUBLISH` | `1` | GO LIVE. Off keeps drafts back for review. |
| `GWW_BLOG_INTERVAL_MIN` | `60` | Minutes between attempts (floor: 5). |
| `GWW_BLOG_DAILY_MAX` | `3` | Hard ceiling of posts published per local day. |
| `GWW_BLOG_MIN_GAP_MIN` | `150` | Minimum minutes between two published posts. |
| `GWW_BLOG_JITTER_MIN` | `45` | Random minutes added to that gap, re-rolled each time. |
| `GWW_BLOG_HOUR_START` / `_END` | `8` / `23` | Local hours in which publishing is allowed. |
| `GWW_BLOG_TOPICS` | built-in queue | `\|`-separated keyword queue. |
| `GWW_BLOG_TONE` | plain and specific | Voice direction, handed to Muse verbatim. |
| `GWW_BLOG_MIN_WORDS` / `_MAX_WORDS` | `500` / `1400` | Publishable length window. |
| `GWW_BLOG_MODEL` | `muse-local:latest` | The writer. |
| `GWW_BLOG_DIR` | `./blog-store` | Where posts live. |
| `GWW_BLOG_ADMIN_TOKEN` | *(unset)* | Bearer token for the knobs API. **Unset closes the API.** |

The same knobs turn at runtime, no restart:

```bash
curl -H "authorization: Bearer $GWW_BLOG_ADMIN_TOKEN" localhost:3301/api/blog/status
curl -XPOST -H "authorization: Bearer $TOKEN" -d '{"on":true}'        .../api/blog/golive
curl -XPOST -H "authorization: Bearer $TOKEN" -d '{"dailyMax":2}'     .../api/blog/knobs
curl -XPOST -H "authorization: Bearer $TOKEN" -d '{"topic":"..."}'    .../api/blog/write
curl -XPOST -H "authorization: Bearer $TOKEN" -d '{"slug":"..."}'     .../api/blog/publish
```

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
