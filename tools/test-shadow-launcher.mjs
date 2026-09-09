// Shadow-launcher unit test: setupShadowApp must build a shadow directory
// without ever writing through a junction into the real game tree. The case
// that matters is a bg-script living in a SUBDIRECTORY (e.g.
// "bg_script/boot.js"): the linking pass must carve that path out, the
// patched script must land in a real directory inside the shadow, and the
// game's original file must stay byte-identical. Pure temp dirs, no game
// process involved.

import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import * as fs from "node:fs";
import { setupShadowApp, setupBundledShadowApp, patchBundledEngineScript } from "../core/shadow-launcher.mjs";

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
    const bundledWindow = {};
    const bundledSource = '(function(){function Scene_Item(){} function Scene_Battle(){} function Game_Action(){} window.expected={Scene_Item:Scene_Item,Scene_Battle:Scene_Battle,Game_Action:Game_Action};}.call(this));';
    vm.runInNewContext(patchBundledEngineScript(bundledSource), {window:bundledWindow});
    for (const name of ["Scene_Item","Scene_Battle","Game_Action"]) assert.equal(bundledWindow[name],bundledWindow.expected[name],name+" must be published from the native bundle closure");
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
    const nativeModules = ["D:\\MacType\\MacType.dll", "D:\\MacType\\MacType.Core.dll", "C:\\Windows\\System32\\winmm.dll", "D:\\Other\\MacType.dll"];
    const shadowProcess = {env:{},cwd:()=>gameRoot,report:{getReport:()=>({sharedObjects:[...nativeModules]})}};
    vm.runInNewContext(patched,{require:name=>name==="fs"?fs:path,process:shadowProcess,location:{href:"chrome-extension://test/_generated_background_page.html"}});
    assert.deepEqual(shadowProcess.report.getReport().sharedObjects,nativeModules.slice(2),"shadow bootstrap filters only the observed font compatibility modules");

    // …and the real game's file is untouched (the write-through-junction bug
    // this guards against would have replaced it with the patched text).
    assert.equal(readFileSync(path.join(gameRoot, bgScript), "utf8"), originalBg,
      "the game's original bg-script must stay byte-identical");
    makeFile(path.join(appDir, "wmic.exe"), "stale toolbox shim");
    setupShadowApp({ projectRoot, scan, gameKey: "fake-game" });
    assert.equal(existsSync(path.join(appDir, "wmic.exe")), false, "plain shadow must not retain a previous guarded launch shim");

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

    const namedRoot = path.join(tempRoot, "named-game");
    makeFakeGame(namedRoot, "loading");
    const namedExe = path.join(namedRoot, "末日风暴.exe");
    fs.renameSync(path.join(namedRoot, "Game.exe"), namedExe);
    const named = setupShadowApp({projectRoot, scan:{root:namedRoot,layout:"www",paths:{exe:namedExe},manifest:{bgScript:"loading"}},gameKey:"named-game"});
    assert.equal(named.gameExe, path.join(named.appDir, "末日风暴.exe"));
    assert.equal(readFileSync(named.gameExe,"utf8"), "fake-nw-binary");
    const namedProcess={env:{},cwd:()=>named.appDir};
    vm.runInNewContext(readFileSync(named.bgScriptPath,"utf8"),{require:name=>name==="fs"?fs:path,process:namedProcess,location:{href:"chrome-extension://test/_generated_background_page.html"}});
    assert.equal(namedProcess.execPath,namedExe,"shadow prelude must preserve the actual source executable name");

    // grover-boot: the shell's own chain runs (original kept), the manifest
    // copy stays stock (Some.js validates it), the wmic shim is deployed, and
    // the guards bootstrap is present. setupShadowApp copies the shim from
    // <projectRoot>/runtime/bin, so seed the fake project with a dummy first.
    makeFile(path.join(projectRoot, "runtime", "bin", "wmic.exe"), "fake-wmic-shim");
    const gameRoot3 = path.join(tempRoot, "game3");
    const stockManifest = JSON.stringify({ name: "fake-game-3", main: "www/loading.html", "bg-script": "loading", window: { show: false } });
    makeFile(path.join(gameRoot3, "Game.exe"), "fake-nw-binary");
    makeFile(path.join(gameRoot3, "package.json"), stockManifest);
    makeFile(path.join(gameRoot3, "www", "loading.html"), "<html></html>");
    makeFile(path.join(gameRoot3, "www", "index.html"), "<html></html>");
    makeFile(path.join(gameRoot3, "loading"), "// ORIGINAL GROVER LOADER\n");
    const scan3 = {
      root: gameRoot3,
      layout: "www",
      manifest: { bgScript: "loading" },
      protection: { flags: ["grover-boot"] }
    };
    const { appDir: appDir3, bgScriptPath: patchedPath3 } = setupShadowApp({ projectRoot, scan: scan3, gameKey: "fake-game-3" });
    assert.equal(readFileSync(path.join(appDir3, "package.json"), "utf8"), stockManifest,
      "grover shadow manifest copy must stay byte-identical to the game's");
    assert.ok(existsSync(path.join(appDir3, "wmic.exe")), "grover shadow must carry the wmic shim");
    const patched3 = readFileSync(patchedPath3, "utf8");
    assert.ok(patched3.includes("ORIGINAL GROVER LOADER"), "grover patched bg-script must embed the original");
    assert.ok(patched3.includes("__rmchGroverGuards"), "grover patched bg-script must carry the guards bootstrap");
    assert.ok(patched3.includes("crashRenderer"), "grover guards must cover crashRenderer");
    assert.equal(readFileSync(path.join(gameRoot3, "loading"), "utf8"), "// ORIGINAL GROVER LOADER\n",
      "grover root-level original must stay untouched");

    // Both public entry points must preserve the same filesystem contract,
    // including root layouts, nested patches and links left by old builds.
    for (const kind of ["bg", "bundled"]) {
      for (const layout of ["root", "www"]) {
        for (const nested of [false, true]) {
          const key = `${kind}-${layout}-${nested ? "nested" : "flat"}`;
          const root = path.join(tempRoot, key);
          const app = path.join(projectRoot, "runtime", "shadow-apps", key);
          const script = nested ? (layout === "www" ? "www/js/engine.js" : "js/engine.js") : "engine.js";
          const source = '(function () { var originalMarker = "ORIGINAL"; }.call(this));';
          const manifest = JSON.stringify({ name: key, main: layout === "www" ? "www/index.html" : "index.html" });
          makeFile(path.join(root, "Game.exe"), "fake-exe");
          makeFile(path.join(root, "package.json"), manifest);
          makeFile(path.join(root, script), source);
          makeFile(path.join(root, path.dirname(script), "sibling.dat"), "sibling");
          const saveRel = layout === "www" ? "www/save" : "save";
          const realSave = path.join(root, saveRel);
          const oldSave = path.join(app, saveRel);
          makeFile(path.join(realSave, "file1.rmmzsave"), "REAL-NEWER");
          makeFile(path.join(oldSave, "file1.rmmzsave"), "shadow-old");
          makeFile(path.join(realSave, "file2.rmmzsave"), "real-old");
          makeFile(path.join(oldSave, "file2.rmmzsave"), "SHADOW-NEWER");
          makeFile(path.join(oldSave, "file3.rmmzsave"), "RESCUED");
          for (const [file, seconds] of [[path.join(realSave, "file1.rmmzsave"), 200], [path.join(oldSave, "file1.rmmzsave"), 100], [path.join(realSave, "file2.rmmzsave"), 100], [path.join(oldSave, "file2.rmmzsave"), 200]]) utimesSync(file, seconds, seconds);
          linkSync(path.join(root, "package.json"), path.join(app, "package.json"));
          if (nested) {
            const parent = path.join(app, path.dirname(script));
            mkdirSync(path.dirname(parent), { recursive: true });
            symlinkSync(path.join(root, path.dirname(script)), parent, "junction");
          } else {
            linkSync(path.join(root, script), path.join(app, script));
          }
          const scan = { root, layout, manifest: { bgScript: script }, bundled: { scriptRel: script } };
          const setup = kind === "bg" ? setupShadowApp : setupBundledShadowApp;
          const result = setup({ projectRoot, scan, gameKey: key });
          const patchPath = result.bgScriptPath || result.patchedScript;
          assert.equal(readFileSync(path.join(root, script), "utf8"), source, `${key}: original patch source unchanged`);
          assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), manifest, `${key}: original manifest unchanged`);
          assert.ok(readFileSync(patchPath, "utf8").includes("ORIGINAL"));
          assert.notEqual(readFileSync(patchPath, "utf8"), source);
          assert.equal(readFileSync(path.join(realSave, "file1.rmmzsave"), "utf8"), "REAL-NEWER");
          assert.equal(readFileSync(path.join(realSave, "file2.rmmzsave"), "utf8"), "SHADOW-NEWER");
          assert.equal(readFileSync(path.join(realSave, "file3.rmmzsave"), "utf8"), "RESCUED");
          writeFileSync(path.join(app, saveRel, "file4.rmmzsave"), "WRITE-THROUGH");
          assert.equal(readFileSync(path.join(realSave, "file4.rmmzsave"), "utf8"), "WRITE-THROUGH");
          writeFileSync(path.join(app, "package.json"), "private manifest");
          assert.equal(readFileSync(path.join(root, "package.json"), "utf8"), manifest, `${key}: manifest copy is independent`);
          const firstPatch = readFileSync(patchPath, "utf8");
          setup({ projectRoot, scan, gameKey: key });
          assert.equal(readFileSync(patchPath, "utf8"), firstPatch, `${key}: rebuild does not accumulate patches`);
          assert.equal(readFileSync(path.join(realSave, "file4.rmmzsave"), "utf8"), "WRITE-THROUGH", `${key}: rebuilding existing links preserves real saves`);
        }
      }
    }
    for (const kind of ["bg", "bundled"]) {
      const key = `source-junction-${kind}`;
      const root = path.join(tempRoot, key);
      const shared = path.join(tempRoot, `${key}-shared`);
      const app = path.join(projectRoot, "runtime", "shadow-apps", key);
      const source = '(function () { var marker = "SHARED ORIGINAL"; }.call(this));';
      makeFile(path.join(root, "Game.exe"), "fake");
      makeFile(path.join(root, "package.json"), "{}");
      makeFile(path.join(shared, "js", "engine.js"), source);
      makeFile(path.join(shared, "save", "file1.rmmzsave"), "real-save");
      symlinkSync(shared, path.join(root, "www"), "junction");
      mkdirSync(app, { recursive: true });
      symlinkSync(path.join(root, "www"), path.join(app, "www"), "junction");
      const setup = kind === "bg" ? setupShadowApp : setupBundledShadowApp;
      setup({ projectRoot, gameKey: key, scan: { root, layout: "www", manifest: { bgScript: "www/js/engine.js" }, bundled: { scriptRel: "www/js/engine.js" } } });
      assert.equal(readFileSync(path.join(shared, "js", "engine.js"), "utf8"), source, "source junction never receives patch writes");
      assert.equal(readFileSync(path.join(shared, "save", "file1.rmmzsave"), "utf8"), "real-save");
    }
    const invalidRoot = path.join(tempRoot, "invalid-bundled");
    makeFile(path.join(invalidRoot, "engine.js"), "no wrapper anchor");
    assert.throws(() => setupBundledShadowApp({ projectRoot, gameKey: "invalid", scan: { root: invalidRoot, bundled: { scriptRel: "engine.js" } } }), /anchor not found/);
    assert.equal(existsSync(path.join(projectRoot, "runtime", "shadow-apps", "invalid")), false, "bad patch fails before filesystem rebuild");
    console.log("shadow-launcher test: PASS (both families, root/www, rescue, old links, private copies and rebuilds)");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
