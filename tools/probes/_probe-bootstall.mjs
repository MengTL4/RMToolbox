// Boot-stall discriminator for the NB sealed game: plain-spawn the game,
// inject a bootstrap variant at renderer birth, wait, screenshot.
//   variant "noop"  — marker only, no JSON.parse tap, no bridge
//   variant "tap"   — JSON.parse holding tap only (no full bridge)
// Decides whether the splash stall comes from the injection itself or the tap.
import { execFile } from "node:child_process";
import { injectAndDeliver, readPeArch } from "../../core/attach.mjs";

const EXE = "D:\\Downloads\\RPG\\_V1.2.2_B电脑端\\万族穿越-源启崛起.exe";
const ROOT = "D:\\Downloads\\RPG\\_V1.2.2_B电脑端";
const projectRoot = "E:\\project\\RMToolbox";
const variant = process.argv[2] || "noop";

const BOOTSTRAPS = {
  noop: "(function(){ return 'noop-ok'; })()",
  tap:
    "(function(){ if (window.__rmchBootTap) return 'already'; window.__rmchBootTap = true;" +
    " var op = JSON.parse; JSON.parse = function (t) { return op.apply(this, arguments); };" +
    " try { Object.defineProperty(JSON.parse, 'length', { value: 2 }); } catch (_) {}" +
    " return 'tap-ok'; })()"
};
const bootstrap = BOOTSTRAPS[variant];
if (!bootstrap) {
  console.error("unknown variant", variant);
  process.exit(2);
}

// Plain spawn: parent powershell exits immediately → dead ancestor passes the
// shell's blacklist walk.
execFile(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Start-Process -FilePath '${EXE}' -WorkingDirectory '${ROOT}'`
  ],
  { windowsHide: true },
  () => {}
);
console.log("spawned plain, polling renderer...");
const t0 = Date.now();

const rendererPids = () =>
  new Promise((resolve) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='万族穿越-源启崛起.exe'\" | Where-Object { $_.CommandLine -match '--type=renderer' } | Select-Object -ExpandProperty ProcessId | ConvertTo-Json"
      ],
      { windowsHide: true },
      (err, stdout) => {
        if (err || !String(stdout).trim()) return resolve([]);
        try {
          const v = JSON.parse(String(stdout).trim());
          resolve(Array.isArray(v) ? v.map(Number) : [Number(v)]);
        } catch (_) {
          resolve([]);
        }
      }
    );
  });

let injected = false;
while (Date.now() - t0 < 60000 && !injected) {
  await new Promise((r) => setTimeout(r, 250));
  const pids = await rendererPids();
  if (!pids.length) continue;
  const result = await injectAndDeliver({
    projectRoot,
    arch: readPeArch(EXE),
    pid: pids[0],
    dllName: "rmch-mvhook.dll",
    bootstrap,
    mode: "crt",
    timeoutMs: 25000
  });
  console.log(
    `[+${((Date.now() - t0) / 1000).toFixed(1)}s] inject(${variant}):`,
    JSON.stringify(result)
  );
  injected = result.ok;
  if (!injected) await new Promise((r) => setTimeout(r, 1000));
}
if (!injected) {
  console.log("INJECTION NEVER LANDED");
  process.exit(1);
}

console.log("waiting 75s for the boot to play out...");
await new Promise((r) => setTimeout(r, 75000));
console.log("done — screenshot separately");
process.exit(0);
