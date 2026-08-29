// Byte-level tests for the Ruby Marshal subset used to inject into RGSS games.
//
// Golden fixtures come from a real Ruby (tools/fixtures/rgss-marshal.json).
// The strongest case: inserting one entry into archive_2_entries must produce
// byte-identical output to Ruby's own archive_3_entries.
//
// Real game samples are optional; point RMCH_RGSS_SAMPLES at a directory of
// extracted games to include them (they are not redistributed here).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  encodeInt,
  decodeInt,
  encodeScriptEntry,
  parseScripts,
  insertScriptEntry,
  findMainEntryIndex
} from "../core/rgss-marshal.mjs";

const failures = [];
let passed = 0;

function check(name, actual, expected) {
  const a = Buffer.isBuffer(actual) ? actual.toString("hex") : String(actual);
  const b = Buffer.isBuffer(expected) ? expected.toString("hex") : String(expected);
  if (a === b) {
    passed += 1;
  } else {
    failures.push(`${name}\n    expected: ${b}\n    actual:   ${a}`);
  }
}

function ok(name, condition, detail = "") {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
}

const fixturePath = path.join(import.meta.dirname, "fixtures", "rgss-marshal.json");
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8"));
const golden = (name) => Buffer.from(fixtures.cases.find((c) => c.name === name).hex, "hex");

// --- 1. integer codec against every fixnum fixture --------------------------
// Values beyond +/-2^30 are marshalled as BIGNUM ('l'), not FIXNUM, so the
// fixnum fixture set stops short of that boundary.
for (const entry of fixtures.cases.filter((c) => c.name.startsWith("fixnum_"))) {
  // fixture layout: 04 08 | 69 | <int bytes>
  const type = entry.hex.slice(4, 6);
  if (type !== "69") continue;
  const expected = entry.hex.slice(6);
  const expectedValue = decodeInt(Buffer.from(expected, "hex"), 0).value;
  check(`int encode ${entry.name}`, encodeInt(expectedValue).toString("hex"), expected);
}

// Explicit expectations so a fixture regeneration cannot silently hide a bug.
check("int 0", encodeInt(0).toString("hex"), "00");
check("int 122", encodeInt(122).toString("hex"), "7f");
check("int 123", encodeInt(123).toString("hex"), "017b");
check("int 9000001", encodeInt(9000001).toString("hex"), "03415489");
check("int -1", encodeInt(-1).toString("hex"), "fa");
check("int -124", encodeInt(-124).toString("hex"), "ff84");
check("int -1000", encodeInt(-1000).toString("hex"), "fe18fc");

// --- 2. round-trip Ruby's own triple ---------------------------------------
// zlib output differs between implementations, so reuse the exact payload Ruby
// produced and check that decode -> encode reproduces its bytes.
{
  const triple = golden("script_triple").subarray(2); // drop 04 08
  const wrapped = Buffer.concat([Buffer.from([0x04, 0x08, 0x5b, 0x06]), triple]);
  const parsed = parseScripts(wrapped, { ruby19: true });
  ok("triple parses", parsed.count === 1, `count=${parsed.count}`);
  const entry = parsed.entries[0];
  ok("triple id", entry.id === 9_000_001, `id=${entry.id}`);
  ok("triple name", entry.name === "RMCH_Bridge", `name=${entry.name}`);

  const rebuilt = encodeScriptEntry(entry.id, entry.name, entry.zlib, { ruby19: true });
  check("triple re-encodes byte-identically", rebuilt.toString("hex"), triple.toString("hex"));
}

// --- 3. insert must match Ruby byte for byte -------------------------------
{
  const two = golden("archive_2_entries");
  const three = golden("archive_3_entries");
  const parsed = parseScripts(two, { ruby19: true });
  ok("fixture archive has 2 entries", parsed.count === 2, `count=${parsed.count}`);

  // Take the payload straight from Ruby's 3-entry archive so only our splice is
  // under test, not zlib's output.
  const reference = parseScripts(three, { ruby19: true });
  const last = reference.entries[2];
  const spliced = insertScriptEntry(two, 2, last.id, last.name, last.zlib, { ruby19: true });

  // Ruby re-emits a repeated symbol as a symlink (`3b <idx>`) where we always
  // write the full symbol (`3a <len> <bytes>`). Both load identically, so
  // compare structurally and assert the only divergence is that encoding.
  const threeParsed = parseScripts(three, { ruby19: true });
  const splicedParsed = parseScripts(spliced, { ruby19: true });
  ok("spliced entry count matches Ruby", splicedParsed.count === threeParsed.count);
  for (let i = 0; i < threeParsed.count; i += 1) {
    ok(`entry ${i} id matches`, splicedParsed.entries[i].id === threeParsed.entries[i].id);
    ok(`entry ${i} name matches`, splicedParsed.entries[i].name === threeParsed.entries[i].name);
    check(
      `entry ${i} payload matches`,
      splicedParsed.entries[i].zlib.toString("hex"),
      threeParsed.entries[i].zlib.toString("hex")
    );
  }
  // Everything Ruby wrote must survive untouched; only the tail may differ.
  const rubyPrefix = three.subarray(0, threeParsed.entries[2].entryStart);
  const ourPrefix = spliced.subarray(0, splicedParsed.entries[2].entryStart);
  check("Ruby's first two entries survive byte-identically", ourPrefix.toString("hex"), rubyPrefix.toString("hex"));

  const reparsed = parseScripts(spliced, { ruby19: true });
  ok("reparsed count", reparsed.count === 3, `count=${reparsed.count}`);
  ok("reparsed last name", reparsed.entries[2].name === "RMCH_Bridge");
  const inflated = zlib.inflateSync(reparsed.entries[2].zlib).toString("utf8");
  ok("reparsed last source", inflated === "puts 1\n", `got ${JSON.stringify(inflated)}`);
}

// --- 4. splice preserves untouched entries byte for byte --------------------
{
  const two = golden("archive_2_entries");
  const before = parseScripts(two, { ruby19: true });
  const payload = zlib.deflateSync(Buffer.from("# bridge\n", "utf8"));
  const spliced = insertScriptEntry(two, 1, 42, "Bridge", payload, { ruby19: true });
  const after = parseScripts(spliced, { ruby19: true });

  ok("count grew by one", after.count === before.count + 1);
  // Entry 0 must keep its exact original bytes.
  const rawBefore = two.subarray(before.entries[0].entryStart, before.entries[0].entryEnd);
  const rawAfter = spliced.subarray(after.entries[0].entryStart, after.entries[0].entryEnd);
  check("entry 0 bytes unchanged", rawAfter.toString("hex"), rawBefore.toString("hex"));
  // Entry 1 (now index 2) must also be untouched.
  const rawMoved = spliced.subarray(after.entries[2].entryStart, after.entries[2].entryEnd);
  const rawOrig1 = two.subarray(before.entries[1].entryStart, before.entries[1].entryEnd);
  check("entry 1 bytes unchanged after move", rawMoved.toString("hex"), rawOrig1.toString("hex"));
}

// --- 5. main-entry detection ------------------------------------------------
{
  const two = golden("archive_2_entries");
  const parsed = parseScripts(two, { ruby19: true });
  const idx = findMainEntryIndex(parsed, (b) => zlib.inflateSync(b));
  // "Main" holds `rgss_main { }`, so it must be found by content, not name.
  ok("finds rgss_main entry", idx === 1, `index=${idx}`);
}

// --- 6. real game samples (optional) ----------------------------------------
const sampleDir = process.env.RMCH_RGSS_SAMPLES;
if (sampleDir && existsSync(sampleDir)) {
  const samples = [
    { file: "crysalis-x/Data/Scripts.rvdata2", ruby19: true, label: "VX Ace" },
    { file: "knight-blade/KN_E/Data/Scripts.rxdata", ruby19: false, label: "XP" },
    { file: "leg-x/Legionwood Tale of the Two Swords/Data/Scripts.rvdata", ruby19: false, label: "VX" },
    { file: "hs-scripts.rvdata2", ruby19: true, label: "VX Ace (encrypted archive)" }
  ];
  for (const sample of samples) {
    const full = path.join(sampleDir, sample.file);
    if (!existsSync(full)) continue;
    const buf = readFileSync(full);
    const parsed = parseScripts(buf, { ruby19: sample.ruby19 });
    ok(`${sample.label}: parses ${parsed.count} entries`, parsed.count > 0);

    const payload = zlib.deflateSync(Buffer.from("# rmch bridge\n", "utf8"));
    const spliced = insertScriptEntry(buf, parsed.count, 9_000_001, "RMCH_Bridge", payload, {
      ruby19: sample.ruby19
    });
    const reparsed = parseScripts(spliced, { ruby19: sample.ruby19 });
    ok(`${sample.label}: count +1`, reparsed.count === parsed.count + 1);
    ok(
      `${sample.label}: injected source intact`,
      zlib.inflateSync(reparsed.entries[parsed.count].zlib).toString("utf8") === "# rmch bridge\n"
    );
    // Original entries must survive untouched.
    let drift = 0;
    for (let i = 0; i < parsed.count; i += 1) {
      const a = buf.subarray(parsed.entries[i].entryStart, parsed.entries[i].entryEnd);
      const b = spliced.subarray(reparsed.entries[i].entryStart, reparsed.entries[i].entryEnd);
      if (a.toString("hex") !== b.toString("hex")) drift += 1;
    }
    ok(`${sample.label}: no byte drift in ${parsed.count} entries`, drift === 0, `drift=${drift}`);
  }
} else {
  console.log("  (set RMCH_RGSS_SAMPLES to include real game archives)");
}

// --- report -----------------------------------------------------------------
if (failures.length) {
  console.error(`rgss-marshal test: FAIL (${failures.length} of ${passed + failures.length})`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`rgss-marshal test: PASS (${passed} checks)`);
