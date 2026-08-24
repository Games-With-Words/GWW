export * from "./tokens.js";
export * from "./rooms.js";
export * from "./log.js";
export * from "./session.js";
export * from "./gateway.js";
export * from "./voice.js";

import { createGateway } from "./gateway.js";
import { VoiceService, voiceConfigFromEnv } from "./voice.js";
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
  const gw = createGateway({ voice });
  void gw.listen(port, host).then((p) => {
    console.log(`[gww-server] listening on ${host}:${p}`);
  });
}
