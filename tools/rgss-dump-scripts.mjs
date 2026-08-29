// Dump every script entry from an RGSS game's Scripts archive to disk, so the
// engine's default classes (Game_Battler, Scene_Map, ...) can be read directly
// instead of guessed from memory. Read-only against the game itself.
//
//   node tools/rgss-dump-scripts.mjs <gameRoot> <outDir>

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { detectRgss, readScriptsArchive } from "../core/rgss.mjs";
import { parseScripts } from "../core/rgss-marshal.mjs";

const [gameRoot, outDir] = process.argv.slice(2);
if (!gameRoot || !outDir) {
  console.error("usage: node tools/rgss-dump-scripts.mjs <gameRoot> <outDir>");
  process.exit(1);
}

const detect = detectRgss(gameRoot);
const parsed = parseScripts(readScriptsArchive(detect), { ruby19: detect.ruby19 });
mkdirSync(outDir, { recursive: true });

let written = 0;
for (const entry of parsed.entries) {
  let source;
  try {
    source = zlib.inflateSync(entry.zlib).toString("utf8");
  } catch {
    continue; // some entries are placeholders with no zlib body
  }
  const safeName = entry.name.replace(/[^\w.-]+/g, "_") || `entry${entry.index}`;
  const file = path.join(outDir, `${String(entry.index).padStart(3, "0")}_${safeName}.rb`);
  writeFileSync(file, source);
  written += 1;
}
console.log(`${detect.engine} ${parsed.count} entries, ${written} written -> ${outDir}`);
