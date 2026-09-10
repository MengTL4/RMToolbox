// One-off: replace the RMCH_Bridge entry with a hook/pump firing probe.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseScripts, encodeScriptEntry } from "../../core/rgss-marshal.mjs";

const target = process.argv[2];
const raw = readFileSync(target);
const parsed = parseScripts(raw);
const entry = parsed.entries.find((en) => en.name === "RMCH_Bridge");
if (!entry) throw new Error("RMCH_Bridge entry not found");

const probe = [
  "Object.send(:define_method, :zz_pump) do",
  "  unless $zz_done",
  "    $zz_done = true",
  '    begin; File.open("zz-pump.txt", "wb") { |f| f.write("pumped " + Time.now.to_s) }; rescue Exception; end',
  "  end",
  "end",
  "hooked = []",
  "ObjectSpace.each_object(Class) do |klass|",
  "  next unless klass.to_s =~ /^Scene_/",
  '  next unless klass.instance_methods(false).map { |m| m.to_s }.include?("update")',
  "  hooked << klass.to_s",
  "  klass.class_eval do",
  "    zz_orig = instance_method(:update)",
  "    define_method(:update) do |*args|",
  "      begin; zz_pump; rescue Exception; end",
  "      zz_orig.bind(self).call(*args)",
  "    end",
  "  end",
  "end",
  'begin; File.open("zz-hooked.txt", "wb") { |f| f.write(hooked.join("\n")) }; rescue Exception; end'
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
console.log("hook probe installed");
