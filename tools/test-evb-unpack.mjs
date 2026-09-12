// EVB (Enigma Virtual Box) unpacker fixture test: synthesizes a minimal
// raw-mode EVB image (PE head with .enigma1/.enigma2 sections + "EVB\0" pack
// header + node table + contiguous data region) and drives detectEvb /
// parseEvbTree / extractEvb / ensureEvbUnpacked against it. No real packed
// game needed. See core/evb-unpack.mjs for the format walk this mirrors.

import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
  statSync,
  openSync,
  closeSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectEvb,
  parseEvbTree,
  extractEvb,
  extractEvbAsync,
  ensureEvbUnpacked,
  ensureEvbUnpackedAsync,
  EvbError
} from "../core/evb-unpack.mjs";

let failures = 0;
function check(label, ok, detail = "") {
  console.log(`  ${ok ? "ok" : "FAIL"} ${label}${ok ? "" : `  ${detail}`}`);
  if (!ok) failures += 1;
}

const utf16z = (s) => {
  const b = Buffer.alloc(s.length * 2 + 2);
  for (let i = 0; i < s.length; i += 1) b.writeUInt16LE(s.charCodeAt(i), i * 2);
  return b;
};

const nodeHeader = (objectsCount, size = 0) => {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(size, 0);
  b.writeUInt32LE(objectsCount, 12);
  return b;
};

const folderNode = (name, objectsCount) =>
  Buffer.concat([
    nodeHeader(objectsCount),
    utf16z(name),
    Buffer.from([3]),
    Buffer.alloc(25)
  ]);

const fileNode = (name, originalSize, storedSize) => {
  const opt = Buffer.alloc(53);
  opt.writeUInt32LE(originalSize, 2);
  opt.writeUInt32LE(storedSize, 49);
  return Buffer.concat([nodeHeader(0), utf16z(name), Buffer.from([2]), opt]);
};

const GAME_EXE = Buffer.from("MZ-FAKE-GAME-BYTES");
const README = Buffer.from("hello evb\n");
const TILE = Buffer.from("PNG-ish tile bytes");

function peHead(withEnigma) {
  const pe = Buffer.alloc(0x400);
  pe.write("MZ", 0, "latin1");
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write("PE\0\0", 0x80, "latin1");
  pe.writeUInt16LE(0x8664, 0x84); // machine x64
  pe.writeUInt16LE(withEnigma ? 2 : 1, 0x86); // section count
  // optional header size 0 → section table at 0x98
  const sec = (name, off) => {
    pe.write(name, off, "latin1");
    pe.writeUInt32LE(0x1000, off + 16); // raw size
    pe.writeUInt32LE(0x400, off + 20); // raw pos
  };
  if (withEnigma) {
    sec(".enigma1", 0x98);
    sec(".enigma2", 0x98 + 40);
  } else {
    sec(".rsrc", 0x98);
  }
  return pe;
}

// Layout: PE head (0x400) | "EVB\0"+60 pad | main header (u32 size + 8s pad +
// u32 objects) | node table starting ONE BYTE before the main header's end
// (format quirk, parseEvbTree does skip(-1)) | data region.
function buildEvbImage({ enigma = true, compress = false } = {}) {
  const storedGame = compress ? GAME_EXE.length - 1 : GAME_EXE.length;
  const table = Buffer.concat([
    folderNode("%DEFAULT FOLDER%", 3),
    fileNode("Game.exe", GAME_EXE.length, storedGame),
    folderNode("Graphics", 1),
    fileNode("tile.png", TILE.length, TILE.length),
    fileNode("readme.txt", README.length, README.length)
  ]);
  const magicAt = 0x400;
  const mainSize = table.length + 11; // dataBase = magicAt+68+size = table end
  const dataBase = magicAt + 64 + 15 + table.length;
  const image = Buffer.alloc(
    dataBase + GAME_EXE.length + TILE.length + README.length
  );
  peHead(enigma).copy(image, 0);
  image.write("EVB\0", magicAt, "latin1");
  const main = nodeHeader(1, mainSize);
  main.copy(image, magicAt + 64); // byte 15 stays 0 (objects < 2^24)
  table.copy(image, magicAt + 64 + 15);
  GAME_EXE.copy(image, dataBase);
  TILE.copy(image, dataBase + storedGame);
  README.copy(image, dataBase + storedGame + TILE.length);
  return image;
}

const tmp = mkdtempSync(path.join(tmpdir(), "rmch-evb-"));
try {
  const exe = path.join(tmp, "fake-enigma.exe");
  writeFileSync(exe, buildEvbImage());

  const det = detectEvb(exe);
  check(
    "detectEvb hits .enigma sections",
    !!det && det.arch === "x64",
    JSON.stringify(det)
  );

  const plain = path.join(tmp, "plain.exe");
  writeFileSync(plain, buildEvbImage({ enigma: false }));
  check("detectEvb passes plain PE", detectEvb(plain) === null, "");

  const tree = parseEvbTree(exe);
  const paths = tree.files.map((f) => f.path);
  check(
    "tree paths (%DEFAULT FOLDER% → root)",
    paths.join(",") === "Game.exe,Graphics/tile.png,readme.txt",
    paths.join(",")
  );
  check(
    "tree sizes",
    tree.files[0]?.storedSize === GAME_EXE.length &&
      tree.files[1]?.storedSize === TILE.length &&
      tree.files[2]?.storedSize === README.length,
    JSON.stringify(tree.files)
  );
  check(
    "tree flags uncompressed",
    tree.files.every((f) => !f.compressed),
    ""
  );

  const outDir = path.join(tmp, "out");
  const result = extractEvb(exe, outDir);
  check(
    "extractEvb counts",
    result.files === 3 &&
      result.bytes === GAME_EXE.length + TILE.length + README.length,
    JSON.stringify(result)
  );
  check(
    "extracted Game.exe bytes",
    readFileSync(path.join(outDir, "Game.exe")).equals(GAME_EXE),
    ""
  );
  check(
    "extracted readme.txt bytes",
    readFileSync(path.join(outDir, "readme.txt")).equals(README),
    ""
  );

  const compressedExe = path.join(tmp, "compressed.exe");
  writeFileSync(compressedExe, buildEvbImage({ compress: true }));
  const refused = await Promise.resolve()
    .then(() => {
      extractEvb(compressedExe, path.join(tmp, "out2"));
      return "";
    })
    .catch((e) => (e instanceof EvbError ? e.message : `wrong error: ${e}`));
  check("compressed image refused loudly", /aPLib/.test(refused), refused);

  // ensureEvbUnpacked: first call extracts next to the exe, second reuses.
  const packed = path.join(tmp, "My Game.exe");
  writeFileSync(packed, buildEvbImage());
  const first = ensureEvbUnpacked(packed);
  check(
    "ensureEvbUnpacked extracts",
    first.extracted === true && first.files === 3,
    JSON.stringify(first)
  );
  check(
    "ensureEvbUnpacked lands Game.exe",
    readFileSync(path.join(first.dir, "Game.exe")).equals(GAME_EXE),
    first.dir
  );
  const second = ensureEvbUnpacked(packed);
  check(
    "ensureEvbUnpacked reuses",
    second.extracted === false && second.dir === first.dir,
    JSON.stringify(second)
  );

  // A stale Game.exe is not enough to prove completion: simulate an interrupted
  // extraction that wrote only the first table entry, then require the next
  // launch to refill the missing tree and write the completion marker.
  const partialPacked = path.join(tmp, "Partial Game.exe");
  writeFileSync(partialPacked, buildEvbImage());
  const partialDir = partialPacked.replace(/\.exe$/i, "") + "_unpacked";
  writeFileSync(
    path.join(tmp, "partial-marker.txt"),
    "keep the fixture root writable"
  );
  mkdirSync(partialDir, { recursive: true });
  writeFileSync(path.join(partialDir, "Game.exe"), Buffer.from("partial"));
  const repaired = ensureEvbUnpacked(partialPacked);
  check(
    "partial extraction is repaired",
    repaired.extracted === true &&
      readFileSync(path.join(partialDir, "readme.txt")).equals(README),
    JSON.stringify(repaired)
  );
  check(
    "completion marker is written",
    readFileSync(
      path.join(partialDir, ".rmch-evb-complete.json"),
      "utf8"
    ).includes('"files":3'),
    ""
  );

  // Regression (宝可梦赤途 1.0.9.1, 2026-09): a completion marker proves only that
  // extraction finished ONCE. When the tree is later hollowed out — the user's
  // _unpacked held 410 of 41910 files, with Graphics/ and Audio/ empty — the
  // marker still matched the source executable, so every later launch reused
  // the empty tree and the game sat on its loading screen forever. Reuse must
  // therefore re-check that the marker's own paths still exist on disk.
  const holedPacked = path.join(tmp, "Holed Game.exe");
  writeFileSync(holedPacked, buildEvbImage());
  const holedDir = ensureEvbUnpacked(holedPacked).dir;
  // Simulate the external deletion: the tree keeps Game.exe and the marker, but
  // the Graphics subdirectory that the table says must exist is gone.
  rmSync(path.join(holedDir, "Graphics"), { recursive: true, force: true });
  const holedRepair = ensureEvbUnpacked(holedPacked);
  check(
    "hollowed tree is not reused as complete",
    holedRepair.extracted === true &&
      readFileSync(path.join(holedDir, "Graphics", "tile.png")).equals(TILE),
    JSON.stringify(holedRepair)
  );
  // and it must settle back into reuse once repaired
  const holedAgain = ensureEvbUnpacked(holedPacked);
  check(
    "repaired tree is reused again",
    holedAgain.extracted === false,
    JSON.stringify(holedAgain)
  );

  // A marker from an older toolbox version carries no path record; it cannot be
  // trusted, so it must be re-extracted rather than reused.
  const legacyPacked = path.join(tmp, "Legacy Game.exe");
  writeFileSync(legacyPacked, buildEvbImage());
  const legacyDir = legacyPacked.replace(/\.exe$/i, "") + "_unpacked";
  mkdirSync(legacyDir, { recursive: true });
  writeFileSync(path.join(legacyDir, "Game.exe"), Buffer.from("partial"));
  const legacyStat = statSync(legacyPacked);
  writeFileSync(
    path.join(legacyDir, ".rmch-evb-complete.json"),
    JSON.stringify({
      version: 1,
      sourceSize: legacyStat.size,
      sourceMtimeMs: legacyStat.mtimeMs,
      files: 3,
      bytes: GAME_EXE.length + TILE.length + README.length
    })
  );
  const legacy = ensureEvbUnpacked(legacyPacked);
  check(
    "legacy marker is re-extracted",
    legacy.extracted === true &&
      readFileSync(path.join(legacyDir, "readme.txt")).equals(README),
    JSON.stringify(legacy)
  );

  // A repair that cannot write (the game is still running out of the tree, so
  // its exe is locked) must say so instead of surfacing a raw errno: the GUI
  // shows this message verbatim. The lock is observed, not required — Windows
  // open semantics vary — so the check only rejects a *bad* message.
  const busyPacked = path.join(tmp, "Busy Game.exe");
  writeFileSync(busyPacked, buildEvbImage());
  const busyFirst = ensureEvbUnpacked(busyPacked);
  const held = openSync(path.join(busyFirst.dir, "Game.exe"), "r");
  try {
    rmSync(path.join(busyFirst.dir, ".rmch-evb-complete.json"), {
      force: true
    });
    let busyMessage = "";
    try {
      const again = ensureEvbUnpacked(busyPacked);
      busyMessage = `(no write failure; extracted=${again.extracted})`;
    } catch (e) {
      busyMessage = e.message;
    }
    check(
      "a write failure while the game holds the tree gets an actionable message",
      /^\(no write failure/.test(busyMessage) || /关闭该游戏/.test(busyMessage),
      busyMessage
    );
  } finally {
    closeSync(held);
  }

  // The GUI path must yield while copying a packed image, even when the image
  // contains only small files. This keeps NW responsive during real 40k-file
  // EVB extractions without changing the synchronous CLI contract above.
  const asyncPacked = path.join(tmp, "Async Game.exe");
  writeFileSync(asyncPacked, buildEvbImage());
  let yielded = false;
  setImmediate(() => {
    yielded = true;
  });
  let progress = 0;
  const asyncFirst = await ensureEvbUnpackedAsync(asyncPacked, {
    onProgress: () => {
      progress += 1;
    }
  });
  check(
    "async extraction yields to event loop",
    yielded && asyncFirst.extracted === true && progress === 3,
    JSON.stringify({ yielded, progress, asyncFirst })
  );
  const asyncSecond = await ensureEvbUnpackedAsync(asyncPacked);
  check(
    "async ensure reuses",
    asyncSecond.extracted === false && asyncSecond.dir === asyncFirst.dir,
    JSON.stringify(asyncSecond)
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(
  failures
    ? `test-evb-unpack: FAIL (${failures} checks)`
    : "test-evb-unpack: PASS"
);
process.exit(failures ? 1 : 0);
