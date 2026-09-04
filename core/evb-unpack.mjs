// Enigma Virtual Box support: detect packed single-file games and extract
// their embedded virtual filesystem back to a real directory.
//
// The format walk is a Node port of evbunpack's modern (non-legacy) tree
// reader (https://github.com/mos9527/evbunpack), validated against
// 宝可梦赤途's 2.9GB packer-v9.70 image:
//
//   "EVB\0" magic, then a 64-byte pack header, then a main node
//   (u32 size + 8s pad + u32 objects_count). The node table follows:
//   each node = header (same 16-byte shape) + UTF-16LE name (00 00
//   terminated) + u8 type (2=file, 3=folder). File nodes carry a 53-byte
//   optional block (2s + u32 original_size + 4s + 24s filetimes + 15s +
//   u32 stored_size); folder nodes are followed by 25 pad bytes. File
//   payloads live in a contiguous data region whose base is derived from
//   the main node; per-file offsets accumulate in table order.
//
//   Compression (original_size != stored_size) is aPLib with a per-file
//   chunk table — NOT yet ported; extraction refuses compressed images
//   loudly instead of writing corrupt files. (宝可梦赤途: 41910 files,
//   zero compressed — EVB compression was simply off.)
//
// Legacy (pre-8) interleaved table+content images are not supported; the
// walk bails out with EvbError when the table stops making sense.

import { openSync, closeSync, readSync, mkdirSync, existsSync, statSync, symlinkSync, fstatSync, writeSync } from "node:fs";
import path from "node:path";

export class EvbError extends Error {}

const EVB_MAGIC = Buffer.from("EVB\0");
const NODE_TYPE_FILE = 2;
const NODE_TYPE_FOLDER = 3;
const FOLDER_ALTNAMES = { "%DEFAULT FOLDER%": "" };
const MAX_NODES = 2_000_000;

/**
 * Read the PE section table of an executable (enough for shell detection).
 * Returns null for non-PE files.
 */
export function readPeSections(exePath) {
  const fd = openSync(exePath, "r");
  try {
    const head = Buffer.alloc(0x400);
    if (readSync(fd, head, 0, 0x400, 0) < 0x400) return null;
    if (head.toString("latin1", 0, 2) !== "MZ") return null;
    const peOffset = head.readUInt32LE(0x3c);
    if (peOffset + 24 > head.length) return null;
    if (head.toString("latin1", peOffset, peOffset + 4) !== "PE\0\0") return null;
    const machine = head.readUInt16LE(peOffset + 4);
    const sectionCount = head.readUInt16LE(peOffset + 6);
    const optSize = head.readUInt16LE(peOffset + 20);
    const sectionsPos = peOffset + 24 + optSize;
    const table = Buffer.alloc(sectionCount * 40);
    if (readSync(fd, table, 0, table.length, sectionsPos) < table.length) return null;
    const sections = [];
    for (let i = 0; i < sectionCount; i += 1) {
      const base = i * 40;
      sections.push({
        name: table.toString("latin1", base, base + 8).replace(/\0+$/, ""),
        rawSize: table.readUInt32LE(base + 16),
        rawPos: table.readUInt32LE(base + 20)
      });
    }
    return { arch: machine === 0x8664 ? "x64" : machine === 0x14c ? "x86" : `0x${machine.toString(16)}`, sections };
  } finally {
    closeSync(fd);
  }
}

/**
 * An Enigma Virtual Box image carries .enigma1/.enigma2 sections (the loader
 * stub is an FPC binary; the VFS lives in .enigma1's data).
 */
export function detectEvb(exePath) {
  const pe = readPeSections(exePath);
  if (!pe) return null;
  const names = pe.sections.map((s) => s.name);
  if (!names.includes(".enigma1") || !names.includes(".enigma2")) return null;
  return { arch: pe.arch, sections: pe.sections };
}

function findMagic(fd, fileSize) {
  const chunk = 8 * 1024 * 1024;
  const buf = Buffer.allocUnsafe(chunk + 3);
  let pos = 0;
  let carry = 0;
  while (pos < fileSize) {
    const want = Math.min(chunk, fileSize - pos);
    const got = readSync(fd, buf, carry, want, pos);
    if (got <= 0) break;
    const view = buf.subarray(0, carry + got);
    const at = view.indexOf(EVB_MAGIC);
    if (at !== -1) return pos - carry + at;
    view.copy(buf, 0, Math.max(0, view.length - 3));
    carry = Math.min(3, view.length);
    pos += got;
  }
  return -1;
}

// Tiny cursor over the node table region, reading through the file handle.
class Cursor {
  constructor(fd) {
    this.fd = fd;
    this.pos = 0;
  }

  read(length) {
    const buf = Buffer.alloc(length);
    const got = readSync(this.fd, buf, 0, length, this.pos);
    if (got < length) throw new EvbError("unexpected EOF in EVB node table");
    this.pos += length;
    return buf;
  }

  skip(length) {
    this.pos += length;
  }
}

function readNodeHeader(cursor) {
  const buf = cursor.read(16);
  return { size: buf.readUInt32LE(0), objectsCount: buf.readUInt32LE(12) };
}

function readNamedNode(cursor) {
  // UTF-16LE name terminated by 00 00, then a single type byte.
  const units = [];
  for (;;) {
    const pair = cursor.read(2);
    const unit = pair.readUInt16LE(0);
    if (unit === 0) break;
    units.push(unit);
    if (units.length > 512) throw new EvbError("EVB node name exceeds 512 chars");
  }
  const type = cursor.read(1)[0];
  return { name: String.fromCharCode(...units), type };
}

/**
 * Parse the VFS node table. Returns { files, folders } as flat lists with
 * full relative paths (forward slashes), files carrying
 * { offset, originalSize, storedSize, compressed }.
 */
export function parseEvbTree(exePath) {
  const fd = openSync(exePath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    const magicAt = findMagic(fd, fileSize);
    if (magicAt === -1) throw new EvbError(`EVB magic not found: ${exePath}`);

    const cursor = new Cursor(fd);
    cursor.pos = magicAt + 64; // pack header: 4s signature + 60s pad
    const main = readNodeHeader(cursor);
    const dataBase = cursor.pos + main.size - 12;
    cursor.skip(-1); // the table resumes one byte earlier (format quirk)

    let dataOffset = dataBase;
    let maxObjects = 0;
    let currentObjects = 0;
    const nodes = [{ type: 0, name: "", objectsCount: main.objectsCount }];

    while (nodes.length < MAX_NODES) {
      let header;
      let named;
      try {
        header = readNodeHeader(cursor);
        named = readNamedNode(cursor);
      } catch (error) {
        if (error instanceof EvbError && /EOF/.test(error.message)) break;
        throw error;
      }
      if (named.type === NODE_TYPE_FILE) {
        // EVB_NODE_OPTIONAL_FILE: 2s + u32 original_size + 4s + 3x8s
        // filetimes + 15s + u32 stored_size = 53 bytes.
        const opt = cursor.read(53);
        nodes.push({
          type: NODE_TYPE_FILE,
          name: named.name,
          objectsCount: header.objectsCount,
          originalSize: opt.readUInt32LE(2),
          storedSize: opt.readUInt32LE(49),
          offset: dataOffset
        });
        dataOffset += opt.readUInt32LE(49);
        currentObjects += 1;
      } else if (named.type === NODE_TYPE_FOLDER) {
        cursor.skip(25);
        nodes.push({ type: NODE_TYPE_FOLDER, name: named.name, objectsCount: header.objectsCount });
        maxObjects += header.objectsCount;
        currentObjects += 1;
      } else {
        break; // past the table
      }
      if (maxObjects > 0 && currentObjects > maxObjects) break;
    }
    if (nodes.length >= MAX_NODES) throw new EvbError("EVB node table did not terminate");

    // Nodes arrive depth-first; rebuild paths with a recursive consumer.
    const files = [];
    let index = 1;
    const walk = (prefix, count) => {
      for (let n = 0; n < count; n += 1) {
        const node = nodes[index];
        index += 1;
        if (!node) throw new EvbError("EVB file table is truncated");
        if (/[/\\:]/.test(node.name) || node.name === "." || node.name === "..") {
          throw new EvbError(`unsafe node name: ${JSON.stringify(node.name)}`);
        }
        const name = node.type === NODE_TYPE_FOLDER ? (FOLDER_ALTNAMES[node.name] ?? node.name) : node.name;
        const rel = prefix ? `${prefix}/${name}` : name;
        if (node.type === NODE_TYPE_FOLDER) {
          walk(rel, node.objectsCount);
        } else {
          files.push({
            path: rel,
            originalSize: node.originalSize,
            storedSize: node.storedSize,
            offset: node.offset,
            compressed: node.originalSize !== node.storedSize
          });
        }
      }
    };
    walk("", nodes[0].objectsCount);
    return { files, magicAt };
  } finally {
    closeSync(fd);
  }
}


/**
 * Extract the whole virtual filesystem into outDir. onProgress receives
 * { files, filesTotal, bytes, bytesTotal, current } at most once per file.
 */
export function extractEvb(exePath, outDir, { onProgress } = {}) {
  const { files } = parseEvbTree(exePath);
  const compressed = files.filter((f) => f.compressed);
  if (compressed.length) {
    const first = compressed.slice(0, 3).map((f) => f.path).join(", ");
    throw new EvbError(
      `EVB image uses aPLib compression on ${compressed.length} file(s) (${first}…) — ` +
      "compressed extraction is not ported yet (raw-only images work)"
    );
  }
  const fd = openSync(exePath, "r");
  try {
    const bytesTotal = files.reduce((sum, f) => sum + f.storedSize, 0);
    let bytesDone = 0;
    let filesDone = 0;
    const chunk = Buffer.allocUnsafe(16 * 1024 * 1024);
    for (const file of files) {
      const dest = path.join(outDir, ...file.path.split("/"));
      mkdirSync(path.dirname(dest), { recursive: true });
      const out = openSync(dest, "w");
      try {
        let remaining = file.storedSize;
        let at = file.offset;
        while (remaining > 0) {
          const want = Math.min(chunk.length, remaining);
          const got = readSync(fd, chunk, 0, want, at);
          if (got <= 0) throw new EvbError(`short read on ${file.path}`);
          writeFileSyncSilently(out, chunk, got);
          at += got;
          remaining -= got;
        }
      } finally {
        closeSync(out);
      }
      filesDone += 1;
      bytesDone += file.storedSize;
      if (onProgress) onProgress({ files: filesDone, filesTotal: files.length, bytes: bytesDone, bytesTotal, current: file.path });
    }
    return { files: filesDone, bytes: bytesDone };
  } finally {
    closeSync(fd);
  }
}

// writeSync loop on the output descriptor (fs.writeSync partial writes are
// legal; loop until the chunk is fully out).
function writeFileSyncSilently(outFd, buf, length) {
  let written = 0;
  while (written < length) {
    written += writeSync(outFd, buf, written, length - written);
  }
}

/**
 * The launcher entry: extract exePath's virtual filesystem into
 * "<exe base>_unpacked" next to it, or reuse a previous extraction. A save/
 * dir sitting next to the packed exe is junctioned into the unpacked tree so
 * saves the game wrote through the EVB overlay stay visible to the toolbox
 * (and vice versa).
 *
 * Reuse is decided by "Game.exe exists in the output dir" — cheap and right
 * in practice: a partial extraction lacks it, a complete one has it.
 */
export function ensureEvbUnpacked(exePath, { onProgress } = {}) {
  const outDir = exePath.replace(/\.exe$/i, "") + "_unpacked";
  if (existsSync(path.join(outDir, "Game.exe"))) {
    linkSaveDir(exePath, outDir);
    return { dir: outDir, extracted: false };
  }
  const result = extractEvb(exePath, outDir, { onProgress });
  linkSaveDir(exePath, outDir);
  return { dir: outDir, extracted: true, files: result.files, bytes: result.bytes };
}

function linkSaveDir(exePath, outDir) {
  const original = path.join(path.dirname(exePath), "save");
  const inside = path.join(outDir, "save");
  try {
    if (existsSync(inside) || !existsSync(original)) return;
    if (!statSync(original).isDirectory()) return;
    symlinkSync(original, inside, "junction");
  } catch (_) {}
}

