// One-off: replace the RMCH_Bridge entry in the given shadow Scripts.rxdata
// with a path-capability probe (mkxp-z PhysFS sandbox behavior).
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseScripts, encodeScriptEntry } from "../core/rgss-marshal.mjs";

const target = process.argv[2];
const raw = readFileSync(target);
const parsed = parseScripts(raw);
const entry = parsed.entries.find((en) => en.name === "RMCH_Bridge");
if (!entry) throw new Error("RMCH_Bridge entry not found");

const probe = [
  "out = []",
  'out << "pwd=" + Dir.pwd',
  'abs = File.join(Dir.pwd, "zz-abs.txt")',
  'begin; File.open(abs, "wb") { |f| f.write("1") }; out << "abs OK"; rescue Exception => ex; out << "abs " + ex.class.to_s + ": " + ex.message.to_s; end',
  'begin; File.open("./zz-dot.txt", "wb") { |f| f.write("1") }; out << "dot OK"; rescue Exception => ex; out << "dot " + ex.class.to_s + ": " + ex.message.to_s; end',
  'begin; File.open("zz-bare.txt", "wb") { |f| f.write("1") }; out << "bare OK"; rescue Exception => ex; out << "bare " + ex.class.to_s + ": " + ex.message.to_s; end',
  'begin; File.open("zz-bare.txt", "rb") { |f| f.read }; out << "readbare OK"; rescue Exception => ex; out << "readbare " + ex.class.to_s; end',
  'begin; out << "exist=" + File.exist?("zz-bare.txt").to_s; rescue Exception => ex; out << "exist " + ex.class.to_s; end',
  'begin; File.open("zz-report.txt", "wb") { |f| f.write(out.join("\n")) }; rescue Exception; end'
].join("\n");

const rep = encodeScriptEntry(
  entry.id,
  entry.name,
  zlib.deflateSync(Buffer.from(probe, "utf8")),
  {
    nameIvar: parsed.nameIvar,
    bodyIvar: parsed.bodyIvar
  }
);
writeFileSync(
  target,
  Buffer.concat([
    raw.subarray(0, entry.entryStart),
    rep,
    raw.subarray(entry.entryEnd)
  ])
);
console.log("probe installed into", target);
