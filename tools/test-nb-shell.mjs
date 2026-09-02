// NB-shell unit test: scanner detection + the hard refusals in launcher/attach.
// No real game — a synthetic nb_data/nbtool.node and an index.html with the
// bootEncryptedBin call stand in for the shell. The launcher/attach checks
// must fire BEFORE anything is spawned, injected or written.
//
//   - scanGame labels the NB-shell layout container "nb-shell" (engine MZ,
//     protection level 4, nb-shell-protected flag, title from the manifest)
//   - near-miss layouts (nbtool.node missing / no bootEncryptedBin call) do
//     NOT count as nb-shell
//   - injectionStrategy reports unsupported-nb-shell
//   - launchGame and attachGame refuse before touching anything

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { scanGame, injectionStrategy } from "../core/scanner.mjs";
import { launchGame } from "../core/launcher.mjs";
import { attachGame, AttachError } from "../core/attach.mjs";

function makeFakeNbGame(root, { withTool = true, bootCall = true } = {}) {
  mkdirSync(path.join(root, "nb_data"), { recursive: true });
  mkdirSync(path.join(root, "img", "animations"), { recursive: true });
  mkdirSync(path.join(root, "audio", "bgm"), { recursive: true });
  if (withTool) {
    // Stand-in for the 5.6MB Themida-packed addon: content is irrelevant, the
    // scanner only checks existence.
    writeFileSync(path.join(root, "nb_data", "nbtool.node"), "MZ fake nbtool node addon");
  }
  const boot = bootCall ? 'require("./nb_data/nbtool.node").bootEncryptedBin();' : "console.log('plain page');";
  writeFileSync(
    path.join(root, "index.html"),
    `<!doctype html><html><body>\n  <script type="text/javascript">${boot}</script>\n</body></html>`
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "rmmz-game",
      main: "index.html",
      window: { title: "重装机兵-宿敌【测试】", width: 816 },
      "chromium-args": "--force-color-profile=srgb --disable-devtools"
    })
  );
  writeFileSync(path.join(root, "重装机兵-宿敌.exe"), "MZ fake nw.js game exe");
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rmch-nb-shell-test-"));
  try {
    // --- detection -----------------------------------------------------------
    const gameRoot = path.join(tempRoot, "重装机兵-宿敌_V3.5.3_电脑端");
    makeFakeNbGame(gameRoot);
    const scan = scanGame(gameRoot);
    assert.equal(scan.container, "nb-shell", "bootEncryptedBin + nbtool.node must label nb-shell");
    assert.equal(scan.engine.id, "MZ", "NB-shell games are MZ under the shell");
    assert.equal(scan.engine.confidence, "low");
    assert.ok(scan.protection.flags.includes("nb-shell-protected"), "flag must be set");
    assert.ok(scan.protection.flags.includes("disable-devtools"), "manifest flags still apply");
    assert.equal(scan.protection.level, 4, "the NB shell is the strongest protection tier");
    assert.equal(scan.title, "重装机兵-宿敌【测试】", "title comes from the manifest window");
    assert.ok(scan.paths.exe, "exe resolved for the game root");
    assert.equal(injectionStrategy(scan).id, "unsupported-nb-shell");

    // --- near misses ---------------------------------------------------------
    const noToolRoot = path.join(tempRoot, "NoTool");
    makeFakeNbGame(noToolRoot, { withTool: false });
    assert.notEqual(scanGame(noToolRoot).container, "nb-shell", "missing nbtool.node is not nb-shell");

    const noBootRoot = path.join(tempRoot, "NoBoot");
    makeFakeNbGame(noBootRoot, { bootCall: false });
    assert.notEqual(scanGame(noBootRoot).container, "nb-shell", "no bootEncryptedBin call is not nb-shell");

    // --- hard refusals (before any spawn/inject/IO) ---------------------------
    try {
      await launchGame({ gameRoot, projectRoot: tempRoot, port: 47417 });
      assert.fail("launchGame must refuse nb-shell games");
    } catch (error) {
      assert.match(error.message, /nb-shell/);
      assert.match(error.message, /refuses every launch flag/);
    }
    try {
      await attachGame({ gameRoot, projectRoot: tempRoot, port: 47417 });
      assert.fail("attachGame must refuse nb-shell games");
    } catch (error) {
      assert.ok(error instanceof AttachError, "attach refusal is an AttachError");
      assert.match(error.message, /force-exits the game/);
    }

    console.log("test-nb-shell: all checks ok");
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
