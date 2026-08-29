// Minimal Ruby Marshal reader/writer for RGSS script archives.
//
// Scripts.rxdata / .rvdata / .rvdata2 is a Marshal'd array of
//   [id, name, Zlib::Deflate(source)]
//
// Only the subset that appears in those files is implemented. Two encoding
// generations matter and are selected with `ruby19`:
//
//   RGSS1 (XP, Ruby 1.8.1) and RGSS2 (VX, Ruby 1.8.1)
//     strings have no encoding ivar:              22 <len> <bytes>
//   RGSS3 (VX Ace, Ruby 1.9.2)
//     strings carry `:E => true` meaning UTF-8:   49 22 <len> <bytes> 06 3a 06 45 54
//
// Appending is done by splicing bytes, never by reserialising: the untouched
// entries keep their exact original bytes, so a round trip cannot drift.

const MARSHAL_MAJOR = 4;
const MARSHAL_MINOR = 8;

const TYPE_NIL = 0x30; // '0'
const TYPE_TRUE = 0x54; // 'T'
const TYPE_FALSE = 0x46; // 'F'
const TYPE_FIXNUM = 0x69; // 'i'
const TYPE_BIGNUM = 0x6c; // 'l'
const TYPE_STRING = 0x22; // '"'
const TYPE_IVAR = 0x49; // 'I'
const TYPE_ARRAY = 0x5b; // '['
const TYPE_SYMBOL = 0x3a; // ':'
const TYPE_SYMLINK = 0x3b; // ';'
const TYPE_FLOAT = 0x66; // 'f'
const TYPE_HASH = 0x7b; // '{'
const TYPE_HASH_DEFAULT = 0x7d; // '}'
const TYPE_LINK = 0x40; // '@'

// Trailing bytes of a UTF-8 string under Ruby >=1.9: one ivar, `:E => true`.
const UTF8_IVAR_TAIL = Buffer.from([0x06, TYPE_SYMBOL, 0x06, 0x45, TYPE_TRUE]);

export class MarshalError extends Error {}

// --- integer codec ---------------------------------------------------------

// Layout: 0 is a bare zero; 5..127 encode 0..122; 128..251 encode -123..-1;
// 252..255 and 1..4 are a signed byte count followed by two's-complement bytes
// in little-endian order.
export function encodeInt(value) {
  const n = Math.trunc(value);
  if (!Number.isSafeInteger(n)) throw new MarshalError(`int out of safe range: ${value}`);
  if (n === 0) return Buffer.from([0]);
  if (n > 0 && n < 123) return Buffer.from([n + 5]);
  if (n < 0 && n >= -123) return Buffer.from([n + 251]);

  let count = 1;
  while (count < 8) {
    const width = 2 ** (8 * count);
    if (n > 0 ? n < width : n >= -width) break;
    count += 1;
  }
  // Negative values are stored two's-complemented and carry a negative-looking
  // length byte (252..255), which decodeInt reads back as a negative count.
  const raw = n < 0 ? n + 2 ** (8 * count) : n;
  const bytes = Buffer.alloc(count);
  let rest = raw;
  for (let i = 0; i < count; i += 1) {
    bytes[i] = rest & 0xff;
    rest >>= 8;
  }
  const lengthByte = n < 0 ? 256 - count : count;
  return Buffer.concat([Buffer.from([lengthByte]), bytes]);
}

export function decodeInt(buf, pos) {
  if (pos >= buf.length) throw new MarshalError("int: truncated at start");
  const c = buf[pos];
  if (c === 0) return { value: 0, size: 1 };
  if (c >= 5 && c <= 127) return { value: c - 5, size: 1 };
  if (c >= 128 && c <= 251) return { value: c - 251, size: 1 };

  // Byte count: 252..255 mean -4..-1, 1..4 mean 1..4.
  const count = c >= 252 ? 256 - c : c;
  if (count < 1 || count > 8) throw new MarshalError(`int: bad length byte ${c}`);
  if (pos + 1 + count > buf.length) throw new MarshalError("int: truncated payload");

  let value = 0;
  for (let i = 0; i < count; i += 1) {
    value += buf[pos + 1 + i] * 2 ** (8 * i);
  }
  // 252..255 signal a negative value; reconstruct from two's complement.
  if (c >= 252) value -= 2 ** (8 * count);
  return { value, size: 1 + count };
}

// --- value skimmer ---------------------------------------------------------

// Returns the number of bytes consumed by the value starting at `pos`.
// `ruby19` only affects strings (whether they carry an encoding ivar).
function skipValue(buf, pos, ruby19) {
  if (pos >= buf.length) throw new MarshalError("skip: out of range");
  const type = buf[pos];
  switch (type) {
    case TYPE_NIL:
    case TYPE_TRUE:
    case TYPE_FALSE:
      return 1;
    case TYPE_FIXNUM: {
      const { size } = decodeInt(buf, pos + 1);
      return 1 + size;
    }
    case TYPE_BIGNUM: {
      // 'l' sign(+/-) then a length in 16-bit words, then that many bytes.
      const lenInt = decodeInt(buf, pos + 2);
      return 2 + lenInt.size + lenInt.value * 2;
    }
    case TYPE_FLOAT: {
      // 'f' followed by a length-prefixed decimal string.
      const lenInt = decodeInt(buf, pos + 1);
      return 1 + lenInt.size + lenInt.value;
    }
    case TYPE_STRING: {
      const int = decodeInt(buf, pos + 1);
      return 1 + int.size + int.value;
    }
    case TYPE_SYMBOL: {
      const int = decodeInt(buf, pos + 1);
      return 1 + int.size + int.value;
    }
    case TYPE_SYMLINK: {
      const int = decodeInt(buf, pos + 1);
      return 1 + int.size;
    }
    case TYPE_IVAR: {
      let cursor = pos + 1;
      cursor += skipValue(buf, cursor, ruby19);
      const countInt = decodeInt(buf, cursor);
      cursor += countInt.size;
      for (let i = 0; i < countInt.value; i += 1) {
        cursor += skipValue(buf, cursor, ruby19); // symbol / symlink
        cursor += skipValue(buf, cursor, ruby19); // value
      }
      return cursor - pos;
    }
    case TYPE_ARRAY: {
      let cursor = pos + 1;
      const countInt = decodeInt(buf, cursor);
      cursor += countInt.size;
      for (let i = 0; i < countInt.value; i += 1) {
        cursor += skipValue(buf, cursor, ruby19);
      }
      return cursor - pos;
    }
    case TYPE_HASH:
    case TYPE_HASH_DEFAULT: {
      let cursor = pos + 1;
      const countInt = decodeInt(buf, cursor);
      cursor += countInt.size;
      for (let i = 0; i < countInt.value; i += 1) {
        cursor += skipValue(buf, cursor, ruby19);
        cursor += skipValue(buf, cursor, ruby19);
      }
      return cursor - pos;
    }
    case TYPE_LINK: {
      const int = decodeInt(buf, pos + 1);
      return 1 + int.size;
    }
    default:
      throw new MarshalError(`skip: unsupported type 0x${type.toString(16)} at ${pos}`);
  }
}

// A string may or may not carry an encoding ivar depending on how Ruby created
// it (zlib payloads come out ASCII-8BIT under some versions, UTF-8 under
// others), so detect from the bytes instead of assuming.
function readString(buf, pos) {
  if (buf[pos] === TYPE_IVAR && buf[pos + 1] === TYPE_STRING) {
    const int = decodeInt(buf, pos + 2);
    const start = pos + 2 + int.size;
    return {
      value: buf.subarray(start, start + int.value),
      size: skipValue(buf, pos, true),
      ivar: true
    };
  }
  if (buf[pos] === TYPE_STRING) {
    const int = decodeInt(buf, pos + 1);
    const start = pos + 1 + int.size;
    return { value: buf.subarray(start, start + int.value), size: 1 + int.size + int.value, ivar: false };
  }
  throw new MarshalError(`expected a string at ${pos}, got 0x${buf[pos].toString(16)}`);
}

// --- script archive --------------------------------------------------------

function assertHeader(buf) {
  if (buf.length < 4) throw new MarshalError("archive too short");
  if (buf[0] !== MARSHAL_MAJOR || buf[1] !== MARSHAL_MINOR) {
    throw new MarshalError(`unsupported marshal version ${buf[0]}.${buf[1]}`);
  }
  if (buf[2] !== TYPE_ARRAY) throw new MarshalError("script archive root is not an array");
  return decodeInt(buf, 3);
}

/**
 * Parse a script archive without inflating anything.
 * Returns entry offsets so callers can splice bytes safely.
 */
export function parseScripts(buf, { ruby19 = false } = {}) {
  const headerInt = assertHeader(buf);
  const count = headerInt.value;
  const entries = [];
  let cursor = 3 + headerInt.size;
  let nameHasIvar = false;
  let bodyIvarCount = 0;

  for (let i = 0; i < count; i += 1) {
    const entryStart = cursor;
    if (buf[cursor] !== TYPE_ARRAY) {
      throw new MarshalError(`entry ${i} is not an array at ${cursor}`);
    }
    let p = cursor + 1;
    const arity = decodeInt(buf, p);
    p += arity.size;
    if (arity.value !== 3) {
      throw new MarshalError(`entry ${i} has arity ${arity.value}, expected 3`);
    }

    const idInt = decodeInt(buf, p + 1); // skip the 'i' type byte
    const id = idInt.value;
    p += 1 + idInt.size;

    const nameStr = readString(buf, p);
    const name = nameStr.value.toString("utf8");
    p += nameStr.size;

    const bodyStr = readString(buf, p);
    p += bodyStr.size;

    if (i === 0) nameHasIvar = nameStr.ivar;
    if (bodyStr.ivar) bodyIvarCount += 1;

    entries.push({
      index: i,
      id,
      name,
      entryStart,
      entryEnd: p,
      zlib: Buffer.from(bodyStr.value)
    });
    cursor = p;
  }

  return {
    count,
    headerSize: 3 + headerInt.size,
    entries,
    // Mirrors how the file was written so injected entries blend in.
    nameIvar: nameHasIvar,
    bodyIvar: bodyIvarCount > entries.length / 2
  };
}

/**
 * Build the byte triple for one script entry.
 */
export function encodeScriptEntry(id, name, zlibPayload, options = {}) {
  // `ruby19` is shorthand for "UTF-8 names", which is what RGSS3 writes.
  const nameIvar = options.nameIvar ?? options.ruby19 ?? false;
  const bodyIvar = options.bodyIvar ?? false;
  const nameBuf = Buffer.from(name, "utf8");

  const stringBytes = (payload, withIvar) =>
    withIvar
      ? Buffer.concat([
          Buffer.from([TYPE_IVAR, TYPE_STRING]),
          encodeInt(payload.length),
          payload,
          UTF8_IVAR_TAIL
        ])
      : Buffer.concat([Buffer.from([TYPE_STRING]), encodeInt(payload.length), payload]);

  return Buffer.concat([
    Buffer.from([TYPE_ARRAY, ...encodeInt(3)]),
    Buffer.from([TYPE_FIXNUM]),
    encodeInt(id),
    stringBytes(nameBuf, nameIvar),
    stringBytes(zlibPayload, bodyIvar)
  ]);
}

/**
 * Splice a new entry into an archive before `insertIndex`.
 * Everything else keeps its original bytes; only the array length grows.
 */
export function insertScriptEntry(buf, insertIndex, id, name, zlibPayload, options = {}) {
  const parsed = parseScripts(buf, options);
  if (insertIndex < 0 || insertIndex > parsed.count) {
    throw new MarshalError(`insert index ${insertIndex} out of range (0..${parsed.count})`);
  }
  const at = insertIndex === parsed.count
    ? buf.length
    : parsed.entries[insertIndex].entryStart;

  const entry = encodeScriptEntry(id, name, zlibPayload, {
    nameIvar: options.nameIvar ?? options.ruby19 ?? parsed.nameIvar,
    bodyIvar: options.bodyIvar ?? parsed.bodyIvar
  });
  const head = buf.subarray(0, 3);
  const newCount = encodeInt(parsed.count + 1);
  const tail = buf.subarray(parsed.headerSize);

  return Buffer.concat([
    head,
    newCount,
    tail.subarray(0, at - parsed.headerSize),
    entry,
    tail.subarray(at - parsed.headerSize)
  ]);
}

/**
 * Locate the entry that blocks the main loop. Anything after it never runs,
 * so the bridge must be spliced in before this index.
 */
export function findMainEntryIndex(parsed, inflate) {
  for (const entry of parsed.entries) {
    let source = "";
    try {
      source = inflate(entry.zlib).toString("utf8");
    } catch (_) {
      continue;
    }
    if (source.includes("rgss_main")) return entry.index;
  }
  for (let i = parsed.entries.length - 1; i >= 0; i -= 1) {
    if (/main/i.test(parsed.entries[i].name)) return i;
  }
  return parsed.entries.length;
}
