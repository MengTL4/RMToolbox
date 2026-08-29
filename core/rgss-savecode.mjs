// save.contents.apply translator for RGSS: the MV/MZ bridge JsonEx-parses the
// edited tree in-page, but RGSS Ruby (1.8.1) has no JSON parser and a pure-Ruby
// one would crawl on multi-MB contents. Instead the bridge's save.contents.get
// emits a tagged JSON tree (see the dumper in runtime/rgss-bridge/bridge.rb)
// and this module turns the edited tree into Ruby SOURCE that the bridge
// evals — Ruby's own parser does the heavy lifting at C speed.
//
// Tag shapes produced by the bridge dumper (everything else is plain JSON):
//   {"@b64":"..."}                 binary string (not valid UTF-8)
//   {"@sym":"name"}                Symbol
//   {"@i":"123..."}                integer beyond 2^53 (JSON can't carry it)
//   {"@f":"NaN"|"Infinity"|"-Infinity"}
//   {"@hash":[[k,v],...]}          Hash with typed keys (JSON objects can't)
//   {"@table":{"x":n,"y":n,"z":n,"data":[...]}}   RGSS Table (C class)
//   {"@color":[r,g,b,a]} / {"@tone":[r,g,b,g]} / {"@rect":[x,y,w,h]}
//   {"@cls":"Class::Name","@iv":{"@ivar":value,...}}   any other object
//
// Shared nodes (DAG aliasing or cycles) additionally carry "@id":N on their
// first occurrence — {"@id":N,"@arr":[...]} / {"@id":N,"@hash":[...]} /
// {"@id":N,"@cls":...} — and later occurrences arrive as {"@ref":N}. The
// builder allocates the node and registers the id BEFORE emitting its
// children, so a ref pointing at an in-progress ancestor (a cycle) resolves.

const MAX_TABLE_CELLS = 5_000_000;
const CONST_NAME_RE = /^[A-Z]\w*(::[A-Z]\w*)*$/;
const IVAR_NAME_RE = /^@[A-Za-z_]\w*$/;

// Double-quoted Ruby literal with byte-level escapes: UTF-8 bytes above ASCII
// become \xHH so the literal means the same bytes under Ruby 1.8 (encoding-less)
// and 1.9.2 (source-encoding-sensitive) alike. Non-ASCII strings get an
// explicit force_encoding("UTF-8") on 1.9.2 — RGSS3 save strings carry the
// UTF-8 ivar and game scripts compare against UTF-8 literals.
export function rubyStringLiteral(value) {
  const bytes = Buffer.from(value, "utf8");
  let out = '"';
  let high = false;
  for (const b of bytes) {
    if (b === 0x22) out += '\\"';
    else if (b === 0x5c) out += "\\\\";
    else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
    else {
      out += "\\x" + b.toString(16).padStart(2, "0");
      if (b >= 0x80) high = true;
    }
  }
  out += '"';
  if (high) out = `(s=${out};s.force_encoding("UTF-8") if s.respond_to?(:force_encoding);s)`;
  return out;
}

function rubyFloatLiteral(tag) {
  if (tag === "NaN") return "(0.0/0.0)";
  if (tag === "Infinity") return "(1.0/0.0)";
  if (tag === "-Infinity") return "(-1.0/0.0)";
  throw new Error(`unknown float tag: ${tag}`);
}

function rubyNumberLiteral(value) {
  if (!Number.isFinite(value)) throw new Error(`non-finite number without a float tag: ${value}`);
  return String(value);
}

// Build the Ruby source for a contents hash. Returns the source string; the
// bridge evals it and gets back { "system" => ..., "party" => ..., ... }.
export function rgssContentsCode(json) {
  let tree;
  try {
    tree = JSON.parse(json);
  } catch (error) {
    throw new Error(`contents json does not parse: ${error.message}`);
  }
  if (!tree || typeof tree !== "object" || Array.isArray(tree)) {
    throw new Error("contents json must be a top-level object");
  }

  const lines = [];
  const ids = new Map(); // "@id" serial -> generated variable name
  let seq = 0;

  // Compound nodes emit "build" lines and evaluate to their variable name;
  // primitives return a literal expression inline.
  function emit(node) {
    if (node === null) return "nil";
    if (node === true) return "true";
    if (node === false) return "false";
    if (typeof node === "number") return rubyNumberLiteral(node);
    if (typeof node === "string") return rubyStringLiteral(node);
    if (Array.isArray(node)) return "[" + node.map((item) => emit(item)).join(", ") + "]";
    if (typeof node === "object") return emitTagged(node);
    throw new Error(`unsupported json value: ${typeof node}`);
  }

  function emitTagged(node) {
    const keys = Object.keys(node);
    if (keys.length === 1 && typeof node["@ref"] === "number") {
      const v = ids.get(node["@ref"]);
      if (!v) throw new Error(`@ref ${node["@ref"]} has no matching @id (was the shared node edited away?)`);
      return v;
    }
    // "@id" marks a shared node's first occurrence; strip it for tag dispatch.
    const id = typeof node["@id"] === "number" ? node["@id"] : null;
    if (keys.length === 1 && typeof node["@b64"] === "string") {
      // Base64 is alphabet-safe, no escaping needed.
      return `("${node["@b64"]}").unpack("m")[0]`;
    }
    if (keys.length === 1 && typeof node["@sym"] === "string") {
      return `${rubyStringLiteral(node["@sym"])}.to_sym`;
    }
    if (keys.length === 1 && typeof node["@i"] === "string") {
      return `Integer("${node["@i"]}")`;
    }
    if (keys.length === 1 && typeof node["@f"] === "string") {
      return rubyFloatLiteral(node["@f"]);
    }
    // Marshal-undumpable objects (live Fiber/Proc/Thread...) come back as nil.
    if (keys.length === 1 && typeof node["@dead"] === "string") {
      return "nil";
    }
    // A class/module object round-trips as a constant reference.
    if (keys.length === 1 && typeof node["@cref"] === "string") {
      if (!CONST_NAME_RE.test(node["@cref"])) throw new Error(`bad constant name in @cref: ${node["@cref"]}`);
      return `::${node["@cref"]}`;
    }
    if (Array.isArray(node["@arr"])) {
      const v = `_a${seq++}`;
      lines.push(`${v} = []`);
      if (id !== null) ids.set(id, v);
      lines.push(`${v}.concat([${node["@arr"].map((item) => emit(item)).join(", ")}])`);
      return v;
    }
    if (Array.isArray(node["@hash"])) {
      const pairs = node["@hash"].map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error("@hash entries must be [key, value]");
        return `${emit(pair[0])} => ${emit(pair[1])}`;
      });
      if (id === null) return "{" + pairs.join(", ") + "}";
      const v = `_h${seq++}`;
      lines.push(`${v} = {}`);
      ids.set(id, v);
      lines.push(`${v}.merge!({${pairs.join(", ")}})`);
      return v;
    }
    if (keys.length === 1 && Array.isArray(node["@color"])) return colorLiteral("Color", node["@color"]);
    if (keys.length === 1 && Array.isArray(node["@tone"])) return colorLiteral("Tone", node["@tone"]);
    if (keys.length === 1 && Array.isArray(node["@rect"])) return rectLiteral(node["@rect"]);
    if (keys.length === 1 && node["@table"] && typeof node["@table"] === "object") {
      return emitTable(node["@table"]);
    }
    if (typeof node["@cls"] === "string" && node["@iv"] && typeof node["@iv"] === "object" && !Array.isArray(node["@iv"])) {
      return emitObject(node["@cls"], node["@iv"], id);
    }
    throw new Error(`unknown tagged node: ${keys.join(", ").slice(0, 80)}`);
  }

  function colorLiteral(kind, values) {
    if (values.length !== 4) throw new Error(`@${kind.toLowerCase()} needs 4 components`);
    return `::${kind}.new(${values.map((v) => rubyNumberLiteral(v)).join(", ")})`;
  }

  function rectLiteral(values) {
    if (values.length !== 4) throw new Error("@rect needs 4 components");
    return `::Rect.new(${values.map((v) => rubyNumberLiteral(v)).join(", ")})`;
  }

  function emitTable(spec) {
    // "d" is the accessor arity the bridge probed (1D passages-style tables
    // reject three-index access); trees from older bridges default to 3.
    const dims = [1, 2, 3].includes(Math.floor(Number(spec.d))) ? Math.floor(Number(spec.d)) : 3;
    const sizes = [spec.x, spec.y, spec.z].slice(0, dims).map((d) => Math.floor(Number(d)));
    if (sizes.some((d) => !Number.isFinite(d) || d < 1)) throw new Error("@table dimensions must be >= 1");
    const data = Array.isArray(spec.data) ? spec.data : [];
    const cells = sizes.reduce((a, b) => a * b, 1);
    if (data.length !== cells) throw new Error(`@table data has ${data.length} cells, expected ${cells}`);
    if (cells > MAX_TABLE_CELLS) throw new Error(`@table too large: ${cells} cells`);
    const id = seq++;
    const v = `_t${id}`;
    lines.push(`${v} = ::Table.new(${sizes.join(", ")})`);
    lines.push(`_d${id} = [${data.map((v2) => rubyNumberLiteral(v2)).join(", ")}]`);
    lines.push(`_i${id} = 0`);
    const axes = ["x", "y", "z"].slice(0, dims);
    // The bridge writes data x-fastest (x innermost), so nest z..y..x.
    const loops = axes.slice().reverse();
    loops.forEach((axis, level) => {
      lines.push(`${"  ".repeat(level)}for _${axis}${id} in 0...${sizes[axes.indexOf(axis)]}`);
    });
    const idx = axes.map((axis) => `_${axis}${id}`).join(", ");
    lines.push(`${"  ".repeat(dims)}${v}[${idx}] = _d${id}[_i${id}]`);
    lines.push(`${"  ".repeat(dims)}_i${id} += 1`);
    for (let level = dims - 1; level >= 0; level -= 1) {
      lines.push(`${"  ".repeat(level)}end`);
    }
    return v;
  }

  function emitObject(className, ivars, id) {
    if (!CONST_NAME_RE.test(className)) throw new Error(`bad class name in @cls: ${className}`);
    const v = `_o${seq++}`;
    lines.push(`${v} = ::${className}.allocate`);
    // Register before the ivars: one of them may @ref this very node (cycle).
    if (id !== null) ids.set(id, v);
    for (const [ivar, value] of Object.entries(ivars)) {
      if (!IVAR_NAME_RE.test(ivar)) throw new Error(`bad ivar name in @iv: ${ivar}`);
      lines.push(`${v}.instance_variable_set(${rubyStringLiteral(ivar)}, ${emit(value)})`);
    }
    return v;
  }

  const pairs = Object.entries(tree).map(([key, value]) => `${rubyStringLiteral(key)} => ${emit(value)}`);
  lines.push("{ " + pairs.join(", ") + " }");
  return lines.join("\n");
}
