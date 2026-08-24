import { defineConfig } from "vite";

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3301",
      "/ws": { target: "ws://127.0.0.1:3301", ws: true },
    },
  },
});
