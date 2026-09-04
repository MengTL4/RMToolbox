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

// --- v1 archive (synthetic fixture in the real scheme) -------------------------
// v1 is verified against a real 27.6MB sample (武界风云传): the index chain
// rolls per field (nameLen, name byte, size) regardless of content, and each
// payload rolls per-4-bytes from the chain key right after its size field.
// This fixture reproduces that scheme exactly, two entries deep so the chain
// position of the second entry is exercised too.
function makeV1Archive(filePath, files, versionByte = 0x01) {
  const nextKey = (k) => ((Math.imul(k, 7) + 3) >>> 0);
  let key = 0xdeadcafe;
  const parts = [Buffer.from([0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00, versionByte])];
  for (const [name, payload] of files) {
    const head = Buffer.alloc(4);
    head.writeUInt32LE(((name.length ^ key) >>> 0), 0);
    key = nextKey(key);
    const encName = Buffer.allocUnsafe(name.length);
    for (let i = 0; i < name.length; i += 1) {
      encName[i] = name.charCodeAt(i) ^ (key & 0xff);
      key = nextKey(key);
    }
    const sizeBuf = Buffer.alloc(4);
    sizeBuf.writeUInt32LE(((payload.length ^ key) >>> 0), 0);
    key = nextKey(key);
    // Payload rolls per-4-bytes from the chain key at this point — on a LOCAL
    // copy of the key: the index chain does not roll through payload bytes.
    const enc = Buffer.allocUnsafe(payload.length);
    const kb = Buffer.allocUnsafe(4);
    let pk = key;
    for (let i = 0; i < payload.length; i += 1) {
      if (i % 4 === 0) kb.writeUInt32LE(pk, 0);
      enc[i] = payload[i] ^ kb[i % 4];
      if (i % 4 === 3) pk = nextKey(pk);
    }
    parts.push(head, encName, sizeBuf, enc);
  }
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat(parts));
}

const SCRIPTS_V1 = "Data\\Scripts.rxdata";
const ITEMS_V1 = "Data\\Items.rxdata";
// Non-multiple-of-4 lengths on purpose: the tail bytes of the per-4 rolling
// XOR are where off-by-one key derivations show up.
const v1Scripts = Buffer.concat([Buffer.from([0x04, 0x08]), Buffer.from("fake-scripts-payload-0123456789", "latin1")]);
const v1Items = Buffer.from("second-entry-payload!", "latin1");

const v1Dir = path.join(os.tmpdir(), `rmch-v1-test-${process.pid}`);
const v1Archive = path.join(v1Dir, "Game.rgssad");
makeV1Archive(v1Archive, [[SCRIPTS_V1, v1Scripts], [ITEMS_V1, v1Items]]);

const v1Index = readIndex(v1Archive);
ok("v1 index parses", v1Index.version === 1 && v1Index.entries.size === 2);
check("v1 extract round-trips the first entry", extractEntry(v1Archive, SCRIPTS_V1), v1Scripts);
check("v1 extract round-trips the second entry (chain position)", extractEntry(v1Archive, ITEMS_V1), v1Items);

// Patch with a DIFFERENT length: the tail copy must shift and the trailing
// entry must still decrypt.
const v1Patched = Buffer.concat([Buffer.from([0x04, 0x08]), Buffer.from("patched-with-rmch-bridge-aaaaaaaaaa", "latin1")]);
const v1Out = path.join(v1Dir, "out.rgssad");
const v1Result = patchEntry({ src: v1Archive, dst: v1Out, entry: SCRIPTS_V1, data: v1Patched });
ok("v1 patch verified", v1Result.verify === true, JSON.stringify(v1Result));
ok("v1 patch recorded the new size", v1Result.size === v1Patched.length, `size=${v1Result.size}`);
check("v1 patched payload reads back", extractEntry(v1Out, SCRIPTS_V1), v1Patched);
check("v1 untouched entry survives patching", extractEntry(v1Out, ITEMS_V1), v1Items);

// v2 stays refused: its index parses (same layout), but the payload derivation
// is unverified without a real VX sample.
const v2Archive = path.join(v1Dir, "Game.rgss2a");
makeV1Archive(v2Archive, [[SCRIPTS_V1, v1Scripts]], 0x02);
ok("v2 index parses", readIndex(v2Archive).version === 2);
let v2Threw = "";
try { extractEntry(v2Archive, SCRIPTS_V1); } catch (e) { v2Threw = e.message; }
ok("v2 extract refuses", /not supported/.test(v2Threw), v2Threw);
v2Threw = "";
try { patchEntry({ src: v2Archive, dst: path.join(v1Dir, "out2.rgss2a"), entry: SCRIPTS_V1, data: Buffer.alloc(1) }); } catch (e) { v2Threw = e.message; }
ok("v2 patch refuses", /only supported for v1 and v3/.test(v2Threw), v2Threw);

try {
  for (const f of ["Game.rgssad", "out.rgssad", "Game.rgss2a", "out2.rgss2a"]) {
    try { unlinkSync(path.join(v1Dir, f)); } catch (_) {}
  }
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
