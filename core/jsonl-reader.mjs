// Incremental UTF-8 lines from an append-only file. Protocol parsing belongs
// to callers; byte offsets, incomplete characters and incomplete lines do not.
import { openSync, fstatSync, readSync, closeSync, statSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

export class JsonlReader {
  constructor(file, { fromEnd = false } = {}) {
    this.file = file;
    this.fromEnd = fromEnd;
    this.reset();
    if (fromEnd) {
      try {
        const stat = statSync(file, { bigint: true });
        this.identity = `${stat.dev}:${stat.ino}`;
        this.offset = Number(stat.size);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  reset() {
    this.offset = 0;
    this.remainder = "";
    this.decoder = new StringDecoder("utf8");
    this.identity = null;
  }

  readLines() {
    let fd;
    try {
      fd = openSync(this.file, "r");
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    try {
      // NTFS file IDs can exceed Number's exact range; rounded IDs can make
      // a replacement look like the previous file and skip its first bytes.
      const stat = fstatSync(fd, { bigint: true });
      const identity = `${stat.dev}:${stat.ino}`;
      const size = Number(stat.size);
      if (this.identity === null) {
        this.identity = identity;
        if (this.fromEnd) {
          this.offset = size;
          return [];
        }
      } else if (identity !== this.identity) {
        this.reset();
        this.identity = identity;
        if (this.fromEnd) {
          this.offset = size;
          return [];
        }
      } else if (size < this.offset) {
        this.reset();
        this.identity = identity;
      }
      const lines = [];
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(0, size - this.offset)));
      while (this.offset < size) {
        const got = readSync(fd, chunk, 0, Math.min(chunk.length, size - this.offset), this.offset);
        if (!got) break;
        this.offset += got;
        const parts = (this.remainder + this.decoder.write(chunk.subarray(0, got))).split(/\r?\n/);
        this.remainder = parts.pop();
        for (const line of parts) lines.push(line);
      }
      return lines;
    } finally {
      closeSync(fd);
    }
  }
}
