// Filesystem rules shared by GUI save management and RGSS shadow recovery.
// Engine slot parsing stays in the bridge; only explicitly reported custom
// names are recovered outside the conservative vanilla SaveN convention.
import fs from "node:fs";
import path from "node:path";

const SAVE_EXT = /\.(rpgsave|rmmzsave|rxdata|rvdata|rvdata2)$/i;
const VANILLA = /^save\d+\.(rxdata|rvdata|rvdata2)$/i;
const LOCATION_FILE = ".rmch-save-location.json";

function basename(value, label = "file name") {
  const name = String(value || "");
  if (
    !name ||
    name === "." ||
    name.includes("..") ||
    /[\\/:\x00-\x1f]/.test(name) ||
    path.basename(name) !== name
  ) {
    throw new Error(`bad ${label}: ${value}`);
  }
  return name;
}

function stat(file, options) {
  try {
    return fs.statSync(file, options);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function sameFile(a, b) {
  // NTFS file IDs can exceed Number's exact integer range. Rounded ino values
  // can make unrelated files look hardlinked and silently skip a needed copy.
  const left = stat(a, { bigint: true }),
    right = stat(b, { bigint: true });
  return !!(
    left &&
    right &&
    left.ino &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function sameDirectory(a, b) {
  return (
    fs.existsSync(a) &&
    fs.existsSync(b) &&
    fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase()
  );
}

function copy(source, target, preserveTime = true) {
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink())
    throw new Error(`refusing to overwrite a file link: ${target}`);
  if (sameFile(source, target)) return;
  const info = fs.statSync(source);
  // Reading first also protects hardlink aliases on runtimes with unusual IDs.
  const bytes = fs.readFileSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  if (preserveTime) fs.utimesSync(target, info.atime, info.mtime);
}

function relativeInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    return null;
  return rel;
}

function validLocation(value, gameRoot) {
  if (
    !value ||
    typeof value.gameRoot !== "string" ||
    typeof value.saveDir !== "string"
  )
    return null;
  if (
    gameRoot &&
    path.resolve(value.gameRoot).toLowerCase() !==
      path.resolve(gameRoot).toLowerCase()
  )
    return null;
  const rel = relativeInside(value.gameRoot, value.saveDir);
  if (rel === null) return null;
  const files = Array.isArray(value.files)
    ? value.files.filter((name) => {
        try {
          return basename(name) === name && SAVE_EXT.test(name);
        } catch (_) {
          return false;
        }
      })
    : [];
  return {
    gameRoot: path.resolve(value.gameRoot),
    saveDir: path.resolve(value.saveDir),
    files,
    rel
  };
}

function readLocation(shadowRoot, gameRoot) {
  try {
    return validLocation(
      JSON.parse(fs.readFileSync(path.join(shadowRoot, LOCATION_FILE), "utf8")),
      gameRoot
    );
  } catch (_) {
    return null;
  }
}

export function recordRgssSaveLocation(shadowRoot, location) {
  const valid = validLocation(location);
  if (!valid) return;
  const target = path.join(shadowRoot, LOCATION_FILE);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(valid));
  fs.renameSync(`${target}.tmp`, target);
}

function independentDirectory(root, rel) {
  // Do not cross any junction on the way to an apparent independent directory.
  let current = root;
  for (const part of ["", ...rel.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    if (!fs.existsSync(current)) continue;
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
  }
  return true;
}

export function reconcileRgssSaves({
  gameRoot,
  shadowRoot,
  saveLocation,
  removeSynced = false
}) {
  const result = { copied: 0, skipped: 0, conflicts: [], errors: [] };
  const location =
    validLocation(saveLocation, gameRoot) || readLocation(shadowRoot, gameRoot);
  const directories = new Map([["", new Set()]]);
  if (location)
    directories.set(
      location.rel,
      new Set(location.files.map((name) => name.toLowerCase()))
    );
  // Legacy recovery is deliberately only root/one level and SaveN, never an
  // extension-wide walk through Data/ or another patched game-data directory.
  if (fs.existsSync(shadowRoot)) {
    for (const name of fs.readdirSync(shadowRoot)) {
      const info = fs.lstatSync(path.join(shadowRoot, name));
      if (
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        !directories.has(name)
      )
        directories.set(name, new Set());
    }
  }
  for (const [rel, names] of directories) {
    if (!independentDirectory(shadowRoot, rel)) continue;
    const sourceDir = path.join(shadowRoot, rel),
      targetDir = path.join(gameRoot, rel);
    if (!fs.existsSync(sourceDir) || sameDirectory(sourceDir, targetDir))
      continue;
    for (const name of fs.readdirSync(sourceDir)) {
      if (!VANILLA.test(name) && !names.has(name.toLowerCase())) continue;
      const source = path.join(sourceDir, name),
        target = path.join(targetDir, name);
      try {
        const info = fs.lstatSync(source);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const previous = stat(target);
        if (previous && !previous.isFile())
          throw new Error("destination is not a file");
        if (!previous || info.mtimeMs > previous.mtimeMs) {
          copy(source, target);
          result.copied += 1;
        } else {
          if (
            info.mtimeMs === previous.mtimeMs &&
            !sameFile(source, target) &&
            !fs.readFileSync(source).equals(fs.readFileSync(target))
          ) {
            result.conflicts.push({
              source,
              target,
              reason: "equal timestamp, different contents; real file retained"
            });
          }
          result.skipped += 1;
        }
        if (removeSynced) fs.unlinkSync(source);
      } catch (error) {
        result.errors.push({ source, target, message: error.message });
      }
    }
  }
  return result;
}

export function createSaveFiles({ projectRoot, resolveLocation }) {
  function backupRoot(gameKey) {
    return path.join(projectRoot, "backups", basename(gameKey, "game key"));
  }
  function locationFor(gameKey) {
    const resolved = resolveLocation(gameKey);
    const saveDir =
      typeof resolved === "string" ? resolved : resolved && resolved.saveDir;
    if (!saveDir || !fs.existsSync(saveDir))
      throw new Error(`save directory not found for "${gameKey}"`);
    const shadowRoot = path.join(
      projectRoot,
      "runtime",
      "rgss-shadow",
      basename(gameKey, "game key")
    );
    const known =
      validLocation(
        resolved && resolved.saveLocation,
        resolved && resolved.gameRoot
      ) || readLocation(shadowRoot, resolved && resolved.gameRoot);
    // Custom names require matching metadata. Without it, only vanilla names
    // at a directory mapped from a known game root may be coordinated. A bare
    // saveDir says nothing about its relation to a historical shadow tree.
    let shadowDir = null;
    if (
      known &&
      fs.existsSync(shadowRoot) &&
      path.resolve(saveDir).toLowerCase() === known.saveDir.toLowerCase()
    ) {
      if (independentDirectory(shadowRoot, known.rel))
        shadowDir = path.join(shadowRoot, known.rel);
    } else if (
      !known &&
      !(resolved && resolved.saveLocation) &&
      resolved &&
      resolved.gameRoot &&
      fs.existsSync(shadowRoot)
    ) {
      const rel = relativeInside(resolved.gameRoot, saveDir);
      if (rel !== null && independentDirectory(shadowRoot, rel))
        shadowDir = path.join(shadowRoot, rel);
    }
    if (shadowDir && sameDirectory(shadowDir, saveDir)) shadowDir = null;
    return { saveDir, shadowDir, known };
  }
  function shadowFile(location, name) {
    if (!location.shadowDir) return null;
    if (
      !VANILLA.test(name) &&
      !(
        location.known &&
        location.known.files.some(
          (file) => file.toLowerCase() === name.toLowerCase()
        )
      )
    )
      return null;
    return path.join(location.shadowDir, name);
  }
  function backupDir(gameKey, name) {
    const dir = path.join(backupRoot(gameKey), basename(name, "backup name"));
    if (!fs.existsSync(dir)) throw new Error(`backup not found: ${dir}`);
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
      throw new Error(`bad backup directory: ${dir}`);
    return dir;
  }
  function saveNames(dir) {
    return fs
      .readdirSync(dir)
      .filter(
        (name) =>
          SAVE_EXT.test(name) && fs.lstatSync(path.join(dir, name)).isFile()
      );
  }
  return {
    backup(gameKey) {
      const { saveDir } = locationFor(gameKey);
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .replace("T", "_")
        .slice(0, 19);
      let destDir = path.join(backupRoot(gameKey), stamp),
        suffix = 1;
      while (fs.existsSync(destDir))
        destDir = path.join(backupRoot(gameKey), `${stamp}-${suffix++}`);
      fs.mkdirSync(destDir, { recursive: true });
      const files = saveNames(saveDir);
      for (const name of files)
        copy(path.join(saveDir, name), path.join(destDir, name));
      return { gameKey, destDir, files: files.length };
    },
    listBackups(gameKey) {
      const root = backupRoot(gameKey);
      if (!fs.existsSync(root)) return [];
      return fs
        .readdirSync(root)
        .filter((name) => {
          const info = fs.lstatSync(path.join(root, name));
          return info.isDirectory() && !info.isSymbolicLink();
        })
        .map((name) => {
          const dir = path.join(root, name),
            files = saveNames(dir);
          return {
            name,
            dir,
            files: files.length,
            bytes: files.reduce(
              (sum, file) => sum + fs.statSync(path.join(dir, file)).size,
              0
            ),
            ts: fs.statSync(dir).mtime.toISOString()
          };
        })
        .sort((a, b) => b.name.localeCompare(a.name));
    },
    restore(gameKey, name) {
      const sourceDir = backupDir(gameKey, name),
        location = locationFor(gameKey);
      const files = saveNames(sourceDir);
      for (const file of files) {
        const target = path.join(location.saveDir, file);
        // Restore is a new user write, so do not revive the backup's old mtime.
        copy(path.join(sourceDir, file), target, false);
        const shadow = shadowFile(location, file);
        if (shadow) copy(target, shadow);
      }
      return { gameKey, name, restored: files.length };
    },
    deleteBackup(gameKey, name) {
      fs.rmSync(backupDir(gameKey, name), { recursive: true, force: true });
      return { gameKey, name, deleted: true };
    },
    deleteSave(gameKey, fileName) {
      const name = basename(fileName);
      if (!SAVE_EXT.test(name)) throw new Error(`bad file name: ${fileName}`);
      const location = locationFor(gameKey),
        target = path.join(location.saveDir, name);
      if (!stat(target)) throw new Error(`file not found: ${name}`);
      const shadow = shadowFile(location, name);
      // Remove the independent alias first: a failure must be visible before
      // claiming a completed real deletion that could later be resurrected.
      if (shadow && fs.existsSync(shadow)) fs.unlinkSync(shadow);
      fs.unlinkSync(target);
      return { gameKey, name, deleted: true };
    }
  };
}
