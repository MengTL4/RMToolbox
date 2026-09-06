// Dump script entries from a Scripts.rxdata (by name regex or index).
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { parseScripts } from "../core/rgss-marshal.mjs";

const [, , file, nameRe] = process.argv;
const raw = readFileSync(file);
const parsed = parseScripts(raw);
const re = nameRe ? new RegExp(nameRe, "i") : null;
for (const e of parsed.entries) {
  if (re && !re.test(e.name)) continue;
  let src = "";
  try { src = zlib.inflateSync(e.zlib).toString("utf8"); } catch { src = "<inflate failed>"; }
  console.log(`\n===== [${e.index}] ${e.name} (${src.length} chars) =====`);
  console.log(src);
}
