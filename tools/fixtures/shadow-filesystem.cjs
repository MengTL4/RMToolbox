const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Run in both CLI Node and the real GUI runtime: Node 24 alone misses the
// Node 26 recursive-rm junction regression. All targets are owned fixtures.
exports.checkShadowFilesystem = function ({
  setupShadowApp,
  setupBundledShadowApp
}) {
  const temp = fs.mkdtempSync(
    path.join(os.tmpdir(), "rmch-shadow-filesystem-")
  );
  function file(name, contents) {
    fs.mkdirSync(path.dirname(name), { recursive: true });
    fs.writeFileSync(name, contents);
  }
  function cleanup(name) {
    const stat = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) fs.unlinkSync(name);
    else if (stat.isDirectory()) {
      for (const child of fs.readdirSync(name)) cleanup(path.join(name, child));
      fs.rmdirSync(name);
    } else {
      fs.unlinkSync(name);
    }
  }
  try {
    for (const [kind, setup] of Object.entries({
      bg: setupShadowApp,
      bundled: setupBundledShadowApp
    })) {
      const game = path.join(temp, kind);
      const target = path.join(game, "nwr_modkit");
      const writable = path.join(target, "aaa-writable.dat");
      const readonly = path.join(target, "readonly.dat");
      const source = '(function () { var original = "KEEP"; }.call(this));';
      file(path.join(game, "Game.exe"), "fake");
      file(path.join(game, "package.json"), "{}");
      file(path.join(game, "www/js/engine.js"), source);
      file(path.join(game, "www/js/readonly.dat"), "keep sibling");
      file(writable, "keep writable");
      file(readonly, "keep readonly");
      fs.chmodSync(readonly, 0o444);
      fs.chmodSync(path.join(game, "www/js/readonly.dat"), 0o444);
      const readonlyMode = fs.statSync(
        path.join(game, "www/js/readonly.dat")
      ).mode;
      const options = {
        projectRoot: temp,
        gameKey: kind,
        scan: {
          root: game,
          layout: "www",
          manifest: { bgScript: "www/js/engine.js" },
          bundled: { scriptRel: "www/js/engine.js" }
        }
      };
      const { appDir } = setup(options);
      const verify = () => {
        assert.equal(fs.readFileSync(writable, "utf8"), "keep writable");
        assert.equal(fs.readFileSync(readonly, "utf8"), "keep readonly");
        assert.equal(
          fs.readFileSync(path.join(game, "www/js/engine.js"), "utf8"),
          source
        );
        assert.equal(
          fs.readFileSync(path.join(game, "www/js/readonly.dat"), "utf8"),
          "keep sibling"
        );
        assert.equal(
          fs.statSync(path.join(game, "www/js/readonly.dat")).mode,
          readonlyMode
        );
      };
      // The exact reported EPERM: rebuild a junction whose target has a
      // read-only file. Also catch silent removal of its writable siblings.
      setup(options);
      verify();
      // Old layouts can leave a REAL directory with nested junctions.
      const dest = path.join(appDir, "nwr_modkit");
      fs.unlinkSync(dest);
      fs.mkdirSync(dest);
      fs.symlinkSync(target, path.join(dest, "nested"), "junction");
      setup(options);
      verify();
      // Carving a patch path out of an old junction must only unlink it.
      cleanup(path.join(appDir, "www"));
      fs.symlinkSync(
        path.join(game, "www"),
        path.join(appDir, "www"),
        "junction"
      );
      setup(options);
      verify();
    }
  } finally {
    cleanup(temp);
  }
};
