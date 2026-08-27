// Build the downloadable release zip:
//   node tools/pack-release.mjs
//
// Rebuilds the generated bundles, stages everything the GUI/CLI need (including
// the linked NW.js runtime in app/gui) into output/release/RMToolbox/, then
// zips it to output/RMToolbox-v<version>-win-x64.zip. The zip is what the
// GitHub Release ships: unzip → double-click RMToolbox.exe, no Node required.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildBridge } from "../core/bridge-bundler.mjs";
import { buildGuiBundle } from "../core/gui-bundler.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(path.join(projectRoot, "package.json"), "utf8")).version;

const staging = path.join(projectRoot, "output", "release", "RMToolbox");
const destZip = path.join(projectRoot, "output", `RMToolbox-v${version}-win-x64.zip`);

// Directory contents to ship, relative to projectRoot. app/gui ships complete —
// the linked NW runtime binaries are the whole point of the release zip.
const SHIP_DIRS = ["app/gui", "core", "runtime/bridge", "tools", "docs/screenshots"];
const SHIP_FILES = ["README.md", "LICENSE", "package.json"];
// Volatile / machine-local entries inside the shipped dirs.
const EXCLUDE = new Set(["app/gui/cache", "app/gui/debug.log"]);

function main() {
  const exe = path.join(projectRoot, "app", "gui", "RMToolbox.exe");
  if (!existsSync(exe)) {
    throw new Error("app/gui/RMToolbox.exe 不存在 —— 先跑一次 tools/launch-gui.ps1 或 tools/setup-gui.mjs");
  }

  // Generated artifacts must be current with the sources being zipped.
  buildGuiBundle(projectRoot);
  buildBridge(projectRoot);

  rmSync(staging, { recursive: true, force: true });
  rmSync(destZip, { force: true });
  for (const dir of SHIP_DIRS) {
    const from = path.join(projectRoot, dir);
    const to = path.join(staging, dir);
    cpSync(from, to, {
      recursive: true,
      filter: (source) => {
        const rel = path.relative(projectRoot, source).split(path.sep).join("/");
        return !EXCLUDE.has(rel);
      }
    });
  }
  for (const file of SHIP_FILES) {
    cpSync(path.join(projectRoot, file), path.join(staging, file));
  }

  mkdirSync(path.dirname(destZip), { recursive: true });
  execFileSync("powershell", [
    "-NoProfile", "-Command",
    `Compress-Archive -Path '${staging}' -DestinationPath '${destZip}' -CompressionLevel Optimal`
  ], { stdio: "inherit" });

  const { size } = statSync(destZip);
  console.log(`release zip: ${destZip} (${(size / 1024 / 1024).toFixed(1)} MB)`);
}

main();
