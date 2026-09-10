import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [vue()],
  build: {
    // The GUI runs in the NW.js runtime pinned by nw-runtime.lock.json
    // (NW 0.115.0 / Chromium 152), not Chromium 91. The old target described a
    // runtime this project never used.
    target: "chrome152",
    outDir: "app/gui/ui",
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("./app/gui/src/main.ts", import.meta.url)),
      name: "RMCHModern",
      formats: ["iife"],
      fileName: () => "modern.js"
    },
    rollupOptions: { external: ["vue"], output: { globals: { vue: "Vue" } } }
  }
});
