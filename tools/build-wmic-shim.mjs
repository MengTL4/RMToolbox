// Build the wmic.exe shim (runtime/bin/wmic.exe) from runtime/src/wmic-shim.c.
//
// The shim serves the grover-boot shell family: on Windows 11 Microsoft
// removed wmic.exe, and those shells' ancestry probe execs `wmic` from their
// cwd and fails closed, killing the game ~15s after boot even on a stock
// double-click launch. The shim answers the probe's ParentProcessId/Name
// queries in real wmic's byte format so the shell's verification can complete.
// Toolchain discovery mirrors tools/build-inject.mjs (MSYS2 mingw gcc).
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import process from "node:process";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const src = path.join(root, "runtime", "src", "wmic-shim.c");
const outDir = path.join(root, "runtime", "bin");
const out = path.join(outDir, "wmic.exe");

function findGcc() {
  const candidates = [];
  const msysRoots = [
    path.join(os.homedir(), "msys64"),
    "C:\\msys64",
    "D:\\msys64"
  ];
  for (const msys of msysRoots) {
    candidates.push(path.join(msys, "ucrt64", "bin"));
    candidates.push(path.join(msys, "mingw64", "bin"));
  }
  for (const dir of candidates) {
    const gcc = path.join(dir, "x86_64-w64-mingw32-gcc.exe");
    if (existsSync(gcc)) return gcc;
  }
  return "x86_64-w64-mingw32-gcc.exe"; // rely on PATH
}

const gcc = findGcc();
mkdirSync(outDir, { recursive: true });
const res = spawnSync(gcc, ["-O2", "-static", "-o", out, src], { stdio: "inherit" });
if (res.status !== 0) {
  console.error(`build failed (${gcc})`);
  process.exit(1);
}
// Keep a copy next to the injector artifacts for archiving.
try { copyFileSync(out, path.join(outDir, "wmic-x64.exe")); } catch (_) {}
console.log(`wmic shim built: ${out}`);
