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

```bash
export AIAS_API_KEY=aai_...            # PIN, server-to-server
export GWW_FORGE_MODEL=muse-local:latest   # or gemma4 — same spec, swap the flag

pnpm --filter @gww/forge build
node packages/forge/dist/cli.js list
node packages/forge/dist/cli.js say-less-cards 40
node packages/forge/dist/cli.js ris-lines clue 8
```

The run prints every accept and reject with its reason, then writes
`packs/<spec>/pack-NNN.json`. **Review the pack, then commit it.** Nothing is
live until it is on disk in git.

## How the model hands content back

Every spec teaches the model [sentinel blocks](https://www.npmjs.com/package/sentinel-blocks):

```
<<<CARD>>>
{ "secret": "Air guitar", ... }
<<<END>>>
```

The model thinks for as long as it likes, then closes a block to say DONE. We
read the block and nothing else — no tail-grabbing, no guessing which sentence
was the answer. That guessing is what once put a model's own reasoning
("I'll produce one line.") into a rendered WAV. There is no token cap, because
capping a thinking model starves its reasoning pass and the answer comes back
empty.

A truncated completion (`finish_reason: "length"`) is rejected outright — it
cannot have closed a block, so its fragment is never parsed.

## Adding a spec

A `ContentSpec` is four things: a brief, the shape the model should emit, a
gate, and a dedupe key.

```ts
export const myThing: ContentSpec<Thing> = {
  id: "my-thing", version: "1", tag: "THING", payload: "json",
  brief: "You write ...",
  shape: `{ "field": "example" }`,
  user: ({ seed, avoid }) => `Write one. Seed: ${seed}.`,
  gate: (raw) => /* validate, return {ok:true,item} or {ok:false,reason} */,
  key: (item) => normalize(item.field),
};
```

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
