// CLI wrapper for core/gui-bundler.mjs:
//   node tools/gui-build.mjs
// Regenerates app/gui/gui-bundle.cjs (the CJS copy of the ESM core that the
// NW.js GUI requires). launch-gui.ps1 runs this automatically.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuiBundle } from "../core/gui-bundler.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = buildGuiBundle(projectRoot);
console.log(`gui bundle built: ${outputPath}`);
