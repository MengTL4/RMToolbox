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
import { scanGame } from "../core/scanner.mjs";
import { planLaunch } from "../core/launch-plan.mjs";
import { launchGame } from "../core/launcher.mjs";
import { attachGame, AttachError } from "../core/attach.mjs";

function makeFakeNbGame(root, { withTool = true, bootCall = true } = {}) {
  mkdirSync(path.join(root, "nb_data"), { recursive: true });
  mkdirSync(path.join(root, "img", "animations"), { recursive: true });
  mkdirSync(path.join(root, "audio", "bgm"), { recursive: true });
  if (withTool) {
    // Stand-in for the 5.6MB Themida-packed addon: content is irrelevant, the
    // scanner only checks existence.
    writeFileSync(
      path.join(root, "nb_data", "nbtool.node"),
      "MZ fake nbtool node addon"
    );
  }
  const boot = bootCall
    ? 'require("./nb_data/nbtool.node").bootEncryptedBin();'
    : "console.log('plain page');";
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

// The evalNWBin variant (万族穿越-源启崛起): hashed-name .node addon + hashed
// extensionless engine blob in nb_data/, obfuscated index.html (no plaintext
// boot call), no nbtool.node.
function makeFakeNbEvalNwBinGame(root) {
  mkdirSync(path.join(root, "nb_data"), { recursive: true });
  writeFileSync(
    path.join(root, "nb_data", "8bc38d774d3c0a3c2b67177c512ccffa.node"),
    "MZ fake hashed addon"
  );
  writeFileSync(
    path.join(root, "nb_data", "981e939328ec49d3af7b7a01b4e106a4"),
    "fake v8 bytecode blob"
  );
  writeFileSync(
    path.join(root, "nb_data", "011dc36ebfd76d8d5c34c5b95617b91a.json"),
    "xzuOQt3KmTVxcfBk"
  ); // ciphertext
  writeFileSync(
    path.join(root, "index.html"),
    "<!doctype html><html><body><script>var _0xodz='nobi';/* obfuscated */</script></body></html>"
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "1",
      main: "index.html",
      window: { title: "万族穿越【测试】" },
      "chromium-args": "--disable-devtools"
    })
  );
  writeFileSync(path.join(root, "万族穿越.exe"), "MZ fake nw.js game exe");
}

async function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rmch-nb-shell-test-"));
  try {
    // --- detection -----------------------------------------------------------
    const gameRoot = path.join(tempRoot, "重装机兵-宿敌_V3.5.3_电脑端");
    makeFakeNbGame(gameRoot);
    const scan = scanGame(gameRoot);
    assert.equal(
      scan.container,
      "nb-shell",
      "bootEncryptedBin + nbtool.node must label nb-shell"
    );
    assert.equal(scan.engine.id, "MZ", "NB-shell games are MZ under the shell");
    assert.equal(scan.engine.confidence, "low");
    assert.ok(
      scan.protection.flags.includes("nb-shell-protected"),
      "flag must be set"
    );
    assert.ok(
      scan.protection.flags.includes("disable-devtools"),
      "manifest flags still apply"
    );
    assert.equal(
      scan.protection.level,
      4,
      "the NB shell is the strongest protection tier"
    );
    assert.equal(
      scan.title,
      "重装机兵-宿敌【测试】",
      "title comes from the manifest window"
    );
    assert.ok(scan.paths.exe, "exe resolved for the game root");
    assert.equal(
      planLaunch(scan).family,
      "unsupported-shell",
      "no route survives an NB shell"
    );
    assert.equal(planLaunch(scan).selected, null);

    // --- near misses ---------------------------------------------------------
    const noToolRoot = path.join(tempRoot, "NoTool");
    makeFakeNbGame(noToolRoot, { withTool: false });
    assert.notEqual(
      scanGame(noToolRoot).container,
      "nb-shell",
      "missing nbtool.node is not nb-shell"
    );

    const noBootRoot = path.join(tempRoot, "NoBoot");
    makeFakeNbGame(noBootRoot, { bootCall: false });
    assert.notEqual(
      scanGame(noBootRoot).container,
      "nb-shell",
      "no bootEncryptedBin call is not nb-shell"
    );

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
      assert.ok(
        error instanceof AttachError,
        "attach refusal is an AttachError"
      );
      assert.match(error.message, /force-exits the game/);
    }

    // --- evalNWBin variant -----------------------------------------------------
    const evalRoot = path.join(tempRoot, "_V1.2.2_B电脑端【测试】");
    makeFakeNbEvalNwBinGame(evalRoot);
    const evalScan = scanGame(evalRoot);
    assert.equal(
      evalScan.container,
      "nb-evalnwbin",
      "hashed .node + hashed blob must label nb-evalnwbin"
    );
    assert.equal(
      evalScan.engine.id,
      "MV/MZ",
      "engine is undecidable from the outside"
    );
    assert.ok(
      evalScan.protection.flags.includes("nb-evalnwbin-shell"),
      "flag must be set"
    );
    assert.equal(evalScan.protection.level, 3, "attach-only shell tier");
    assert.ok(evalScan.paths.exe, "exe resolved via the single-exe fallback");
    assert.equal(
      planLaunch(evalScan).selected,
      "dll",
      "evalNWBin tolerates only the native route"
    );

    // nbtool.node present → stays the Themida variant, never evalnwbin.
    const bothRoot = path.join(tempRoot, "BothMarkers");
    makeFakeNbEvalNwBinGame(bothRoot);
    writeFileSync(
      path.join(bothRoot, "nb_data", "nbtool.node"),
      "MZ fake nbtool node addon"
    );
    assert.notEqual(
      scanGame(bothRoot).container,
      "nb-evalnwbin",
      "nbtool.node must not fall to evalnwbin"
    );

    // launchGame must refuse the (fatal) extension launch path; attach with no
    // running game must fail BEFORE injecting anything.
    try {
      await launchGame({
        gameRoot: evalRoot,
        projectRoot: tempRoot,
        port: 47417
      });
      assert.fail("launchGame must refuse the extension path for nb-evalnwbin");
    } catch (error) {
      assert.match(error.message, /nb-evalnwbin/);
      assert.match(error.message, /refuses every launch flag/);
    }
    try {
      await attachGame({
        gameRoot: evalRoot,
        projectRoot: tempRoot,
        port: 47417
      });
      assert.fail("attachGame without a running game must fail");
    } catch (error) {
      assert.ok(
        error instanceof AttachError,
        "attach failure is an AttachError"
      );
      assert.match(error.message, /no running/);
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
