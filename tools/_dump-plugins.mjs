// Dump plugin scripts from an Essentials PluginScripts.rxdata.
// Format: Marshal Array of [name, meta_hash, [[section, zlib_blob], ...]].
//
//   node tools/_dump-plugins.mjs <PluginScripts.rxdata> [nameRegex]
import { readFileSync } from "node:fs";
import zlib from "node:zlib";
import { decodeInt } from "../core/rgss-marshal.mjs";

const [, , file, nameRe] = process.argv;
const buf = readFileSync(file);
const objects = [];
const symbols = [];

// Strings may be zlib blobs, so keep raw Buffers; decode UTF-8 only on demand.
function readValue(pos) {
  const t = String.fromCharCode(buf[pos]);
  if (t === "0") return [null, pos + 1];
  if (t === "T") return [true, pos + 1];
  if (t === "F") return [false, pos + 1];
  if (t === "@") { const n = decodeInt(buf, pos + 1); return [objects[n.value], pos + 1 + n.size]; }
  if (t === ":") {
    const n = decodeInt(buf, pos + 1); const start = pos + 1 + n.size;
    const sym = Symbol.for(buf.toString("utf8", start, start + n.value));
    symbols.push(sym);
    return [sym, start + n.value];
  }
  if (t === ";") { const n = decodeInt(buf, pos + 1); return [symbols[n.value], pos + 1 + n.size]; }
  if (t === '"' || t === "I") {
    let p = pos; let ivar = false;
    if (t === "I") { ivar = true; p += 1; }
    if (String.fromCharCode(buf[p]) !== '"') throw new Error(`expected string at ${p}`);
    const n = decodeInt(buf, p + 1); const start = p + 1 + n.size;
    const value = buf.subarray(start, start + n.value);
    let end = start + n.value;
    if (ivar) {
      objects.push(value);
      const cnt = decodeInt(buf, end); end += cnt.size;
      for (let i = 0; i < cnt.value; i++) {
        const t2 = String.fromCharCode(buf[end]);
        if (t2 === ":") { const sn = decodeInt(buf, end + 1); end += 1 + sn.size + sn.value + 1; }
        else if (t2 === ";") { const sn = decodeInt(buf, end + 1); end += 1 + sn.size + 1; }
        else throw new Error(`bad ivar tail at ${end}`);
      }
    }
    return [value, end];
  }
  if (t === "[") {
    const n = decodeInt(buf, pos + 1);
    let p = pos + 1 + n.size;
    const arr = []; objects.push(arr);
    for (let i = 0; i < n.value; i++) { const [v, np] = readValue(p); arr.push(v); p = np; }
    return [arr, p];
  }
  if (t === "{") {
    const n = decodeInt(buf, pos + 1);
    let p = pos + 1 + n.size;
    const pairs = []; objects.push(pairs);
    for (let i = 0; i < n.value; i++) {
      const [k, np] = readValue(p); const [v, np2] = readValue(np);
      pairs.push([k, v]); p = np2;
    }
    return [pairs, p];
  }
  throw new Error(`unsupported Marshal type 0x${buf[pos].toString(16)} at ${pos}`);
}

if (buf[0] !== 0x04 || buf[1] !== 0x08) throw new Error("not Marshal 4.8");
const [root] = readValue(2);
if (!Array.isArray(root)) throw new Error("root is not an array");

const str = (v) => (Buffer.isBuffer(v) ? v.toString("utf8") : String(v));
const re = nameRe ? new RegExp(nameRe, "i") : null;
let matched = 0;
for (const plugin of root) {
  if (!Array.isArray(plugin)) continue;
  const [name, , scripts] = plugin;
  const pluginName = str(name);
  if (re && !re.test(pluginName)) continue;
  matched++;
  console.log(`\n##### ${pluginName} #####`);
  if (!Array.isArray(scripts)) { console.log("(no scripts)"); continue; }
  for (const scr of scripts) {
    if (!Array.isArray(scr)) continue;
    let code = "<inflate failed>";
    try { code = zlib.inflateSync(Buffer.from(scr[1])).toString("utf8"); } catch {}
    console.log(`\n===== ${pluginName} :: ${str(scr[0])} (${code.length} chars) =====`);
    console.log(code);
  }
}
if (!matched) {
  console.log("no match; available plugins:");
  for (const plugin of root) if (Array.isArray(plugin)) console.log("  " + str(plugin[0]));
}
