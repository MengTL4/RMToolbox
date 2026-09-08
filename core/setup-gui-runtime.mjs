// Build-time only: install an official, hash-pinned GUI runtime. The runtime
// inside a target game is independent and must never be upgraded here.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";

export const GUI_EXE_NAME = "RMToolbox.exe";
const STAMP = ".nw-runtime.json";
const LEGACY = ["Game.exe", "nw.exe", "snapshot_blob.bin", "v8_context_snapshot.bin", "swiftshader", "Dictionaries",
  "nw.dll", "node.dll", "nw_elf.dll", "libEGL.dll", "libGLESv2.dll", "d3dcompiler_47.dll", "icudtl.dat",
  "resources.pak", "nw_100_percent.pak", "nw_200_percent.pak", "locales", "notification_helper.exe"];
const SOURCES = new Set(["package.json", "index.html", "host.cjs", "gui-bundle.cjs", "ui", "src", "vendor", "styles.css", "jsoneditor-theme.css", "icon.png"]);
const psString = value => "'" + String(value).replaceAll("'", "''") + "'";

export function assertBuildPath(root, target) {
  const base = path.resolve(root), resolved = path.resolve(target);
  const relative = path.relative(base, resolved);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error(`Build target outside workspace: ${resolved}`);
  let cursor = base;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Linked build target refused: ${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}

export function fileSha256(file) { return createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }

export function readRuntimeLock(projectRoot) {
  const lock = JSON.parse(fs.readFileSync(path.join(projectRoot, "nw-runtime.lock.json"), "utf8"));
  if (!/^\d+\.\d+\.\d+$/.test(lock.version) || !/^[a-f0-9]{64}$/.test(lock.sha256) || lock.platform !== "win-x64") throw new Error("Invalid NW runtime lock");
  if (lock.archive !== `nwjs-v${lock.version}-win-x64.zip` || lock.url !== `https://dl.nwjs.io/v${lock.version}/${lock.archive}`) throw new Error("Runtime must use the pinned official normal build");
  return lock;
}

function inventory(root, relative = "") {
  return fs.readdirSync(path.join(root, relative)).flatMap(name => {
    const rel = path.join(relative, name), file = path.join(root, rel);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`Runtime contains a link: ${file}`);
    return fs.statSync(file).isDirectory() ? inventory(root, rel) : [{ path: rel.split(path.sep).join("/"), sha256: fileSha256(file) }];
  });
}

export function verifyInstalledRuntime(guiDir, lock) {
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(guiDir, STAMP), "utf8"));
    return stamp.archiveSha256 === lock.sha256 && stamp.version === lock.version && stamp.files.length > 0
      && stamp.files.some(f => f.path === GUI_EXE_NAME) && stamp.files.some(f => f.path === "nw.dll")
      && stamp.files.every(file => fileSha256(assertBuildPath(guiDir, path.join(guiDir, file.path))) === file.sha256);
  } catch (_) { return false; }
}

export async function prepareRuntime(projectRoot) {
  const lock = readRuntimeLock(projectRoot);
  const cache = assertBuildPath(projectRoot, path.join(projectRoot, ".cache", "nwjs", lock.version));
  fs.mkdirSync(cache, { recursive: true });
  const archive = path.join(cache, lock.archive);
  if (!fs.existsSync(archive) || fileSha256(archive) !== lock.sha256) {
    console.log(`Downloading official NW.js ${lock.version} (${lock.platform})`);
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Runtime download failed: HTTP ${response.status}`);
    const temp = assertBuildPath(projectRoot, archive + ".download");
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temp));
    if (fileSha256(temp) !== lock.sha256) { fs.unlinkSync(temp); throw new Error("NW runtime SHA256 mismatch; installation stopped"); }
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
    fs.renameSync(temp, archive);
  }
  const unpack = assertBuildPath(projectRoot, path.join(cache, "unpacked"));
  fs.rmSync(unpack, { recursive: true, force: true });
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psString(archive)} -DestinationPath ${psString(unpack)}`], { windowsHide: true, stdio: "inherit" });
  const donor = path.join(unpack, lock.archive.replace(/\.zip$/, ""));
  const exe = fs.readFileSync(path.join(donor, "nw.exe"));
  if (exe.readUInt16LE(exe.readUInt32LE(60) + 4) !== 0x8664 || !fs.existsSync(path.join(donor, "nw.dll"))) throw new Error("Runtime is not a complete x64 NW build");
  return { lock, donor };
}

export async function setupGuiRuntime({ projectRoot, guiDir = path.join(projectRoot, "app", "gui"), force = false } = {}) {
  const lock = readRuntimeLock(projectRoot);
  assertBuildPath(projectRoot, guiDir);
  if (!force && verifyInstalledRuntime(guiDir, lock)) return { version: lock.version, guiDir, reused: true };
  const prepared = await prepareRuntime(projectRoot);
  const entries = fs.readdirSync(prepared.donor);
  if (entries.some(name => SOURCES.has(name))) throw new Error("Official runtime conflicts with GUI source files");
  let old = [];
  if (fs.existsSync(path.join(guiDir, STAMP))) {
    try { old = JSON.parse(fs.readFileSync(path.join(guiDir, STAMP), "utf8")).files.map(f => f.path.split("/")[0]); }
    catch (_) { throw new Error('Invalid installed runtime manifest; refusing cleanup'); }
  }
  const targets = [...new Set([...LEGACY, ...old, ...entries, GUI_EXE_NAME])].map(name => {
    if (!name || name === '.' || name === '..' || /[\\/\\\\:]/.test(name)) throw new Error(`Invalid runtime entry: ${name}`);
    if (SOURCES.has(name)) throw new Error(`Refusing to replace GUI source: ${name}`);
    // Older setup made donor directory junctions. Unlink the leaf itself only;
    // the parent GUI path was checked above and must never be a junction.
    return path.join(guiDir, name);
  });
  fs.mkdirSync(guiDir, { recursive: true });
  for (const target of targets) {
    let linked = false;
    try { linked = fs.lstatSync(target).isSymbolicLink(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (linked) fs.unlinkSync(target);
    else { assertBuildPath(projectRoot, target); fs.rmSync(target, { recursive: true, force: true }); }
  }
  for (const name of entries) fs.cpSync(path.join(prepared.donor, name), path.join(guiDir, name === "nw.exe" ? GUI_EXE_NAME : name), { recursive: true });
  const files = inventory(prepared.donor).map(f => ({ ...f, path: f.path === "nw.exe" ? GUI_EXE_NAME : f.path }));
  fs.writeFileSync(path.join(guiDir, STAMP), JSON.stringify({ version: lock.version, archiveSha256: lock.sha256, files }, null, 2) + "\n");
  return { version: lock.version, guiDir, reused: false, files: files.length };
}
