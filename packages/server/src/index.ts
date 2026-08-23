export * from "./tokens.js";
export * from "./rooms.js";
export * from "./log.js";
export * from "./session.js";
export * from "./gateway.js";

import { createGateway } from "./gateway.js";

// Direct execution: `node dist/index.js` boots the server.
const isMain = process.argv[1]?.endsWith("index.js") === true;
if (isMain) {
  const port = Number(process.env["PORT"] ?? 3301);
  const host = process.env["HOST"] ?? "127.0.0.1";
  const gw = createGateway();
  void gw.listen(port, host).then((p) => {
    console.log(`[gww-server] listening on ${host}:${p}`);
  });
}
