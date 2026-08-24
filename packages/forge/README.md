# @gww/forge

Offline content pipeline for Games With Words. Generates, gates, and versions
content packs that the running game reads as plain data.

**Nothing here runs on the gameplay path.** No player ever waits on a model.
Content is forged on our schedule, reviewed by a human, committed to git, and
only then loaded at boot.

## Why it exists

Say Less shipped with 12 hand-authored cards. Twelve cards means the same
secrets every night, which is the fastest way to make a party game stop being
fun. The fix is more content, not live generation — a model in the request path
would add latency, cost, and a failure mode to a game whose whole promise is
that the room never waits.

So: generate offline, gate hard, write to disk, load at boot.

## Run a pack

| env var | default | what it does |
|---|---|---|
| `AIAS_API_KEY` | — | **required.** PIN key, server-to-server. |
| `GWW_FORGE_MODEL` | `muse-local:latest` | Which model writes. Use the exact id from `models`. |
| `GWW_FORGE_TEMP` | `1.0` | Sampling temperature. Variety is the point; lowering it makes packs samey. |
| `AIAS_URL` | `https://aiassist.net` | PIN base url. |
| `GWW_FORGE_MAX_TOKENS` | `16384` | Generation ceiling. Omitting it is NOT unlimited — the server default applies, and that default cut muse off mid-thought. |
| `GWW_PACK_DIR` | `packs` | Where packs are written and read. |

Run `models` first — it reads the live PIN network list, so the model id is a
lookup instead of a guess (the endpoint is `/api/v1/pin/network/models`):

```bash
export AIAS_API_KEY=aai_...
node packages/forge/dist/cli.js models

# then, per run — no export needed
GWW_FORGE_MODEL=<exact-id> node packages/forge/dist/cli.js say-less-cards 40

```

Known writers on the network as of 2026-08-24: `muse-local:latest`,
`muse-chat:latest`, `gemma4:26b`, `qwen3.6:27b`, plus the cloud models.

**Format compliance varies by model, and it is the first thing to check.**
`muse-local:latest` emitted correct blocks on its first ever call. `gemma4:26b`
ignored a system-only lesson and replied in markdown bullets
(`*Secret:* Disco Ball`), writing several cards at once — so the format
reminder now rides on the *user* turn, and a model that still answers in prose
is shown its own reply and asked to convert it, once. If it fails twice the
attempt is rejected. We never parse markdown; teaching the contract is the
only lever, because tolerating a broken contract is how the JSON repair pile
got built.

**`gemma4-extract:31b` and `muse-extract:latest` are NOT writers.** They are
tuned to pull structure out of text you hand them — the opposite job. They will
follow the block format perfectly and write flat cards. `models` groups them
separately for exactly this reason.

Comparing two writers is the same spec with a different id — identical brief,
identical gate, so the accepted cards are the only variable. Compare the cards,
not just the reject counts.

```bash
node packages/forge/dist/cli.js list
node packages/forge/dist/cli.js ris-lines clue 8
```

The run prints every accept and reject with its reason, and writes
`packs/<spec>/pack-NNN.json` **as each card lands** — so Ctrl-C at card 12 of
40 keeps all twelve. **Review the pack, then commit it.** Nothing is live until
it is on disk in git.

## How the model hands content back

Every spec teaches the model [sentinel blocks](https://www.npmjs.com/package/sentinel-blocks).
**Each value gets its own named block. There is no JSON.**

```
<<<FIELD secret>>>
Mom's "famous" dip
<<<END>>>
<<<FIELD forbidden>>>
mayonnaise
recipe
potluck
<<<END>>>
```

That is not a stylistic preference, it is the whole point. A JSON payload has
quotes to escape, braces to balance and commas to forget, and a local model
gets one of them wrong eventually — the first live run died on
`Expected property name or '}' at position 2`. Field blocks have no parse step
at all: the bytes between the markers are the value. Apostrophes, quotes and
braces in a reveal line are now harmless.

A field with several values gets one block with **one value per line** —
bullets and stray quotes are stripped. Missing a required field reports
`missing field block(s): budget`, which is a diagnosis instead of a stack
trace.

The model thinks for as long as it likes, then writes its blocks to say DONE. We
read the blocks and nothing else — no tail-grabbing, no guessing which sentence
was the answer. If it changes its mind and rewrites the set, the last block for
each field wins. That guessing is what once put a model's own reasoning
("I'll produce one line.") into a rendered WAV. There is no token cap, because
capping a thinking model starves its reasoning pass and the answer comes back
empty.

A truncated completion (`finish_reason: "length"`) is rejected outright — it
cannot have closed a block, so its fragment is never parsed.

## Streaming, and why

The request streams (`stream: true`). A 16k-token deliberation takes minutes,
and a non-streamed request sits idle for all of it — the proxy killed those
with a **504 before muse ever finished thinking**. Streaming keeps bytes
moving, so nothing idles out, and you get a live heartbeat in the terminal
instead of a frozen prompt.

It also gives the model a real way to say DONE: **once every required block is
closed, we stop reading and free the GPU.** That is not eager parsing — a block
is never judged until its `<<<END>>>` has arrived, and a half-written set keeps
the stream open. A server that ignores `stream: true` still works; the reader
falls back to parsing a single completion object.

Gateway 5xx (502/503/504) is retried once — the local model is fine, the proxy
blinked.

## Adding a spec

A `ContentSpec` is four things: a brief, the shape the model should emit, a
gate, and a dedupe key.

```ts
export const myThing: ContentSpec<Thing> = {
  id: "my-thing", version: "1", tag: "FIELD", payload: "fields",
  fields: ["name", "notes"], required: ["name"],
  brief: "You write ...",
  shape: "<<<FIELD name>>>\nexample\n<<<END>>>",
  user: ({ seed, avoid }) => `Write one. Seed: ${seed}.`,
  // raw is Record<field, string> — the plain text between the markers.
  gate: (raw) => /* validate, return {ok:true,item} or {ok:false,reason} */,
  key: (item) => normalize(item.name),
};
```

Use `payload: "text"` with a single tag when the whole item is one piece of
prose (Ris's hosting lines work this way).

The gate is where the real work is. Write it as if a bad item will reach a
player, because it will. The Say Less card gate rejects a forbidden-word list
containing the answer's own words — that card is unplayable, and no amount of
prompt tuning reliably prevents it.

## Packs are additive

Packs are numbered and written once. The forge never edits or deletes an
existing pack; new content goes into the next file. If a pack turns out bad, a
human moves it out of the directory. Every pack records the model, date, spec
version, and a hash of the exact prompt that produced it, so a bad batch is
traceable.

## Deck assembly

`loadDeck()` returns the hand-authored starter deck first, then every packed
card not already present by normalized secret. A pack can never shadow a
hand-authored card. The server calls this once at boot and hands the result to
`configureDeck()`.
