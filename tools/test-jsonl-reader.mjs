import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonlReader } from "../core/jsonl-reader.mjs";

const root = mkdtempSync(path.join(tmpdir(), "rmch-jsonl-"));
try {
  const file = path.join(root, "events.jsonl");
  const reader = new JsonlReader(file);
  assert.deepEqual(reader.readLines(), []);
  const text = JSON.stringify({ name: "中文图标🐉", n: 7 });
  // Every possible UTF-8 split occurs naturally with one byte per append.
  for (const byte of Buffer.from(text + "\r")) {
    appendFileSync(file, Buffer.from([byte]));
    assert.deepEqual(reader.readLines(), []);
  }
  appendFileSync(file, "\nsecond\nthird\nunfinished");
  assert.deepEqual(reader.readLines(), [text, "second", "third"]);
  assert.deepEqual(reader.readLines(), []);
  appendFileSync(file, "-tail\n");
  assert.deepEqual(reader.readLines(), ["unfinished-tail"]);

  // A truncation discards both pending text and an incomplete UTF-8 codepoint.
  appendFileSync(
    file,
    Buffer.concat([
      Buffer.from("old partial"),
      Buffer.from("中").subarray(0, 1)
    ])
  );
  reader.readLines();
  truncateSync(file, 0);
  assert.deepEqual(reader.readLines(), []);
  appendFileSync(file, "新文件\n");
  assert.deepEqual(reader.readLines(), ["新文件"]);

  // A replacement may be larger than the old offset and still starts at zero.
  renameSync(file, file + ".old");
  writeFileSync(file, "replacement is longer than the previous file\n");
  assert.deepEqual(reader.readLines(), [
    "replacement is longer than the previous file"
  ]);
  const tail = new JsonlReader(file, { fromEnd: true });
  assert.deepEqual(tail.readLines(), []);
  appendFileSync(file, "fresh\n");
  assert.deepEqual(tail.readLines(), ["fresh"]);
  const large = "中文".repeat(40000);
  appendFileSync(file, large + "\n");
  assert.deepEqual(tail.readLines(), [large]);

  // File-session adoption can precede the first events.jsonl creation. A
  // from-end reader must skip old history that appears with the new file.
  const late = path.join(root, "late-events.jsonl");
  const lateReader = new JsonlReader(late, { fromEnd: true });
  assert.deepEqual(lateReader.readLines(), []);
  writeFileSync(late, "old result\n");
  assert.deepEqual(lateReader.readLines(), []);
  appendFileSync(late, "new result\n");
  assert.deepEqual(lateReader.readLines(), ["new result"]);

  // Repeated rotations exercise neighboring NTFS file IDs, which may collide
  // when represented as Number. Retain old files so IDs cannot be reused.
  const rotating = path.join(root, "rotating.jsonl");
  writeFileSync(rotating, "initial\n");
  const rotatingReader = new JsonlReader(rotating);
  assert.deepEqual(rotatingReader.readLines(), ["initial"]);
  for (let index = 0; index < 64; index++) {
    renameSync(rotating, `${rotating}.${index}`);
    const line = `replacement ${index}: ${"x".repeat(index)}`;
    writeFileSync(rotating, line + "\n");
    assert.deepEqual(rotatingReader.readLines(), [line]);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
console.log(
  "test-jsonl-reader: UTF-8 splits, tails, truncation, replacement and large lines passed"
);
