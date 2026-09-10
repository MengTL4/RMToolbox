// Inspect the RMCH-patched scripts inside an RGSS shadow copy.
//
// The shadow directory is named after the game key (see core/rgss-launcher.mjs),
// so it is `runtime/rgss-shadow/<gameKey>/` — and gameKey is derived from the
// game root's basename. That name moved once already (the Pokémon 赤途 key went
// from `_1_0_9_1_unpacked` to `_1_0_9_1__unpacked`, one underscore to two), which
// silently broke this probe's hardcoded path.
//
// So rather than hardcode a new name and wait for it to drift again:
//   node tools/probes/_check-shadow.mjs [shadowDirOrGameKey]
// With no argument it finds every shadow that actually contains
// Data/Scripts.rxdata and reports which ones it found.
import { parseScripts } from "../../core/rgss-marshal.mjs";
import zlib from "node:zlib";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const shadowRoot = path.join(repoRoot, "runtime", "rgss-shadow");
const scriptsRel = path.join("Data", "Scripts.rxdata");

function candidatesFor(arg) {
  if (arg) {
    // Accept either a full shadow path or a bare game key.
    const asPath = path.isAbsolute(arg) ? arg : path.join(shadowRoot, arg);
    const direct = path.join(asPath, scriptsRel);
    if (existsSync(direct)) return [asPath];
    if (existsSync(asPath) && path.basename(asPath) === "Scripts.rxdata") {
      return [path.dirname(path.dirname(asPath))];
    }
    return [];
  }
  if (!existsSync(shadowRoot)) return [];
  return readdirSync(shadowRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(shadowRoot, e.name))
    .filter((dir) => existsSync(path.join(dir, scriptsRel)));
}

const found = candidatesFor(process.argv[2]);

if (!found.length) {
  console.error(
    process.argv[2]
      ? `no shadow scripts found for "${process.argv[2]}" under ${shadowRoot}`
      : `no shadow copy contains ${scriptsRel} under ${shadowRoot}\n` +
        "launch an RGSS game once from the toolbox to create one, or pass a game key."
  );
  process.exit(1);
}

for (const shadowDir of found) {
  console.log(`# ${path.relative(repoRoot, shadowDir)}`);
  const parsed = parseScripts(readFileSync(path.join(shadowDir, scriptsRel)));
  let patched = 0;
  for (const entry of parsed.entries) {
    const name = entry.name ? entry.name.toString() : "";
    if (!name.includes("RMCH")) continue;
    patched += 1;
    const body = zlib.inflateSync(entry.zlib).toString("utf8");
    console.log(
      `  ${name}  len=${body.length}`,
      `graphicsHook=${body.includes("rmch_graphics_update")}`,
      `disposeFallback=${body.includes("every live EventScene")}`,
      `heartbeat=${body.includes("rmch-heartbeat")}`
    );
  }
  if (!patched) console.log("  (no RMCH-patched entries — this shadow is unpatched or stale)");
}
