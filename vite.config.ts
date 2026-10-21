import { resolve } from "node:path";
import { defineConfig } from "vite";

// Two pages: the panel and the overlay, each its own window.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  build: {
    target: "es2022",
    rollupOptions: {
      input: { panel: resolve(__dirname, "index.html"), overlay: resolve(__dirname, "overlay.html") },
    },
  },
});
