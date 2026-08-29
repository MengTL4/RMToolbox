// One-off RGSS probe: inject arbitrary Ruby into a running RGSS game via the
// existing rgsshook channel and let it write results to a file game-side.
// Usage: node tools/_probe-rgss.mjs <pid> <rubyFile>
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { injectAndDeliver } from "../core/attach.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [, , pidArg, rubyFile] = process.argv;
if (!pidArg || !rubyFile) {
  console.error("usage: node tools/_probe-rgss.mjs <pid> <rubyFile>");
  process.exit(1);
}
const bootstrap = readFileSync(rubyFile, "utf8");
const r = await injectAndDeliver({
  projectRoot,
  arch: "win32",
  pid: Number(pidArg),
  dllName: "rmch-rgsshook.dll",
  bootstrap,
  mode: "wh",
  timeoutMs: 15000
});
console.log(JSON.stringify(r));
