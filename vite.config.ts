import { resolve } from "node:path";
import { defineConfig } from "vite";

// Five pages: the panel, the three overlays and the help, each its own window.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { panel: resolve(__dirname, "index.html"), overlay: resolve(__dirname, "overlay.html"), pets: resolve(__dirname, "pets.html"), dps: resolve(__dirname, "dps.html"), help: resolve(__dirname, "help.html") },
    },
  },
});
