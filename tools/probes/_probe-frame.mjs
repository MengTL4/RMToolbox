// One-off: probe which frame functions fire at the title screen.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseScripts, encodeScriptEntry } from "../../core/rgss-marshal.mjs";

const target = process.argv[2];
const raw = readFileSync(target);
const parsed = parseScripts(raw);
const entry = parsed.entries.find((en) => en.name === "RMCH_Bridge");
if (!entry) throw new Error("RMCH_Bridge entry not found");

const probe = [
  'begin; File.open("zz-eval.txt", "wb") { |f| f.write("bridge evaled " + Time.now.to_s) }; rescue Exception; end',
  "begin",
  "  class << Graphics",
  "    alias_method :zz_gu_orig, :update",
  "    def update",
  "      unless $zz_gu",
  "        $zz_gu = true",
  '        begin; File.open("zz-graphics-update.txt", "wb") { |f| f.write("fired " + Time.now.to_s) }; rescue Exception; end',
  "      end",
  "      zz_gu_orig",
  "    end",
  "  end",
  "rescue Exception => ex",
  '  begin; File.open("zz-graphics-alias-fail.txt", "wb") { |f| f.write(ex.class.to_s + " " + ex.message.to_s) }; rescue Exception; end',
  "end",
  "begin",
  "  class << Input",
  "    alias_method :zz_iu_orig, :update",
  "    def update",
  "      unless $zz_iu",
  "        $zz_iu = true",
  '        begin; File.open("zz-input-update.txt", "wb") { |f| f.write("fired " + Time.now.to_s) }; rescue Exception; end',
  "      end",
  "      zz_iu_orig",
  "    end",
  "  end",
  "rescue Exception",
  "end"
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
console.log("frame probe installed");
