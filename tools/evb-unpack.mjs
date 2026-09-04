// CLI: unpack an Enigma Virtual Box single-file game into a real directory.
//
//   node tools/evb-unpack.mjs <game.exe> [outDir]
//
// outDir defaults to <exe dir>/<exe base>_unpacked. Existing extracted files
// are left alone only when --reuse is passed; default is a full re-extract.
import path from "node:path";
import { existsSync } from "node:fs";
import { detectEvb, parseEvbTree, extractEvb } from "../core/evb-unpack.mjs";

const [, , exeArg, outArg] = process.argv;
if (!exeArg) {
  console.error("usage: node tools/evb-unpack.mjs <game.exe> [outDir]");
  process.exit(1);
}
const exe = path.resolve(exeArg);
const outDir = path.resolve(outArg ?? exe.replace(/\.exe$/i, "") + "_unpacked");

const evb = detectEvb(exe);
if (!evb) {
  console.error(`not an Enigma Virtual Box image (no .enigma1/.enigma2 sections): ${exe}`);
  process.exit(1);
}
console.log(`EVB image (${evb.arch}): ${exe}`);
if (existsSync(outDir)) {
  console.log(`out dir exists, files will be overwritten: ${outDir}`);
}

const t0 = Date.now();
const { files } = parseEvbTree(exe);
console.log(`node table: ${files.length} files, ${(files.reduce((s, f) => s + f.storedSize, 0) / 1024 / 1024).toFixed(1)} MB stored`);
let lastReport = 0;
const result = extractEvb(exe, outDir, {
  onProgress: ({ files: done, filesTotal, bytes }) => {
    const now = Date.now();
    if (now - lastReport > 2000) {
      lastReport = now;
      console.log(`  ${done}/${filesTotal} files, ${(bytes / 1024 / 1024).toFixed(0)} MB`);
    }
  }
});
console.log(`done: ${result.files} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MB in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${outDir}`);
