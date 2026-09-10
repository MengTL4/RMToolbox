// Show the raw Marshal structure (types only, truncated strings) of a
// PluginScripts.rxdata root element matching a name regex.
//   node tools/_dump-plugins.mjs <file> --raw <nameRegex>
import { readFileSync } from "node:fs";
import { decodeInt } from "../core/rgss-marshal.mjs";

const [, , file, nameRe] = process.argv;
const buf = readFileSync(file);
const objects = [];
const symbols = [];

function readValue(pos) {
  const t = String.fromCharCode(buf[pos]);
  if (t === "0") return [null, pos + 1];
  if (t === "T") return [true, pos + 1];
  if (t === "F") return [false, pos + 1];
  if (t === "@") {
    const n = decodeInt(buf, pos + 1);
    return [objects[n.value], pos + 1 + n.size];
  }
  if (t === ":") {
    const n = decodeInt(buf, pos + 1);
    const start = pos + 1 + n.size;
    const sym = Symbol.for(buf.toString("utf8", start, start + n.value));
    symbols.push(sym);
    return [sym, start + n.value];
  }
  if (t === ";") {
    const n = decodeInt(buf, pos + 1);
    return [symbols[n.value], pos + 1 + n.size];
  }
  if (t === '"' || t === "I") {
    let p = pos;
    let ivar = false;
    if (t === "I") {
      ivar = true;
      p += 1;
    }
    const n = decodeInt(buf, p + 1);
    const start = p + 1 + n.size;
    const value = buf.toString("utf8", start, start + n.value);
    let end = start + n.value;
    if (ivar) {
      objects.push(value);
      const cnt = decodeInt(buf, end);
      end += cnt.size;
      for (let i = 0; i < cnt.value; i++) {
        const t2 = String.fromCharCode(buf[end]);
        if (t2 === ":") {
          const sn = decodeInt(buf, end + 1);
          end += 1 + sn.size + sn.value + 1;
        } else if (t2 === ";") {
          const sn = decodeInt(buf, end + 1);
          end += 1 + sn.size + 1;
        } else throw new Error(`bad ivar tail at ${end}`);
      }
    }
    return [value, end];
  }
  if (t === "[") {
    const n = decodeInt(buf, pos + 1);
    let p = pos + 1 + n.size;
    const arr = [];
    objects.push(arr);
    for (let i = 0; i < n.value; i++) {
      const [v, np] = readValue(p);
      arr.push(v);
      p = np;
    }
    return [arr, p];
  }
  if (t === "{") {
    const n = decodeInt(buf, pos + 1);
    let p = pos + 1 + n.size;
    const pairs = [];
    objects.push(pairs);
    for (let i = 0; i < n.value; i++) {
      const [k, np] = readValue(p);
      const [v, np2] = readValue(np);
      pairs.push([k, v]);
      p = np2;
    }
    return [pairs, p];
  }
  throw new Error(
    `unsupported Marshal type 0x${buf[pos].toString(16)} at ${pos}`
  );
}

if (buf[0] !== 0x04 || buf[1] !== 0x08) throw new Error("not Marshal 4.8");
const [root] = readValue(2);

function describe(v, depth = 0) {
  if (v === null) return "nil";
  if (typeof v === "string")
    return depth >= 2
      ? `str(${v.length})`
      : JSON.stringify(v.slice(0, 60)) + (v.length > 60 ? "…" : "");
  if (typeof v === "symbol") return ":" + String(v).slice(7, -1);
  if (typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    if (depth > 4) return `[…${v.length} items]`;
    return "[" + v.map((x) => describe(x, depth + 1)).join(", ") + "]";
  }
  return typeof v;
}

// root: hash-like pairs array
console.log(`root: ${root.length} pairs`);
const re = nameRe ? new RegExp(nameRe, "i") : null;
for (const [k, v] of root) {
  const ks = describe(k);
  if (re && !re.test(ks)) continue;
  console.log("KEY  :", ks);
  console.log("VALUE:", describe(v));
}
