import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  plugins: [vue()],
  build: {
    target: "chrome91",
    outDir: "app/gui/ui",
    emptyOutDir: false,
    minify: false,
    lib: { entry: fileURLToPath(new URL("./app/gui/src/main.ts", import.meta.url)), name: "RMCHModern", formats: ["iife"], fileName: () => "modern.js" },
    rollupOptions: { external: ["vue"], output: { globals: { vue: "Vue" } } }
  }
});
