// RGSSAD archive reader/patcher (RPG Maker's packed asset container).
//
//   v1  .rgssad   RPG Maker XP
//   v2  .rgss2a   RPG Maker VX
//   v3  .rgss3a   RPG Maker VX Ace
//
// The encryption is XOR obfuscation with the key carried inside the file, so it
// is not a security boundary -- it is just enough to stop casual browsing.
//
// v3 (verified against a 111MB real archive):
//   header   b"RGSSAD" 0x00 0x03, then u32 `stored`
//   key      = stored * 9 + 3          (multiplication, not XOR)
//   entry    offset, size, fileKey, nameLen -- each u32 XORed with `key`
//   name     XORed cyclically against key's 4 bytes
//   payload  XORed cyclically against fileKey's 4 bytes, rolling
//            k = k*7+3 every four bytes
//
// v1 (verified against a real 27.6MB archive: 武界风云传, 570 entries, the
//   extracted Scripts.rxdata parses as Marshal and its rgss_main entry is
//   found — see tools/test-rgss-archive.mjs):
//   key      0xDEADCAFE, rolling k = k*7+3 after every index value and name byte
//   entry    nameLen, name, size -- inline, payload follows (no offset field)
//   payload  per-4-byte rolling XOR starting from the chain key AT THE POINT
//            JUST AFTER the size field (not a fresh 0xDEADCAFE as some
//            published docs claim)
//
// v2 support is read-index only: extractEntry() and patchEntry() refuse v2
// archives until a real encrypted VX sample can verify the derivation.
//
// Patching v3 does not rebuild the archive: the new payload is appended at EOF
// and the entry's offset/size/fileKey triple in the index is overwritten.
// Patching v1 rewrites the byte stream instead: entries sit inline, but the
// rolling index key advances by field (nameLen, name byte, size) regardless of
// content, so every other entry is copied through verbatim.

import { openSync, readSync, writeSync, closeSync, fstatSync, copyFileSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";

const MAGIC = Buffer.from("RGSSAD", "latin1");
const V1_INITIAL_KEY = 0xdeadcafe;
const DEFAULT_FILE_KEY = 42; // arbitrary; we encrypt with it, the engine decrypts

const M32 = 0xffffffff;

// JS bitwise ops yield signed 32-bit results; RGSS arithmetic is unsigned, so
// every step is normalised back with >>> 0.
const nextKey = (k) => ((Math.imul(k, 7) + 3) >>> 0);
const xor32 = (a, b) => ((a ^ b) >>> 0);

function u32(buf, offset) {
  return buf.readUInt32LE(offset);
}

function rollingXor(payload, key) {
  let k = key >>> 0;
  const out = Buffer.allocUnsafe(payload.length);
  const kb = Buffer.allocUnsafe(4);
  for (let i = 0; i < payload.length; i += 1) {
    if (i % 4 === 0) kb.writeUInt32LE(k, 0);
    out[i] = payload[i] ^ kb[i % 4];
    if (i % 4 === 3) k = nextKey(k);
  }
  return out;
}

function xorName(name, key) {
  const kb = Buffer.allocUnsafe(4);
  kb.writeUInt32LE(key >>> 0, 0);
  const out = Buffer.allocUnsafe(name.length);
  for (let i = 0; i < name.length; i += 1) out[i] = name[i] ^ kb[i % 4];
  return out;
}

export class ArchiveError extends Error {}

export function readIndex(archivePath) {
  const fd = openSync(archivePath, "r");
  try {
    const header = Buffer.alloc(8);
    readSync(fd, header, 0, 8, 0);
    if (!header.subarray(0, 6).equals(MAGIC)) throw new ArchiveError("not an RGSSAD archive");
    const version = header[7];
    const entries = new Map();

    if (version === 3) {
      const stored = Buffer.alloc(4);
      readSync(fd, stored, 0, 4, 8);
      const key = ((Math.imul(u32(stored, 0), 9) + 3) >>> 0);
      let pos = 12;
      const chunk = Buffer.alloc(16);
      for (;;) {
        const indexPos = pos;
        const read = readSync(fd, chunk, 0, 16, pos);
        if (read < 16) break;
        const offset = xor32(u32(chunk, 0), key);
        const size = xor32(u32(chunk, 4), key);
        const fileKey = xor32(u32(chunk, 8), key);
        const nameLen = xor32(u32(chunk, 12), key);
        if (offset === 0 || nameLen === 0 || nameLen > 4096) break;
        const rawName = Buffer.alloc(nameLen);
        readSync(fd, rawName, 0, nameLen, pos + 16);
        const name = xorName(rawName, key).toString("utf8");
        entries.set(name, { offset, size, fileKey, indexPos });
        pos = indexPos + 16 + nameLen;
      }
      return { version, key, entries };
    }

    if (version === 1 || version === 2) {
      let key = V1_INITIAL_KEY;
      let pos = 8;
      for (;;) {
        const indexPos = pos;
        const raw = Buffer.alloc(4);
        if (readSync(fd, raw, 0, 4, pos) < 4) break;
        const nameLen = xor32(u32(raw, 0), key);
        key = nextKey(key);
        if (nameLen === 0 || nameLen > 4096) break;
        const rawName = Buffer.alloc(nameLen);
        readSync(fd, rawName, 0, nameLen, pos + 4);
        const nameBytes = Buffer.allocUnsafe(nameLen);
        for (let i = 0; i < nameLen; i += 1) {
          nameBytes[i] = rawName[i] ^ (key & 0xff);
          key = nextKey(key);
        }
        const sizeRaw = Buffer.alloc(4);
        readSync(fd, sizeRaw, 0, 4, pos + 4 + nameLen);
        // The chain key that decrypts the size field; patchEntry re-encrypts
        // the replacement size with it.
        const sizeKey = key;
        const size = xor32(u32(sizeRaw, 0), key);
        key = nextKey(key);
        // v1 payloads roll per-4-bytes from the chain key at THIS point —
        // verified against a real archive (see header comment).
        const payloadKey = key;
        const offset = indexPos + 4 + nameLen + 4;
        entries.set(nameBytes.toString("utf8"), {
          offset,
          size,
          fileKey: null,
          indexPos,
          inline: true,
          nameLen,
          sizeKey,
          payloadKey
        });
        pos = offset + size;
      }
      return { version, key, entries };
    }

    throw new ArchiveError(`unsupported RGSSAD version ${version}`);
  } finally {
    closeSync(fd);
  }
}

export function extractEntry(archivePath, name, fileKey = DEFAULT_FILE_KEY) {
  const index = readIndex(archivePath);
  const entry = index.entries.get(name);
  if (!entry) throw new ArchiveError(`entry not found: ${name}`);
  if (entry.fileKey === null) {
    // v1: payload rolls per-4-bytes from the chain key just after the size
    // field (verified against a real sample). v2 is read-index only — its
    // payload derivation is unverified, refuse rather than return garbage.
    if (index.version !== 1) {
      throw new ArchiveError(`encrypted v${index.version} archives are not supported yet: ${archivePath}`);
    }
    const fd = openSync(archivePath, "r");
    try {
      const buf = Buffer.allocUnsafe(entry.size);
      readSync(fd, buf, 0, entry.size, entry.offset);
      return rollingXor(buf, entry.payloadKey);
    } finally {
      closeSync(fd);
    }
  }
  const fd = openSync(archivePath, "r");
  try {
    const buf = Buffer.allocUnsafe(entry.size);
    readSync(fd, buf, 0, entry.size, entry.offset);
    return rollingXor(buf, entry.fileKey);
  } finally {
    closeSync(fd);
  }
}

// v1 entries are inline, so replacing one rewrites the byte stream. The
// rolling index key advances by field (nameLen, name byte, size) regardless of
// content, and each payload key is fixed by its chain position — so copying
// every other entry verbatim keeps the whole archive consistent. Only the
// target's size field and payload are re-emitted.
function patchEntryV1({ src, dst, entry, data, index }) {
  const target = index.entries.get(entry);
  if (!target) throw new ArchiveError(`entry not found: ${entry}`);
  const raw = readFileSync(src);
  const sizeFieldPos = target.indexPos + 4 + target.nameLen;
  const sizeField = Buffer.alloc(4);
  sizeField.writeUInt32LE(xor32(data.length, target.sizeKey) >>> 0, 0);
  const out = Buffer.concat([
    raw.subarray(0, sizeFieldPos),
    sizeField,
    rollingXor(data, target.payloadKey),
    raw.subarray(target.offset + target.size)
  ]);
  writeFileSync(dst, out);
  const verify = extractEntry(dst, entry).equals(data);
  return { offset: sizeFieldPos + 4, size: data.length, verify };
}

/**
 * Replace one entry. v3 patches in place (index triple rewrite + payload
 * appended at EOF); v1 rewrites the stream (see patchEntryV1).
 *
 * For the v3 path the archive must be a copy, never a hard link into the real
 * game: it rewrites bytes in place. The v1 path reads src whole and writes dst
 * fresh, so the two may not alias either.
 */
export function patchEntry({ src, dst, entry, data, fileKey = DEFAULT_FILE_KEY }) {
  const index = readIndex(src);
  if (index.version === 1) return patchEntryV1({ src, dst, entry, data, index });
  if (index.version !== 3) {
    // v2 index entries are inline like v1's, but without a verified payload
    // derivation there is nothing safe to write.
    throw new ArchiveError(`patching is only supported for v1 and v3 archives: ${src}`);
  }
  const target = index.entries.get(entry);
  if (!target) throw new ArchiveError(`entry not found: ${entry}`);

  copyFileSync(src, dst);
  const sizeFd = openSync(dst, "r");
  const sizeBefore = fstatSync(sizeFd).size;
  closeSync(sizeFd);

  const payload = rollingXor(data, fileKey);
  appendFileSync(dst, payload);

  const newOffset = sizeBefore;
  const fd = openSync(dst, "r+");
  try {
    const patch = Buffer.alloc(12);
    patch.writeUInt32LE(xor32(newOffset, index.key), 0);
    patch.writeUInt32LE(xor32(data.length, index.key), 4);
    patch.writeUInt32LE(xor32(fileKey, index.key), 8);
    writeSync(fd, patch, 0, 12, target.indexPos);
  } finally {
    closeSync(fd);
  }

  const verify = readIndex(dst);
  const after = verify.entries.get(entry);
  const checkFd = openSync(dst, "r");
  let ok = false;
  try {
    const buf = Buffer.allocUnsafe(after.size);
    readSync(checkFd, buf, 0, after.size, after.offset);
    ok = rollingXor(buf, after.fileKey).equals(data);
  } finally {
    closeSync(checkFd);
  }

  return { offset: newOffset, size: data.length, verify: ok };
}

export function listEntries(archivePath) {
  const index = readIndex(archivePath);
  return [...index.entries.entries()].map(([name, meta]) => ({ name, ...meta }));
}
