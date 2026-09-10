import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertBuildPath,
  readRuntimeLock,
  fileSha256,
  verifyInstalledRuntime,
  setupGuiRuntime
} from "../core/setup-gui-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rmch-runtime-setup-"));
const originalFetch = globalThis.fetch;
try {
  const lock = readRuntimeLock(root);
  fs.writeFileSync(
    path.join(temp, "nw-runtime.lock.json"),
    JSON.stringify(lock)
  );
  const gui = path.join(temp, "app/gui");
  fs.mkdirSync(gui, { recursive: true });
  fs.writeFileSync(path.join(gui, "index.html"), "keep GUI sources");
  assert.throws(() => assertBuildPath(temp, temp), /outside workspace/);
  assert.throws(
    () => assertBuildPath(temp, path.join(temp, "../outside")),
    /outside workspace/
  );
  const link = path.join(temp, "linked");
  fs.symlinkSync(gui, link, "junction");
  assert.throws(
    () => assertBuildPath(temp, path.join(link, "child")),
    /Linked build target/
  );
  fs.unlinkSync(link);

  // Reject corrupted downloads before replacing anything already installed.
  globalThis.fetch = async () => new Response("not the pinned archive");
  await assert.rejects(
    setupGuiRuntime({ projectRoot: temp }),
    /SHA256 mismatch/
  );
  assert.equal(
    fs.readFileSync(path.join(gui, "index.html"), "utf8"),
    "keep GUI sources"
  );
  assert.equal(fs.existsSync(path.join(gui, "RMToolbox.exe")), false);

  for (const name of ["RMToolbox.exe", "nw.dll"])
    fs.writeFileSync(path.join(gui, name), name);
  const stamp = {
    version: lock.version,
    archiveSha256: lock.sha256,
    files: ["RMToolbox.exe", "nw.dll"].map((name) => ({
      path: name,
      sha256: fileSha256(path.join(gui, name))
    }))
  };
  fs.writeFileSync(path.join(gui, ".nw-runtime.json"), JSON.stringify(stamp));
  assert.equal(verifyInstalledRuntime(gui, lock), true);
  globalThis.fetch = async () => {
    throw new Error("A valid installation must not download again");
  };
  assert.equal((await setupGuiRuntime({ projectRoot: temp })).reused, true);
  fs.appendFileSync(path.join(gui, "nw.dll"), "changed");
  assert.equal(verifyInstalledRuntime(gui, lock), false);
  stamp.files[1].path = "../../../outside";
  fs.writeFileSync(path.join(gui, ".nw-runtime.json"), JSON.stringify(stamp));
  assert.equal(verifyInstalledRuntime(gui, lock), false);
  fs.writeFileSync(
    path.join(temp, "nw-runtime.lock.json"),
    JSON.stringify({ ...lock, url: "https://example.com/donor.zip" })
  );
  assert.throws(() => readRuntimeLock(temp), /official normal build/);
  console.log(
    "runtime setup PASS: path containment, linked paths, checksum rejection, reuse and tamper detection"
  );
} finally {
  globalThis.fetch = originalFetch;
  if (
    !fs.lstatSync(temp).isSymbolicLink() &&
    path.dirname(temp) === path.resolve(os.tmpdir())
  )
    fs.rmSync(temp, { recursive: true, force: true });
}
