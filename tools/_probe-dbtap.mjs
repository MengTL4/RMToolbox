// Boot-phase JSON.parse/XHR tap for the sealed game: injects at renderer
// birth with NO canvas gate, logs every JSON.parse (size, shape, head of the
// raw text) and every XHR open to runtime/_scratch/dbtap-log.txt. Purpose:
// learn WHEN (and WHETHER) the shell's decrypted database flows through the
// page realm's JSON.parse during boot.
import { execFile } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { injectAndDeliver, readPeArch, shellExecuteSpawn } from "../core/attach.mjs";

const projectRoot = "E:\\project\\RMToolbox";
const OUT = "E:\\project\\RMToolbox\\runtime\\_scratch\\dbtap-log.txt";
const EXE = "D:\\Downloads\\RPG\\_V1.2.2_B电脑端\\万族穿越-源启崛起.exe";
const ROOT = "D:\\Downloads\\RPG\\_V1.2.2_B电脑端";

const bootstrap = `(function(){
  try {
    if (window.__dbtap) return "already";
    window.__dbtap = true;
    var fs = require("fs");
    var OUT = ${JSON.stringify(OUT)};
    var t0 = Date.now();
    var log = function (o) { try { fs.appendFileSync(OUT, JSON.stringify(o) + "\\n"); } catch (e) {} };
    log({ mark: "installed", t: 0, href: String(location.href), readyState: document.readyState, hasCanvas: !!document.querySelector("canvas") });
    var origParse = JSON.parse;
    JSON.parse = function (text) {
      var r = origParse.apply(this, arguments);
      try {
        var info = { t: Date.now() - t0, in: (typeof text === "string" ? text.length : -1) };
        if (typeof text === "string") info.head = text.slice(0, 90);
        if (Array.isArray(r)) {
          info.kind = "array"; info.len = r.length; info.hole0 = (r[0] == null);
          var s = null; for (var i = 0; i < r.length && !s; i++) { if (r[i] && typeof r[i] === "object" && !Array.isArray(r[i])) s = r[i]; }
          info.keys = s ? Object.keys(s).slice(0, 12) : null;
        } else if (r && typeof r === "object") {
          info.kind = "object"; info.keys = Object.keys(r).slice(0, 16);
        } else { info.kind = typeof r; }
        log(info);
      } catch (e) {}
      return r;
    };
    try {
      var X = window.XMLHttpRequest;
      if (X && X.prototype && X.prototype.open) {
        var oo = X.prototype.open;
        X.prototype.open = function (m, u) {
          try { log({ t: Date.now() - t0, xhr: String(u) }); } catch (e) {}
          return oo.apply(this, arguments);
        };
      }
    } catch (e) {}
    return "installed";
  } catch (e) { return "err:" + (e && e.message); }
})()`;

const rendererPids = () => new Promise((resolve) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "Get-CimInstance Win32_Process -Filter \"Name='万族穿越-源启崛起.exe'\" | Where-Object { $_.CommandLine -match '--type=renderer' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json"],
    { windowsHide: true }, (err, stdout) => {
      if (err || !String(stdout).trim()) return resolve([]);
      try {
        const v = JSON.parse(String(stdout).trim());
        resolve(Array.isArray(v) ? v.map(Number) : [Number(v)]);
      } catch (_) { resolve([]); }
    });
});

writeFileSync(OUT, "");
console.log("spawning game (two-hop ShellExecute)...");
shellExecuteSpawn(EXE, ROOT);

const arch = readPeArch(EXE);
console.log("arch:", arch, "— polling for renderer...");
const t0 = Date.now();
let injected = false;
while (Date.now() - t0 < 90000 && !injected) {
  await new Promise((r) => setTimeout(r, 250));
  const pids = await rendererPids();
  if (!pids.length) continue;
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] renderer pids: ${pids.join(",")} — injecting`);
  const result = await injectAndDeliver({
    projectRoot, arch, pid: pids[0], dllName: "rmch-mvhook.dll",
    bootstrap, mode: "crt", timeoutMs: 25000
  });
  console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] inject result:`, JSON.stringify(result));
  injected = result.ok;
  if (!injected) await new Promise((r) => setTimeout(r, 1500));
}
if (!injected) {
  console.log("INJECTION NEVER LANDED");
  process.exit(1);
}
console.log("probe installed — letting the game boot for 35s...");
await new Promise((r) => setTimeout(r, 35000));
const log = readFileSync(OUT, "utf8");
console.log("=== dbtap log (first 60 lines) ===");
console.log(log.split(/\r?\n/).slice(0, 60).join("\n"));
console.log("=== total lines:", log.split(/\r?\n/).filter(Boolean).length);
process.exit(0);
