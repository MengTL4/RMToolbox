// Shadow-launcher unit test: setupShadowApp must build a shadow directory
// without ever writing through a junction into the real game tree. The case
// that matters is a bg-script living in a SUBDIRECTORY (e.g.
// "bg_script/boot.js"): the linking pass must carve that path out, the
// patched script must land in a real directory inside the shadow, and the
// game's original file must stay byte-identical. Pure temp dirs, no game
// process involved.

import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setupShadowApp } from "../core/shadow-launcher.mjs";

function makeFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function makeFakeGame(root, bgScript) {
  makeFile(path.join(root, "Game.exe"), "fake-nw-binary");
  makeFile(path.join(root, "nw.dll"), "fake-nw-dll");
  makeFile(path.join(root, "package.json"), JSON.stringify({
    name: "fake-game",
    main: "www/index.html",
    "bg-script": bgScript
  }));
  makeFile(path.join(root, "www", "index.html"), "<html></html>");
  makeFile(path.join(root, "www", "js", "rpg_core.js"), "// core");
  makeFile(path.join(root, "locales", "en-US.pak"), "pak");
  makeFile(path.join(root, bgScript), "// ORIGINAL BG SCRIPT\n");
  // A sibling next to the bg-script: must be linked, not lost.
  makeFile(path.join(root, path.dirname(bgScript), "helper.js"), "// helper\n");
}

function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rmch-shadow-test-"));
  const projectRoot = path.join(tempRoot, "project");
  const gameRoot = path.join(tempRoot, "game");
  const bgScript = path.join("bg_script", "boot.js");
  const originalBg = "// ORIGINAL BG SCRIPT\n";
  try {
    makeFakeGame(gameRoot, bgScript);
    const scan = {
      root: gameRoot,
      layout: "www",
      manifest: { bgScript: bgScript.split(path.sep).join("/") }
    };

    const { appDir, gameExe, bgScriptPath } = setupShadowApp({ projectRoot, scan, gameKey: "fake-game" });

    // Runtime binaries and manifest land in the shadow.
    assert.ok(existsSync(gameExe), "shadow Game.exe must exist");
    assert.ok(existsSync(path.join(appDir, "package.json")), "shadow package.json must exist");

    // Big directories are junctioned wholesale…
    assert.ok(lstatSync(path.join(appDir, "www")).isSymbolicLink(), "www must be a junction");
    assert.ok(lstatSync(path.join(appDir, "locales")).isSymbolicLink(), "locales must be a junction");

    // …but the bg-script's directory is a REAL directory carved out of the
    // junctioned tree, with its siblings still linked in.
    const shadowBgDir = lstatSync(path.join(appDir, "bg_script"));
    assert.ok(shadowBgDir.isDirectory() && !shadowBgDir.isSymbolicLink(),
      "bg_script in the shadow must be a real directory, not a junction");
    assert.ok(existsSync(path.join(appDir, "bg_script", "helper.js")),
      "bg-script siblings must be linked into the shadow");

    // The patched script carries prelude + original + suffix…
    const patched = readFileSync(bgScriptPath, "utf8");
    assert.ok(patched.includes("ORIGINAL BG SCRIPT"), "patched bg-script must embed the original");
    assert.ok(patched.includes("process.cwd"), "patched bg-script must carry the prelude spoof");
    assert.ok(patched.includes("page-bridge"), "patched bg-script must carry the bridge suffix");

    // …and the real game's file is untouched (the write-through-junction bug
    // this guards against would have replaced it with the patched text).
    assert.equal(readFileSync(path.join(gameRoot, bgScript), "utf8"), originalBg,
      "the game's original bg-script must stay byte-identical");

    // Regression: a root-level bg-script ("loading", NWR-style) still works.
    const gameRoot2 = path.join(tempRoot, "game2");
    makeFile(path.join(gameRoot2, "Game.exe"), "fake-nw-binary");
    makeFile(path.join(gameRoot2, "package.json"), JSON.stringify({
      name: "fake-game-2", main: "www/index.html", "bg-script": "loading"
    }));
    makeFile(path.join(gameRoot2, "www", "index.html"), "<html></html>");
    makeFile(path.join(gameRoot2, "loading"), "// ORIGINAL LOADER\n");
    const scan2 = { root: gameRoot2, layout: "www", manifest: { bgScript: "loading" } };
    const { bgScriptPath: patchedPath2 } = setupShadowApp({ projectRoot, scan: scan2, gameKey: "fake-game-2" });
    assert.ok(readFileSync(patchedPath2, "utf8").includes("ORIGINAL LOADER"),
      "root-level bg-script must be patched in the shadow");
    assert.equal(readFileSync(path.join(gameRoot2, "loading"), "utf8"), "// ORIGINAL LOADER\n",
      "root-level original must stay untouched");

    console.log("shadow-launcher test: PASS");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
