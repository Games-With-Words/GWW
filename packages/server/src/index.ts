export * from "./tokens.js";
export * from "./rooms.js";
export * from "./log.js";
export * from "./session.js";
export * from "./gateway.js";
export * from "./voice.js";
export * from "./blog/service.js";
export * from "./blog/store.js";
export * from "./blog/render.js";
export * from "./blog/markdown.js";
export * from "./blog/seed.js";

import { createGateway } from "./gateway.js";
import { VoiceService, voiceConfigFromEnv } from "./voice.js";
import { BlogService, blogConfigFromEnv } from "./blog/service.js";
import { seedIfMissing } from "./blog/seed.js";
import { configureDeck, deckSize } from "@gww/say-less";
import { loadDeck } from "@gww/forge";

// Direct execution: `node dist/index.js` boots the server.
const isMain = process.argv[1]?.endsWith("index.js") === true;
if (isMain) {
  const port = Number(process.env["PORT"] ?? 3301);
  const host = process.env["HOST"] ?? "127.0.0.1";
  // Deal from the starter deck plus every forged pack on disk. Pure file
  // reading — the forge generates offline, long before anyone presses play.
  const deck = loadDeck();
  configureDeck(deck);
  console.log(`[deck] ${deckSize()} card(s) loaded (starter + forged packs)`);
  const voice = new VoiceService(voiceConfigFromEnv());
  voice.start();
  // Muse writes the blog on a timer, off the gameplay path entirely. Seeded
  // here so the floor exists before the first tick can add to it.
  const blog = new BlogService(blogConfigFromEnv());
  seedIfMissing(blog.store, Date.now());
  blog.start();
  const gw = createGateway({ voice, blog });
  void gw.listen(port, host).then((p) => {
    console.log(`[gww-server] listening on ${host}:${p}`);
  });
}
