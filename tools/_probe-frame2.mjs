// One-off: verify Graphics.update alias state and hook EventScene#update directly.
import { readFileSync, writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseScripts, encodeScriptEntry } from "../core/rgss-marshal.mjs";

const target = process.argv[2];
const raw = readFileSync(target);
const parsed = parseScripts(raw);
const entry = parsed.entries.find((en) => en.name === "RMCH_Bridge");
if (!entry) throw new Error("RMCH_Bridge entry not found");

const probe = [
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
  '  begin; File.open("zz-alias-fail.txt", "wb") { |f| f.write("G: " + ex.class.to_s + " " + ex.message.to_s) }; rescue Exception; end',
  "end",
  "begin",
  "  if defined?(EventScene)",
  "    EventScene.class_eval do",
  "      alias_method :zz_eu_orig, :update",
  "      def update",
  "        unless $zz_eu",
  "          $zz_eu = true",
  '          begin; File.open("zz-eventscene-update.txt", "wb") { |f| f.write("fired " + Time.now.to_s) }; rescue Exception; end',
  "        end",
  "        zz_eu_orig",
  "      end",
  "    end",
  "  else",
  '    File.open("zz-no-eventscene.txt", "wb") { |f| f.write("EventScene undefined") }',
  "  end",
  "rescue Exception => ex",
  '  begin; File.open("zz-eventscene-fail.txt", "wb") { |f| f.write(ex.class.to_s + " " + ex.message.to_s) }; rescue Exception; end',
  "end",
  "begin",
  '  owner = Graphics.method(:update).owner.to_s rescue "?"',
  '  File.open("zz-owner.txt", "wb") { |f| f.write("update owner=" + owner + " singletons=" + Graphics.singleton_methods.sort.join(",")) }',
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
console.log("probe v2 installed");
