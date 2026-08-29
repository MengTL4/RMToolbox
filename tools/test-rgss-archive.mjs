// Tests for RGSSAD archive reading and in-place patching.
//
// Requires a real encrypted archive; point RMCH_RGSS_SAMPLES at a directory
// containing `hs/Game.rgss3a` (Homework Salesman, a free RPG Maker VX Ace
// game) plus `hs-scripts.rvdata2` as the known-good extracted payload.

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmdirSync, unlinkSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readIndex, extractEntry, patchEntry } from "../core/rgss-archive.mjs";

const failures = [];
let passed = 0;

function ok(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
}

function check(name, actual, expected) {
  const a = Buffer.isBuffer(actual) ? actual.toString("hex") : String(actual);
  const b = Buffer.isBuffer(expected) ? expected.toString("hex") : String(expected);
  if (a === b) passed += 1;
  else failures.push(`${name}\n    expected: ${b.slice(0, 80)}\n    actual:   ${a.slice(0, 80)}`);
}

const sampleDir = process.env.RMCH_RGSS_SAMPLES;
const archive = sampleDir && path.join(sampleDir, "hs", "Game.rgss3a");
const reference = sampleDir && path.join(sampleDir, "hs-scripts.rvdata2");

// --- v1/v2 guards (synthetic archive, no sample needed) ------------------------
// Patching or extracting a pre-v3 archive must refuse loudly; writing the v3
// 12-byte index patch into an inline v1 index would silently corrupt it.
function makeV1Archive(filePath) {
  const nextKey = (k) => ((Math.imul(k, 7) + 3) >>> 0);
  let key = 0xdeadcafe;
  const name = Buffer.from("Data\\Scripts.rxdata", "latin1");
  const payload = Buffer.from("payload", "latin1");
  const parts = [Buffer.from([0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00, 0x01])];
  const u32 = (v) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE((v ^ key) >>> 0, 0);
    key = nextKey(key);
    return b;
  };
  parts.push(u32(name.length));
  const encName = Buffer.allocUnsafe(name.length);
  for (let i = 0; i < name.length; i += 1) {
    encName[i] = name[i] ^ (key & 0xff);
    key = nextKey(key);
  }
  parts.push(encName, u32(payload.length), payload);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat(parts));
}

const v1Dir = path.join(os.tmpdir(), `rmch-v1-test-${process.pid}`);
const v1Archive = path.join(v1Dir, "Game.rgssad");
makeV1Archive(v1Archive);
const v1Index = readIndex(v1Archive);
ok("v1 index parses", v1Index.version === 1 && v1Index.entries.has("Data\\Scripts.rxdata"));
let threw = "";
try { extractEntry(v1Archive, "Data\\Scripts.rxdata"); } catch (e) { threw = e.message; }
ok("v1 extract refuses", /not supported/.test(threw), threw);
threw = "";
try { patchEntry({ src: v1Archive, dst: path.join(v1Dir, "out.rgssad"), entry: "Data\\Scripts.rxdata", data: Buffer.alloc(1) }); } catch (e) { threw = e.message; }
ok("v1 patch refuses", /only supported for v3/.test(threw), threw);
try {
  unlinkSync(v1Archive);
  rmdirSync(v1Dir);
} catch (_) {}

const hasSamples = sampleDir && existsSync(archive) && existsSync(reference);
if (!hasSamples) {
  console.log("rgss-archive test: SKIP v3 section (set RMCH_RGSS_SAMPLES with hs/Game.rgss3a)");
}

const SCRIPTS = "Data\\Scripts.rvdata2";

if (hasSamples) {
// --- index -------------------------------------------------------------------
const index = readIndex(archive);
ok("version is v3", index.version === 3, `version=${index.version}`);
ok("entry count is 721", index.entries.size === 721, `count=${index.entries.size}`);
ok("scripts entry present", index.entries.has(SCRIPTS));
const meta = index.entries.get(SCRIPTS);
ok("scripts size is 428343", meta.size === 428343, `size=${meta.size}`);

// --- extract against the known-good payload ----------------------------------
const extracted = extractEntry(archive, SCRIPTS);
const expected = readFileSync(reference);
check("extracted payload matches known-good", extracted, expected);

// --- patch -------------------------------------------------------------------
// A patched copy is >100MB, so keep it off the sample tree and delete the file
// directly (recursive rm helpers choke on it here).
const workDir = path.join(os.tmpdir(), `rmch-archive-test-${process.pid}`);
if (!existsSync(workDir)) mkdirSync(workDir, { recursive: true });
const patched = path.join(workDir, "Game.rgss3a");

const marker = Buffer.concat([expected, Buffer.from("\n# rmch patched\n", "utf8")]);
const result = patchEntry({ src: archive, dst: patched, entry: SCRIPTS, data: marker });
ok("patch verified", result.verify === true);
ok("new size recorded", result.size === marker.length, `size=${result.size}`);
ok("archive only grew by the payload", statSync(patched).size - statSync(archive).size === marker.length);

const reread = extractEntry(patched, SCRIPTS);
check("patched archive reads back the new payload", reread, marker);

// Other entries must be untouched.
const before = extractEntry(archive, "Data\\Items.rvdata2");
const after = extractEntry(patched, "Data\\Items.rvdata2");
check("untouched entry survives patching", after, before);

try {
  unlinkSync(patched);
  rmdirSync(workDir);
} catch (_) {
  // best effort: the temp dir is disposable
}
}

if (failures.length) {
  console.error(`rgss-archive test: FAIL (${failures.length} of ${passed + failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`rgss-archive test: PASS (${passed} checks)`);
