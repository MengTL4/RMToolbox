// Real temporary files only. No game launch, bridge connection, or user saves.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import vm from "node:vm";
import {
  createSaveFiles,
  reconcileRgssSaves,
  recordRgssSaveLocation
} from "../core/save-files.mjs";
import { renderBridgeSource } from "../core/rgss.mjs";
import { requireRuby, runRubyFixture } from "./lib/ruby-fixture.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rmch-save-files-"));
let passed = 0;
const write = (file, data, time = 100000) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  fs.utimesSync(file, time, time);
};
const read = (file) => fs.readFileSync(file, "utf8");
function fixture(name, rel = "") {
  const projectRoot = path.join(root, name),
    gameRoot = path.join(projectRoot, "game");
  const shadowRoot = path.join(projectRoot, "runtime", "rgss-shadow", "game");
  const saveDir = path.join(gameRoot, rel);
  fs.mkdirSync(saveDir, { recursive: true });
  fs.mkdirSync(shadowRoot, { recursive: true });
  const saveLocation = {
    gameRoot,
    saveDir,
    files: ["存档1.rxdata", "自动保存1.rxdata", "custom.rxdata"]
  };
  const store = createSaveFiles({
    projectRoot,
    resolveLocation: () => ({ saveDir, saveLocation })
  });
  const sync = (options) =>
    reconcileRgssSaves({ gameRoot, shadowRoot, saveLocation, ...options });
  return {
    projectRoot,
    gameRoot,
    shadowRoot,
    saveDir,
    saveLocation,
    store,
    sync
  };
}
function test(name, run) {
  const result = run();
  const report = () => {
    passed++;
    console.log(`ok ${name}`);
  };
  if (result && typeof result.then === "function") return result.then(report);
  report();
}

try {
  test("distinct files remain distinct when Number inode IDs lose precision", () => {
    const f = fixture("large-inodes");
    const real = path.join(f.gameRoot, "Save1.rxdata"),
      shadow = path.join(f.shadowRoot, "Save1.rxdata");
    write(real, "real", 100000);
    write(shadow, "copy", 200000);
    const actualStat = fs.statSync;
    // NTFS allocates 64-bit IDs we cannot prescribe. Simulate only the lossy
    // Number view; BigInt identities and every actual file operation stay real.
    fs.statSync = (file, options) => {
      const info = actualStat(file, options);
      if (!options || !options.bigint) info.ino = 28428972648641876;
      return info;
    };
    try {
      const result = f.sync();
      assert.equal(result.errors.length, 0);
      assert.equal(read(real), "copy");
      write(real, "real", 300000);
      write(shadow, "copy", 300000);
      assert.equal(
        f.sync().conflicts.length,
        1,
        "lossy IDs must not hide equal-time conflicts"
      );
    } finally {
      fs.statSync = actualStat;
    }
  });
  test("newer timestamp wins regardless of size; equal-time conflicts retain real", () => {
    for (const [
      label,
      realData,
      shadowData,
      realTime,
      shadowTime,
      expected
    ] of [
      ["real-different-size", "new-real", "old", 200000, 100000, "new-real"],
      ["real-same-size", "real", "copy", 200000, 100000, "real"],
      [
        "shadow-different-size",
        "old",
        "new-shadow",
        100000,
        200000,
        "new-shadow"
      ],
      ["shadow-same-size", "real", "copy", 100000, 200000, "copy"]
    ]) {
      const f = fixture(label);
      write(path.join(f.gameRoot, "Save1.rxdata"), realData, realTime);
      write(path.join(f.shadowRoot, "Save1.rxdata"), shadowData, shadowTime);
      assert.equal(f.sync().errors.length, 0);
      assert.equal(
        read(path.join(f.gameRoot, "Save1.rxdata")),
        expected,
        `${label}: ${JSON.stringify(
          [f.gameRoot, f.shadowRoot].map((dir) => {
            const file = path.join(dir, "Save1.rxdata");
            const info = fs.statSync(file),
              exact = fs.statSync(file, { bigint: true });
            return {
              ino: info.ino,
              exactIno: String(exact.ino),
              mtime: info.mtimeMs,
              size: info.size
            };
          })
        )}`
      );
    }
    const f = fixture("equal");
    write(path.join(f.gameRoot, "Save1.rxdata"), "real");
    write(path.join(f.shadowRoot, "Save1.rxdata"), "copy");
    const result = f.sync();
    assert.equal(result.conflicts.length, 1);
    assert.equal(read(path.join(f.gameRoot, "Save1.rxdata")), "real");
    write(path.join(f.shadowRoot, "Save1.rxdata"), "real");
    assert.equal(f.sync().conflicts.length, 0);
  });

  test("Unicode backup/restore merge coordinates shadow and survives recovery", () => {
    const f = fixture("restore", "Save");
    write(path.join(f.saveDir, "存档1.rxdata"), "backup-value");
    write(path.join(f.saveDir, "Game.exe"), "do-not-back-up");
    fs.mkdirSync(path.join(f.saveDir, "directory.rxdata"));
    const backup = f.store.backup("game");
    assert.equal(backup.files, 1);
    assert.notEqual(f.store.backup("game").destDir, backup.destDir);
    write(path.join(f.saveDir, "存档1.rxdata"), "changed-real", 200000);
    write(path.join(f.saveDir, "extra.rxdata"), "keep-extra");
    write(
      path.join(f.shadowRoot, "Save", "存档1.rxdata"),
      "stale-shadow-longer",
      300000
    );
    const name = path.basename(backup.destDir);
    assert.equal(f.store.restore("game", name).restored, 1);
    assert.equal(
      read(path.join(f.shadowRoot, "Save", "存档1.rxdata")),
      "backup-value"
    );
    f.sync({ removeSynced: true });
    assert.equal(read(path.join(f.saveDir, "存档1.rxdata")), "backup-value");
    assert.equal(read(path.join(f.saveDir, "extra.rxdata")), "keep-extra");
    assert.equal(f.store.listBackups("game").length, 2);
    f.store.deleteBackup("game", name);
    assert.equal(f.store.listBackups("game").length, 1);
  });

  test("delete removes only corresponding shadow file; subsequent new game save is valid", () => {
    const f = fixture("delete", "Save");
    write(path.join(f.saveDir, "存档1.rxdata"), "real");
    write(path.join(f.shadowRoot, "Save", "存档1.rxdata"), "copy");
    write(path.join(f.shadowRoot, "Other", "存档1.rxdata"), "unrelated");
    f.store.deleteSave("game", "存档1.rxdata");
    f.sync({ removeSynced: true });
    f.sync();
    assert.equal(fs.existsSync(path.join(f.saveDir, "存档1.rxdata")), false);
    assert.equal(
      read(path.join(f.shadowRoot, "Other", "存档1.rxdata")),
      "unrelated"
    );
    write(
      path.join(f.shadowRoot, "Save", "存档1.rxdata"),
      "new-game-save",
      400000
    );
    f.sync();
    assert.equal(read(path.join(f.saveDir, "存档1.rxdata")), "new-game-save");
  });

  test("offline metadata recovers custom names and never extension-scans Data", () => {
    const f = fixture("offline", "Save");
    recordRgssSaveLocation(f.shadowRoot, f.saveLocation);
    write(path.join(f.shadowRoot, "Save", "存档1.rxdata"), "custom");
    write(path.join(f.shadowRoot, "Data", "Scripts.rxdata"), "patched-script");
    write(path.join(f.shadowRoot, "Data", "Actors.rxdata"), "database");
    write(path.join(f.shadowRoot, "Save99.rxdata"), "vanilla");
    const result = reconcileRgssSaves({
      gameRoot: f.gameRoot,
      shadowRoot: f.shadowRoot
    });
    assert.equal(result.copied, 2);
    assert.equal(
      fs.existsSync(path.join(f.gameRoot, "Data", "Scripts.rxdata")),
      false
    );
    const offline = createSaveFiles({
      projectRoot: f.projectRoot,
      resolveLocation: () => f.saveDir
    });
    offline.deleteSave("game", "存档1.rxdata");
    assert.equal(
      fs.existsSync(path.join(f.shadowRoot, "Save", "存档1.rxdata")),
      false
    );
    const legacy = fixture("legacy");
    write(path.join(legacy.shadowRoot, "存档1.rxdata"), "unknown");
    write(path.join(legacy.shadowRoot, "SaveData", "Save3.rvdata2"), "known");
    assert.equal(
      reconcileRgssSaves({
        gameRoot: legacy.gameRoot,
        shadowRoot: legacy.shadowRoot
      }).copied,
      1
    );
  });

  test("hardlinks and junctions preserve real files during cleanup and restoration", () => {
    const f = fixture("links", "Save");
    const target = path.join(f.gameRoot, "Save1.rxdata");
    write(target, "hardlinked");
    fs.linkSync(target, path.join(f.shadowRoot, "Save1.rxdata"));
    fs.symlinkSync(f.saveDir, path.join(f.shadowRoot, "Save"), "junction");
    write(path.join(f.saveDir, "存档1.rxdata"), "junction-value");
    f.sync({ removeSynced: true });
    assert.equal(read(target), "hardlinked");
    assert.equal(read(path.join(f.saveDir, "存档1.rxdata")), "junction-value");
    const backup = f.store.backup("game");
    f.store.restore("game", path.basename(backup.destDir));
    assert.equal(read(path.join(f.saveDir, "存档1.rxdata")), "junction-value");
    f.store.deleteSave("game", "存档1.rxdata");
    assert.equal(fs.existsSync(path.join(f.saveDir, "存档1.rxdata")), false);
    const rootStore = createSaveFiles({
      projectRoot: f.projectRoot,
      resolveLocation: () => ({ saveDir: f.gameRoot, gameRoot: f.gameRoot })
    });
    fs.linkSync(target, path.join(f.shadowRoot, "Save1.rxdata"));
    rootStore.deleteSave("game", "Save1.rxdata");
    assert.equal(fs.existsSync(target), false);
    assert.equal(fs.existsSync(path.join(f.shadowRoot, "Save1.rxdata")), false);
  });

  test("failed recovery retains source and reports error; paths cannot escape", () => {
    const f = fixture("errors");
    write(path.join(f.shadowRoot, "Save1.rxdata"), "recover-me");
    fs.mkdirSync(path.join(f.gameRoot, "Save1.rxdata"));
    assert.equal(f.sync({ removeSynced: true }).errors.length, 1);
    assert.equal(read(path.join(f.shadowRoot, "Save1.rxdata")), "recover-me");
    for (const name of [
      "../escape.rxdata",
      "..\\escape.rxdata",
      "C:\\outside.rxdata",
      "file:stream.rxdata",
      "Game.exe"
    ]) {
      assert.throws(() => f.store.deleteSave("game", name), /bad file name/);
    }
    for (const name of ["../outside", "..\\outside", "C:\\outside"]) {
      assert.throws(() => f.store.restore("game", name), /bad backup name/);
      assert.throws(
        () => f.store.deleteBackup("game", name),
        /bad backup name/
      );
    }
  });
  test("legacy known subdirectory deletion and hardlink restore do not resurrect saves", () => {
    const f = fixture("legacy-directory", "SaveData");
    const store = createSaveFiles({
      projectRoot: f.projectRoot,
      resolveLocation: () => ({ saveDir: f.saveDir, gameRoot: f.gameRoot })
    });
    const real = path.join(f.saveDir, "Save3.rvdata2"),
      shadow = path.join(f.shadowRoot, "SaveData", "Save3.rvdata2");
    write(real, "backup");
    fs.mkdirSync(path.dirname(shadow), { recursive: true });
    fs.linkSync(real, shadow);
    const backup = store.backup("game");
    write(real, "changed");
    store.restore("game", path.basename(backup.destDir));
    assert.equal(read(real), "backup");
    assert.equal(read(shadow), "backup");
    store.deleteSave("game", "Save3.rvdata2");
    reconcileRgssSaves({ gameRoot: f.gameRoot, shadowRoot: f.shadowRoot });
    assert.equal(fs.existsSync(real), false);
  });

  test("unknown live directory cannot coordinate a same-name historical root save", () => {
    const f = fixture("unknown-live", "CustomSave");
    const real = path.join(f.saveDir, "Save1.rxdata"),
      historical = path.join(f.shadowRoot, "Save1.rxdata");
    write(real, "current-game");
    write(historical, "unrelated-root-save");
    const store = createSaveFiles({
      projectRoot: f.projectRoot,
      resolveLocation: () => ({ saveDir: f.saveDir })
    });
    const backup = store.backup("game");
    write(real, "changed");
    store.restore("game", path.basename(backup.destDir));
    assert.equal(read(real), "current-game");
    assert.equal(read(historical), "unrelated-root-save");
    store.deleteSave("game", "Save1.rxdata");
    assert.equal(read(historical), "unrelated-root-save");
    const plain = createSaveFiles({
      projectRoot: f.projectRoot,
      resolveLocation: () => f.saveDir
    });
    write(real, "plain-directory");
    plain.deleteSave("game", "Save1.rxdata");
    assert.equal(read(historical), "unrelated-root-save");
  });

  test("live attach coordinates only mapped historical copies and ignores older layouts", () => {
    const f = fixture("attached-live", "CustomSave");
    const real = path.join(f.saveDir, "存档1.rxdata");
    const corresponding = path.join(f.shadowRoot, "CustomSave", "存档1.rxdata");
    const previousLayout = path.join(f.shadowRoot, "OldSave", "存档1.rxdata");
    write(real, "current");
    write(corresponding, "stale-corresponding");
    write(previousLayout, "different-layout");
    recordRgssSaveLocation(f.shadowRoot, {
      ...f.saveLocation,
      saveDir: path.join(f.gameRoot, "OldSave")
    });
    // The active bridge's explicit location takes precedence over old metadata.
    const backup = f.store.backup("game");
    f.store.restore("game", path.basename(backup.destDir));
    assert.equal(read(corresponding), "current");
    assert.equal(read(previousLayout), "different-layout");
    f.store.deleteSave("game", "存档1.rxdata");
    assert.equal(fs.existsSync(corresponding), false);
    assert.equal(read(previousLayout), "different-layout");
  });

  await test("host keeps old bridge saveDir priority while supplementing the library game root", async () => {
    const f = fixture("host-old-bridge", "CustomSave");
    const real = path.join(f.saveDir, "Save1.rxdata"),
      corresponding = path.join(f.shadowRoot, "CustomSave", "Save1.rxdata");
    write(real, "live-directory");
    write(corresponding, "stale");
    write(path.join(f.shadowRoot, "Save1.rxdata"), "root-unrelated");
    const hostSource = fs.readFileSync(
      new URL("../app/gui/host.cjs", import.meta.url),
      "utf8"
    );
    const fixtureState = {
      projectRoot: f.projectRoot,
      sessions: {
        list: () => [{ gameKey: "game", state: { saveDir: f.saveDir } }]
      },
      library: { manualRoots: [f.gameRoot] },
      modules: {
        saveFiles: { createSaveFiles },
        scanner: {
          findSteamLibraries() {
            throw new Error("unavailable Steam library");
          },
          scanGame: () => ({
            gameKey: "game",
            root: f.gameRoot,
            paths: { saveDir: f.gameRoot }
          })
        }
      }
    };
    const sandbox = {
      module: {},
      require: createRequire(import.meta.url),
      fixtureState
    };
    vm.runInNewContext(
      hostSource + "\nObject.assign(state, fixtureState);",
      sandbox
    );
    const host = sandbox.module.exports;
    assert.equal(host.saveDirOf("game"), f.saveDir);
    const backup = await host.backupSaves("game");
    assert.equal(backup.files, 1);
    await host.deleteSaveFile("game", "Save1.rxdata");
    assert.equal(fs.existsSync(corresponding), false);
    assert.equal(
      read(path.join(f.shadowRoot, "Save1.rxdata")),
      "root-unrelated"
    );
  });

  // The Essentials save write-through needs a Ruby interpreter; requireRuby
  // fails loudly instead of skipping, so a Ruby-less run cannot report green
  // without having exercised the RGSS path.
  const rubyCommand = requireRuby("Ruby save fixture");
  if (rubyCommand)
    test("Ruby bridge reports dynamic slot metadata and writes Essentials saves through", () => {
      const f = fixture("ruby", "Save");
      const bridge = renderBridgeSource(
        fs.readFileSync(
          new URL("../runtime/rgss-bridge/bridge.rb", import.meta.url),
          "utf8"
        ),
        {
          port: 0,
          token: "",
          gameKey: "fixture",
          realDir: f.gameRoot.replaceAll("\\", "/"),
          engine: "RGSS3"
        }
      );
      const script = path.join(f.projectRoot, "fixture.rb");
      fs.writeFileSync(
        script,
        bridge +
          `
module DataManager
  def self.savefile_max; 2; end
  def self.make_filename(index); "Save/Slot" + index.to_s + ".rvdata2"; end
end
raise "RGSS custom filenames missing" unless RMCH.save_location["files"] == ["Slot0.rvdata2", "Slot1.rvdata2"]
module DataManager
  def self.savefile_max; 3; end
end
raise "late slot change ignored" unless RMCH.save_location["files"].length == 3
module RMCH
  class << self
    def essentials?; true; end
    def ess_slots; ["存档1", "自动保存1"]; end
    def ess_save_path(slot); "./Save/" + slot + ".rxdata"; end
    def ess_slot_for(id); ess_slots[id - 1]; end
    def ess_player!; true; end
  end
end
module Game
  def self.save(slot)
    Dir.mkdir("Save") unless File.directory?("Save")
    File.open("Save/" + slot + ".rxdata", "wb") { |file| file.write("ess-save") }
    true
  end
end
raise "Essentials names missing" unless RMCH.save_location["files"] == ["存档1.rxdata", "自动保存1.rxdata"]
RMCH.ess_save_save(1)
puts "ruby save fixture passed"
`
      );
      // cwd is the shadow root: the fixture writes its saves relative to it.
      runRubyFixture(rubyCommand, [script], "Ruby save fixture", {
        cwd: f.shadowRoot
      });
      assert.equal(read(path.join(f.saveDir, "存档1.rxdata")), "ess-save");
    });
  console.log(`${passed} save file fixture groups passed`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
