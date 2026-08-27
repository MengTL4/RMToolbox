// Minimal zero-dependency zip writer (STORE method, no compression).
// Good enough for save backups; handles UTF-8 (Chinese) entry names via the
// general-purpose bit 11 flag.

import { createWriteStream } from "node:fs";
import { readdirSync, statSync, readFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: ((date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)) & 0xffff,
    date: (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff
  };
}

function collectFiles(sourceDir, baseDir = sourceDir, out = []) {
  for (const entry of readdirSync(sourceDir)) {
    const full = path.join(sourceDir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, baseDir, out);
    } else if (stat.isFile()) {
      out.push({ full, rel: path.relative(baseDir, full).split(path.sep).join("/") });
    }
  }
  return out;
}

export function zipDirectory(sourceDir, destZip) {
  const files = collectFiles(sourceDir);
  mkdirSync(path.dirname(destZip), { recursive: true });

  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const data = readFileSync(file.full);
    const name = Buffer.from(file.rel, "utf8");
    const crc = crc32(data);
    const { time, date } = dosDateTime(statSync(file.full).mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 names
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return new Promise((resolve, reject) => {
    const stream = createWriteStream(destZip);
    stream.on("error", reject);
    stream.on("finish", () => resolve({ file: destZip, entries: files.length, bytes: offset + centralBuffer.length + eocd.length }));
    for (const part of localParts) stream.write(part);
    stream.write(centralBuffer);
    stream.write(eocd);
    stream.end();
  });
}
