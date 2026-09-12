const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

exports.checkRgssShadowRebuild = async function (launchRgssGame) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rmch-rgss-rebuild-"));
  const source = path.join(temp, "source");
  const shadow = path.join(temp, "runtime/rgss-shadow/game");
  function cleanup(name) {
    const stat = fs.lstatSync(name, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) fs.unlinkSync(name);
    else {
      for (const child of fs.readdirSync(name)) cleanup(path.join(name, child));
      fs.rmdirSync(name);
    }
  }
  try {
    fs.mkdirSync(shadow, { recursive: true });
    for (const dir of ["Graphics", "Audio"]) {
      fs.mkdirSync(path.join(source, dir), { recursive: true });
      fs.writeFileSync(
        path.join(source, dir, "resource.dat"),
        "original resource"
      );
      fs.symlinkSync(
        path.join(source, dir),
        path.join(shadow, dir),
        "junction"
      );
    }
    // Exercise the real launch-time cleanup, then stop at detection before any
    // game is spawned. A Node 26 recursive rm empties both original directories.
    await assert.rejects(
      launchRgssGame({ gameRoot: source, projectRoot: temp, gameKey: "game" }),
      /not an RGSS game/
    );
    for (const dir of ["Graphics", "Audio"])
      assert.equal(
        fs.readFileSync(path.join(source, dir, "resource.dat"), "utf8"),
        "original resource"
      );
  } finally {
    cleanup(temp);
  }
};
