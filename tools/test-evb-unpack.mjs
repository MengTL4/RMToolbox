// EVB (Enigma Virtual Box) unpacker fixture test: synthesizes a minimal
// raw-mode EVB image (PE head with .enigma1/.enigma2 sections + "EVB\0" pack
// header + node table + contiguous data region) and drives detectEvb /
// parseEvbTree / extractEvb / ensureEvbUnpacked against it. No real packed
// game needed. See core/evb-unpack.mjs for the format walk this mirrors.

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectEvb, parseEvbTree, extractEvb, ensureEvbUnpacked, EvbError } from "../core/evb-unpack.mjs";

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
  Buffer.concat([nodeHeader(objectsCount), utf16z(name), Buffer.from([3]), Buffer.alloc(25)]);

const fileNode = (name, originalSize, storedSize) => {
  const opt = Buffer.alloc(53);
  opt.writeUInt32LE(originalSize, 2);
  opt.writeUInt32LE(storedSize, 49);
  return Buffer.concat([nodeHeader(0), utf16z(name), Buffer.from([2]), opt]);
};

const GAME_EXE = Buffer.from("MZ-FAKE-GAME-BYTES");
const README = Buffer.from("hello evb\n");

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
    folderNode("%DEFAULT FOLDER%", 2),
    fileNode("Game.exe", GAME_EXE.length, storedGame),
    fileNode("readme.txt", README.length, README.length)
  ]);
  const magicAt = 0x400;
  const mainSize = table.length + 11; // dataBase = magicAt+68+size = table end
  const dataBase = magicAt + 64 + 15 + table.length;
  const image = Buffer.alloc(dataBase + GAME_EXE.length + README.length);
  peHead(enigma).copy(image, 0);
  image.write("EVB\0", magicAt, "latin1");
  const main = nodeHeader(1, mainSize);
  main.copy(image, magicAt + 64); // byte 15 stays 0 (objects < 2^24)
  table.copy(image, magicAt + 64 + 15);
  GAME_EXE.copy(image, dataBase);
  README.copy(image, dataBase + storedGame);
  return image;
}

const tmp = mkdtempSync(path.join(tmpdir(), "rmch-evb-"));
try {
  const exe = path.join(tmp, "fake-enigma.exe");
  writeFileSync(exe, buildEvbImage());

  const det = detectEvb(exe);
  check("detectEvb hits .enigma sections", !!det && det.arch === "x64", JSON.stringify(det));

  const plain = path.join(tmp, "plain.exe");
  writeFileSync(plain, buildEvbImage({ enigma: false }));
  check("detectEvb passes plain PE", detectEvb(plain) === null, "");

  const tree = parseEvbTree(exe);
  const paths = tree.files.map((f) => f.path);
  check("tree paths (%DEFAULT FOLDER% → root)", paths.join(",") === "Game.exe,readme.txt", paths.join(","));
  check("tree sizes", tree.files[0]?.storedSize === GAME_EXE.length && tree.files[1]?.storedSize === README.length,
    JSON.stringify(tree.files));
  check("tree flags uncompressed", tree.files.every((f) => !f.compressed), "");

  const outDir = path.join(tmp, "out");
  const result = extractEvb(exe, outDir);
  check("extractEvb counts", result.files === 2 && result.bytes === GAME_EXE.length + README.length, JSON.stringify(result));
  check("extracted Game.exe bytes", readFileSync(path.join(outDir, "Game.exe")).equals(GAME_EXE), "");
  check("extracted readme.txt bytes", readFileSync(path.join(outDir, "readme.txt")).equals(README), "");

  const compressedExe = path.join(tmp, "compressed.exe");
  writeFileSync(compressedExe, buildEvbImage({ compress: true }));
  const refused = await Promise.resolve()
    .then(() => { extractEvb(compressedExe, path.join(tmp, "out2")); return ""; })
    .catch((e) => (e instanceof EvbError ? e.message : `wrong error: ${e}`));
  check("compressed image refused loudly", /aPLib/.test(refused), refused);

  // ensureEvbUnpacked: first call extracts next to the exe, second reuses.
  const packed = path.join(tmp, "My Game.exe");
  writeFileSync(packed, buildEvbImage());
  const first = ensureEvbUnpacked(packed);
  check("ensureEvbUnpacked extracts", first.extracted === true && first.files === 2, JSON.stringify(first));
  check("ensureEvbUnpacked lands Game.exe",
    readFileSync(path.join(first.dir, "Game.exe")).equals(GAME_EXE), first.dir);
  const second = ensureEvbUnpacked(packed);
  check("ensureEvbUnpacked reuses", second.extracted === false && second.dir === first.dir, JSON.stringify(second));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `test-evb-unpack: FAIL (${failures} checks)` : "test-evb-unpack: PASS");
process.exit(failures ? 1 : 0);
