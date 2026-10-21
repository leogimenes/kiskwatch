import { resolve } from "node:path";
import { defineConfig } from "vite";

// Three pages: the panel and the two overlays, each its own window.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { panel: resolve(__dirname, "index.html"), overlay: resolve(__dirname, "overlay.html"), pets: resolve(__dirname, "pets.html") },
    },
  },
});
