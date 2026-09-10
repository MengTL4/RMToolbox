// CLI wrapper for core/setup-gui-runtime.mjs:
//   node tools/setup-gui.mjs [--force]
// Downloads the official x64 runtime pinned by nw-runtime.lock.json.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupGuiRuntime } from "../core/setup-gui-runtime.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const force = process.argv.includes("--force");
const summary = await setupGuiRuntime({ projectRoot, force });
console.log(JSON.stringify(summary, null, 2));
