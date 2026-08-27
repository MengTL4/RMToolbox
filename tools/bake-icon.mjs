// Bake app/gui/icon.png — the window/taskbar icon for the RM Toolbox GUI.
//
// No image tooling exists in this repo (zero npm dependencies), so this
// rasterizes the icon itself: every shape is a signed-distance field,
// rendered at 4x and box-downsampled for antialiasing, then encoded as a
// plain RGBA PNG with zlib (node: built in). The glyph is the same Lucide
// "sliders" geometry the in-app brand mark uses (ui/icons.js), so the window
// icon and the sider brand read as one mark.
//
// Re-run after changing the design:  node tools/bake-icon.mjs

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Design (tile space: 0..1, y down)

const TILE = {
  // Rounded-square badge with the brand gradient (theme.js primary → info).
  margin: 0.06,
  radius: 0.20,
  gradFrom: [0x5b, 0x8c, 0xff], // #5b8cff
  gradTo: [0x8b, 0x5c, 0xf6], //   #8b5cf6
  // The Lucide 24x24 "sliders" glyph is mapped into this sub-region so the
  // strokes land at ~55% of the tile — app-icon density, not toolbar density.
  glyphFrom: 0.14,
  glyphTo: 0.86,
  stroke: 1.8, // Lucide stroke-width units
  glyph: [
    // capsules in Lucide coordinates: [x1, y1, x2, y2]
    [4, 3, 4, 21], //   left track
    [12, 3, 12, 21], // mid track
    [20, 3, 20, 21], // right track
    [1, 14, 7, 14], //   left knob
    [9, 8, 15, 8], //    mid knob
    [17, 16, 23, 16] // right knob
  ]
};

// ---------------------------------------------------------------------------
// Signed-distance helpers (negative = inside)

function sdCapsule(px, py, x1, y1, x2, y2, r) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = x1 + t * dx - px;
  const cy = y1 + t * dy - py;
  return Math.hypot(cx, cy) - r;
}

function sdRoundBox(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

// ---------------------------------------------------------------------------
// Rasterize (RGBA, supersampled)

function raster(size, ss) {
  const hi = size * ss;
  const px = new Float64Array(hi * hi * 4);
  const m = TILE.margin;
  const side = 1 - 2 * m;
  const glyphScale = TILE.glyphTo - TILE.glyphFrom;

  for (let y = 0; y < hi; y += 1) {
    for (let x = 0; x < hi; x += 1) {
      const u = (x + 0.5) / hi;
      const v = (y + 0.5) / hi;
      const o = (y * hi + x) * 4;

      const dBadge = sdRoundBox(u, v, 0.5, 0.5, side / 2, side / 2, TILE.radius);
      if (dBadge >= 0) continue; // transparent outside the badge

      // 135° gradient across the badge.
      const t = Math.max(0, Math.min(1, (u - m + (v - m)) / (2 * side)));
      let r = TILE.gradFrom[0] + (TILE.gradTo[0] - TILE.gradFrom[0]) * t;
      let g = TILE.gradFrom[1] + (TILE.gradTo[1] - TILE.gradFrom[1]) * t;
      let b = TILE.gradFrom[2] + (TILE.gradTo[2] - TILE.gradFrom[2]) * t;

      // Glyph: nearest capsule wins; white when inside the stroke.
      const gu = (u - TILE.glyphFrom) / glyphScale * 24;
      const gv = (v - TILE.glyphFrom) / glyphScale * 24;
      let dGlyph = Infinity;
      for (const [x1, y1, x2, y2] of TILE.glyph) {
        const d = sdCapsule(gu, gv, x1, y1, x2, y2, TILE.stroke / 2);
        if (d < dGlyph) dGlyph = d;
      }
      if (dGlyph < 0) {
        r = 255; g = 255; b = 255;
      }

      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 255;
    }
  }

  // Box downsample ss×ss → 1 px.
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const o = ((y * ss + sy) * hi + (x * ss + sx)) * 4;
          r += px[o]; g += px[o + 1]; b += px[o + 2]; a += px[o + 3];
        }
      }
      const n = ss * ss;
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Minimal PNG encoder (8-bit RGBA, filter 0)

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (1 + size * 4);
    raw[rowStart] = 0; // filter: none
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

// ---------------------------------------------------------------------------

const size = Number(process.argv[2]) || 256;
const outPath = path.join(projectRoot, "app", "gui", "icon.png");
const rgba = raster(size, 4);
writeFileSync(outPath, encodePng(rgba, size));
console.log(`icon baked: ${outPath} (${size}x${size})`);
