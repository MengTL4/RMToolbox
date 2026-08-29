#!/usr/bin/env node
// Build the native injection binaries (injector + hook DLLs) for win32 & x64.
//
// Toolchains (MSYS2 / MinGW-w64):
//   x64:  x86_64-w64-mingw32-g++ / -gcc   (ucrt64 is fine)
//   x86:  i686-w64-mingw32-g++ / -gcc     (pacman -S mingw-w64-i686-gcc)
// Resolution order: $RMCH_MINGW_X64 / $RMCH_MINGW_X86 (prefix dirs containing
// bin/), then PATH, then common msys64 roots.
//
// Outputs (committed to git so releases don't need a toolchain):
//   runtime/inject/bin/<arch>/{rmch-inject.exe, rmch-mvhook.dll, rmch-rgsshook.dll}
//   runtime/inject/bin/<arch>/test/{test-target.exe, rmch-test-echo.dll}

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(root, "runtime", "inject", "src");
const minhookDir = path.join(root, "runtime", "inject", "third_party", "minhook");
const outRoot = path.join(root, "runtime", "inject", "bin");

function which(bin) {
  const pathExt = [".exe", ""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of pathExt) {
      const p = path.join(dir, bin + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findToolchain(kind) {
  // kind: "x64" | "x86"
  const prefix = kind === "x64" ? "x86_64-w64-mingw32" : "i686-w64-mingw32";
  const envKey = kind === "x64" ? "RMCH_MINGW_X64" : "RMCH_MINGW_X86";
  const candidates = [];
  if (process.env[envKey]) candidates.push(path.join(process.env[envKey], "bin"));
  for (const dir of (process.env.PATH || "").split(path.delimiter)) candidates.push(dir);
  for (const msysRoot of [process.env.MSYS2_PREFIX, "C:\\msys64", "E:\\Path\\msys64"]) {
    if (!msysRoot) continue;
    candidates.push(path.join(msysRoot, kind === "x64" ? "ucrt64" : "mingw32", "bin"));
    candidates.push(path.join(msysRoot, "mingw64", "bin"));
  }
  for (const dir of candidates) {
    const gxx = path.join(dir, `${prefix}-g++.exe`);
    const gcc = path.join(dir, `${prefix}-gcc.exe`);
    if (existsSync(gxx) && existsSync(gcc)) return { gxx, gcc };
  }
  const gxx = which(`${prefix}-g++`);
  const gcc = which(`${prefix}-gcc`);
  if (gxx && gcc) return { gxx, gcc };
  return null;
}

const ARCHES = {
  x64: { dir: "x64", hde: "hde64.c" },
  win32: { dir: "win32", hde: "hde32.c" }
};

const CXXFLAGS = [
  "-Os", "-fno-exceptions", "-fno-rtti", "-Wall", "-Wextra",
  `-I${srcDir}`, `-I${path.join(minhookDir, "include")}`
];
// ld.lld: binutils ld 2.46.1 segfaults on these objects (both with and without
// -fno-weak), so we link with LLVM lld. One ld.lld handles both i386 and x86_64;
// it ships in the ucrt64 bin dir (pacman -S mingw-w64-ucrt-x86_64-lld).
let lldFlags = null;
function findLld(extraDirs) {
  for (const dir of extraDirs) {
    if (existsSync(path.join(dir, "ld.lld.exe"))) {
      return ["-fuse-ld=lld", `-B${dir}`];
    }
  }
  const onPath = which("ld.lld");
  if (onPath) return ["-fuse-ld=lld", `-B${path.dirname(onPath)}`];
  return null;
}
let LINKFLAGS = ["-static", "-static-libgcc", "-nostdlib++", "-s"];

function run(cmd, args) {
  // Prepend the tool's own bin dir to PATH: cc1plus/as/ld need their
  // matching-arch runtime DLLs (libgmp etc.), and another toolchain's bin dir
  // earlier on PATH (e.g. ucrt64 with x64 DLLs) would shadow them.
  const env = { ...process.env, PATH: path.dirname(cmd) + path.delimiter + process.env.PATH };
  try {
    execFileSync(cmd, args, { stdio: ["inherit", "inherit", "pipe"], env });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : "";
    if (stderr.trim()) console.error(stderr);
    console.error(`[build-inject] command failed (${e.code || e.status || e.signal}): ${cmd}`);
    throw e;
  }
}

function compile(tool, src, obj, flags) {
  run(tool, [...flags, "-c", src, "-o", obj]);
}

function link(tool, objs, out, flags) {
  run(tool, [...objs, ...LINKFLAGS, ...flags, "-o", out]);
}

function buildArch(archKey, tc) {
  const { dir, hde } = ARCHES[archKey];
  const outDir = path.join(outRoot, dir);
  const testDir = path.join(outDir, "test");
  const objDir = path.join(outRoot, "obj", dir);
  rmSync(objDir, { recursive: true, force: true });
  mkdirSync(objDir, { recursive: true });
  mkdirSync(testDir, { recursive: true });

  const obj = (name) => path.join(objDir, name + ".o");
  const isX86 = archKey === "win32";
  const killAt = isX86 ? ["-Wl,--kill-at"] : []; // undecorate stdcall exports
  // x86 MSVC only guarantees 4-byte stack alignment at call sites; GCC assumes
  // 16. Without realignment a movaps spill in our frames can fault when V8
  // (MSVC-built) calls into us or we call back into it.
  const cxxFlags = isX86 ? [...CXXFLAGS, "-mstackrealign"] : CXXFLAGS;

  // injector.exe
  compile(tc.gxx, path.join(srcDir, "injector.cpp"), obj("injector"), CXXFLAGS);
  link(tc.gxx, [obj("injector")], path.join(outDir, "rmch-inject.exe"), ["-luser32"]);

  // rmch-mvhook.dll (+ MinHook)
  const mhSrc = path.join(minhookDir, "src");
  const mhObjs = [];
  for (const f of ["buffer.c", "hook.c", "trampoline.c", path.join("hde", hde)]) {
    const o = obj("mh-" + path.basename(f, ".c"));
    compile(tc.gcc, path.join(mhSrc, f), o, ["-Os", `-I${path.join(minhookDir, "include")}`]);
    mhObjs.push(o);
  }
  compile(tc.gxx, path.join(srcDir, "mvhook.cpp"), obj("mvhook"), cxxFlags);
  link(tc.gxx, [obj("mvhook"), ...mhObjs], path.join(outDir, "rmch-mvhook.dll"), ["-shared"]);

  // rmch-rgsshook.dll
  compile(tc.gxx, path.join(srcDir, "rgsshook.cpp"), obj("rgsshook"), cxxFlags);
  link(tc.gxx, [obj("rgsshook")], path.join(outDir, "rmch-rgsshook.dll"), ["-shared", "-luser32", ...killAt]);

  // test binaries (not shipped in releases)
  compile(tc.gxx, path.join(srcDir, "test-target.cpp"), obj("test-target"), CXXFLAGS);
  link(tc.gxx, [obj("test-target")], path.join(testDir, "test-target.exe"), ["-luser32"]);
  compile(tc.gxx, path.join(srcDir, "test-echo.cpp"), obj("test-echo"), CXXFLAGS);
  link(tc.gxx, [obj("test-echo")], path.join(testDir, "rmch-test-echo.dll"), ["-shared", ...killAt]);

  return readdirSync(outDir);
}

const onlyArch = process.argv[2]; // optional: "x64" | "win32"

// Resolve ld.lld first (needed by every link below).
{
  const dirs = [];
  for (const archKey of Object.keys(ARCHES)) {
    const tc = findToolchain(archKey);
    if (tc) dirs.push(path.dirname(tc.gxx));
  }
  lldFlags = findLld(dirs);
  if (!lldFlags) {
    console.error("[build-inject] ld.lld NOT found (binutils ld 2.46.1 segfaults on these objects).");
    console.error("  Install with: pacman -S --needed mingw-w64-ucrt-x86_64-lld  (in an MSYS2 shell)");
    process.exit(1);
  }
  LINKFLAGS = [...LINKFLAGS, ...lldFlags];
}

let failed = false;
for (const archKey of Object.keys(ARCHES)) {
  if (onlyArch && archKey !== onlyArch) continue;
  const tc = findToolchain(archKey);
  if (!tc) {
    console.error(`[build-inject] ${archKey}: toolchain NOT found.`);
    console.error(archKey === "win32"
      ? "  Install with: pacman -S --needed mingw-w64-i686-gcc   (in an MSYS2 shell)"
      : "  Install with: pacman -S --needed mingw-w64-ucrt-x86_64-gcc  (in an MSYS2 shell)");
    failed = true;
    continue;
  }
  console.log(`[build-inject] ${archKey}: ${tc.gxx}`);
  buildArch(archKey, tc);
  console.log(`[build-inject] ${archKey}: done -> ${path.join(outRoot, ARCHES[archKey].dir)}`);
}
process.exit(failed ? 1 : 0);
