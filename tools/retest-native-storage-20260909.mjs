import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { getToken } from "../core/token.mjs";
import { createSaveFiles } from "../core/save-files.mjs";
const session = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const storage = process.argv.includes("--webstorage") ? "webstorage" : "native";
const exportCommand = "save." + storage + ".export";
const socket = new WebSocket(
  `ws://127.0.0.1:${session.port}/client?token=${encodeURIComponent(getToken(session.projectRoot))}`
);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let serial = 0;
const pending = new Map();
socket.onmessage = (e) => {
  const r = JSON.parse(String(e.data));
  const p = pending.get(r.id);
  if (r.t === "result" && p) {
    pending.delete(r.id);
    clearTimeout(p.timer);
    r.ok ? p.resolve(r.payload) : p.reject(Error(r.error));
  }
};
const send = (type, args = {}) =>
  new Promise((resolve, reject) => {
    const id = "storage-" + ++serial;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("timeout " + type));
    }, 35000);
    pending.set(id, { resolve, reject, timer });
    socket.send(
      JSON.stringify({ t: "send", id, gameKey: session.gameKey, type, args })
    );
  });
try {
  const fixtureState = {
    projectRoot: session.projectRoot,
    modules: { saveFiles: { createSaveFiles } },
    sessions: {
      list: () => [
        {
          gameKey: session.gameKey,
          alive: true,
          state: { saveStorage: storage }
        }
      ],
      send: (_key, type, args) => send(type, args)
    }
  };
  const sandbox = {
    module: {},
    require: createRequire(import.meta.url),
    fixtureState
  };
  vm.runInNewContext(
    fs.readFileSync("app/gui/host.cjs", "utf8") +
      "\nObject.assign(state,fixtureState);",
    sandbox
  );
  const host = sandbox.module.exports;
  const before = await send(exportCommand);
  const backup = await host.backupSaves(session.gameKey);
  const name = path.basename(backup.destDir);
  assert.equal(
    host.listBackups(session.gameKey).find((x) => x.name === name).storage,
    storage
  );
  await host.restoreBackup(session.gameKey, name);
  const after = await send(exportCommand);
  assert.deepEqual(after.entries, before.entries);
  console.log(
    "PASS native GUI host backup/list/restore exact contents",
    JSON.stringify({ files: backup.files, destDir: backup.destDir })
  );
  host.deleteBackup(session.gameKey, name);
  assert.ok(!host.listBackups(session.gameKey).some((x) => x.name === name));
  console.log("PASS delete toolbox-owned backup");
} finally {
  socket.close();
}
