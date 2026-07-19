import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const backendPort = Number(process.env.BOARD_AI_PORT?.trim() || 5174);
const webPort = Number(process.env.WILEY_WEB_PORT?.trim() || 5173);

export default defineConfig({
  root: resolve("src/renderer"),
  publicDir: resolve("node_modules/@excalidraw/excalidraw/dist/prod"),
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: webPort,
    strictPort: true,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${backendPort}`,
      },
    },
  },
});
