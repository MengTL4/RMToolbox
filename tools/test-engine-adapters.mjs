// Engine-adapter tests: the registry, the nwjs family adapter's four-part
// interface (detect / plan / payload / capabilities), and proof that routing
// scans and plans through the adapters leaves observable results unchanged.
// Synthetic fixture dirs stand in for real games — same idiom as
// tools/test-nb-shell.mjs.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  adapters,
  adapterById,
  detectWithAdapters
} from "../core/adapters/index.mjs";
import { planLaunch } from "../core/launch-plan.mjs";
import { scanGame } from "../core/scanner.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

const scratch = mkdtempSync(path.join(tmpdir(), "rmch-adapters-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (_) {}
});

function makeGameDir(name) {
  const dir = path.join(scratch, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// --- Registry and interface shape -------------------------------------------

const list = adapters();
assert.ok(list.length >= 1, "at least the nwjs adapter must be registered");
const nwjs = adapterById("nwjs");
assert.ok(nwjs, "nwjs adapter must be registered");

for (const adapter of list) {
  assert.equal(typeof adapter.id, "string");
  assert.equal(typeof adapter.detect, "function", `${adapter.id}.detect`);
  assert.equal(typeof adapter.plan, "function", `${adapter.id}.plan`);
  assert.ok(
    adapter.payload &&
      typeof adapter.payload.dir === "string" &&
      typeof adapter.payload.entry === "string",
    `${adapter.id}.payload must name its bridge payload dir + entry`
  );
  assert.ok(Array.isArray(adapter.capabilities), `${adapter.id}.capabilities`);
  assert.equal(
    new Set(adapter.capabilities).size,
    adapter.capabilities.length,
    `${adapter.id}.capabilities must be unique`
  );
  for (const cap of adapter.capabilities) {
    assert.match(cap, /^[a-z][a-z0-9-]*$/, `capability id shape: ${cap}`);
  }
}

// The nwjs family's declared capabilities cover what the toolbox does today
// (grounded in the bridge command surface: variable/switch/selfSwitch/gold/
// item/actor/save namespaces).
for (const cap of [
  "variables",
  "switches",
  "self-switches",
  "gold",
  "items",
  "actors",
  "saves"
]) {
  assert.ok(
    nwjs.capabilities.includes(cap),
    `nwjs must declare capability ${cap}`
  );
}

// The payload descriptor points at the real bridge bundle in this repo.
assert.ok(
  existsSync(path.join(projectRoot, nwjs.payload.dir, nwjs.payload.entry)),
  `nwjs payload must exist at ${nwjs.payload.dir}/${nwjs.payload.entry}`
);

// --- detect: fingerprints through the adapter -------------------------------

// Plain MV game in www layout.
{
  const root = makeGameDir("mv-game");
  mkdirSync(path.join(root, "www", "js"), { recursive: true });
  writeFileSync(path.join(root, "www", "js", "rpg_core.js"), "// rpg_core");
  writeFileSync(path.join(root, "www", "index.html"), "<title>x</title>");
  writeFileSync(path.join(root, "Game.exe"), "MZ fake exe");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "rmmz-game", main: "www/index.html" })
  );
  const scan = scanGame(root);
  assert.equal(scan.engine.id, "MV");
  assert.equal(scan.layout, "www");
  assert.equal(scan.container, undefined);
  const plan = planLaunch(scan);
  assert.equal(plan.family, "standard-nwjs");
  assert.equal(plan.selected, "extension");
}

// Sealed-launcher MZ (停不下来的轮回 family): game.* container files + MZ libs.
{
  const root = makeGameDir("sealed-game");
  for (const marker of ["game.js", "game.data", "game.version", "game.md5"]) {
    writeFileSync(path.join(root, marker), "x");
  }
  mkdirSync(path.join(root, "js", "libs"), { recursive: true });
  writeFileSync(path.join(root, "js", "libs", "pixi.js"), "// pixi");
  writeFileSync(path.join(root, "轮回.exe"), "MZ fake exe");
  const scan = scanGame(root);
  assert.equal(scan.container, "nwjs-sealed");
  assert.equal(scan.engine.id, "MZ");
  assert.equal(planLaunch(scan).selected, "extension-cdp-seed");
}

// NB evalNWBin variant: hashed .node + hashed extensionless blob in nb_data/.
{
  const root = makeGameDir("nb-evalnwbin-game");
  mkdirSync(path.join(root, "nb_data"), { recursive: true });
  writeFileSync(
    path.join(root, "nb_data", "8bc38d774d3c0a3c2b67177c512ccffa.node"),
    "MZ fake hashed addon"
  );
  writeFileSync(
    path.join(root, "nb_data", "981e939328ec49d3af7b7a01b4e106a4"),
    "fake v8 bytecode blob"
  );
  writeFileSync(path.join(root, "index.html"), "<script>var _0x=1;</script>");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "1", main: "index.html" })
  );
  const scan = scanGame(root);
  assert.equal(scan.container, "nb-evalnwbin");
  const plan = planLaunch(scan);
  assert.equal(plan.family, "nb-evalnwbin");
  assert.equal(plan.selected, "dll");
  assert.equal(plan.candidates.length, 1);
}

// NB Themida shell: nbtool.node + bootEncryptedBin in index.html → refused.
{
  const root = makeGameDir("nb-shell-game");
  mkdirSync(path.join(root, "nb_data"), { recursive: true });
  writeFileSync(path.join(root, "nb_data", "nbtool.node"), "MZ fake addon");
  writeFileSync(
    path.join(root, "index.html"),
    '<script>require("./nb_data/nbtool.node").bootEncryptedBin();</script>'
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "rmmz-game", main: "index.html" })
  );
  const scan = scanGame(root);
  assert.equal(scan.container, "nb-shell");
  const plan = planLaunch(scan);
  assert.equal(plan.family, "unsupported-shell");
  assert.equal(plan.selected, null);
}

// Bundled engine: no core-js names, but a script carries RPGMAKER_NAME.
{
  const root = makeGameDir("bundled-game");
  mkdirSync(path.join(root, "js"), { recursive: true });
  writeFileSync(
    path.join(root, "index.html"),
    '<html><head><title>命运II测试</title></head><body><script src="js/main.js"></script></body></html>'
  );
  writeFileSync(
    path.join(root, "js", "main.js"),
    '(function(){ const RPGMAKER_NAME = "MV"; }.call(this));'
  );
  writeFileSync(path.join(root, "Game.exe"), "MZ fake exe");
  const scan = scanGame(root);
  assert.equal(scan.container, "nwjs-bundled");
  assert.equal(scan.engine.id, "MV");
  assert.equal(planLaunch(scan).selected, "shadow-engine-publish");
}

// Grover boot: bg-script manifest + nwjc bytecode core → dll preferred,
// explicit shadow request still honoured.
{
  const root = makeGameDir("grover-game");
  mkdirSync(path.join(root, "js"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), "<title>g</title>");
  writeFileSync(
    path.join(root, "js", "rpg_core.js"),
    Buffer.from([0x03, 0x04, 0xde, 0xc0, 0x00])
  );
  writeFileSync(path.join(root, "bg.js"), "// bg");
  writeFileSync(path.join(root, "Game.exe"), "MZ fake exe");
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "g", main: "index.html", "bg-script": "bg.js" })
  );
  const scan = scanGame(root);
  assert.equal(scan.engine.id, "MV");
  assert.ok(scan.protection.flags.includes("grover-boot"));
  const plan = planLaunch(scan);
  assert.equal(plan.family, "grover-nwjs");
  assert.equal(plan.preferred, "dll");
  assert.equal(planLaunch(scan, { strategy: "shadow" }).selected, "shadow");
}

// A directory with nothing recognisable still scans as unknown, with the
// NW-family path block filled exactly as before the refactor.
{
  const root = makeGameDir("not-a-game");
  const scan = scanGame(root);
  assert.equal(scan.engine.id, "unknown");
  assert.equal(scan.layout, "root");
  assert.ok(scan.paths && typeof scan.paths === "object");
  const contribution = detectWithAdapters({
    root,
    manifest: null,
    rootFiles: []
  });
  assert.ok(contribution, "the nwjs adapter is the scanner's fall-through");
  assert.equal(contribution.engine, null);
}

// --- plan: the nwjs adapter never claims other families ----------------------
// Adapters are consulted before the legacy planners; these pins prove rgss /
// evb / tauri / RM2K / unknown scans still reach exactly the old outcome.

assert.equal(
  planLaunch({ engine: { id: "RGSS1" }, container: "rgss" }).selected,
  "rgss-script"
);
assert.equal(
  planLaunch({ engine: { id: "RGSS" }, container: "evb" }).selected,
  "evb-unpack-rgss-script"
);
assert.equal(
  planLaunch({
    engine: { id: "MV/MZ" },
    container: "tauri",
    paths: { exe: "C:/x/game.exe" }
  }).selected,
  "tauri-cdp"
);
{
  const plan = planLaunch({ engine: { id: "RM2K" } });
  assert.equal(plan.family, "unsupported-engine");
  assert.equal(plan.selected, null);
}
{
  const plan = planLaunch({});
  assert.equal(plan.family, "unknown");
  assert.equal(plan.selected, null);
  assert.ok(plan.error);
}

// An unknown-container scan with an MV/MZ engine id keeps the historical
// fall-through into the standard NW branch (mirrors isStandardNw).
{
  const plan = planLaunch({
    engine: { id: "MZ" },
    container: "some-future-shell",
    paths: { exe: "C:/x/Game.exe" }
  });
  assert.equal(plan.family, "standard-nwjs");
}

console.log(
  "test-engine-adapters: registry, nwjs detect/plan/payload/capabilities passed"
);
