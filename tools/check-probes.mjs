// Verify the tools/probes/ migration mechanically.
//
// After a one-level move every relative import is suspect. Running each script
// with no arguments makes it fail early — but the KIND of failure is the signal:
//   - ERR_MODULE_NOT_FOUND / "Cannot find module" -> the import path is broken
//   - ENOENT / "getValidatedPath" / usage errors  -> imports resolved, the script
//     simply needs its arguments, which is expected here
// So a script that loads and then complains about a missing file is PASSING this
// check, and only module-resolution failures are treated as failures.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const probesDir = path.join(import.meta.dirname, "probes");
const files = fs
  .readdirSync(probesDir)
  .filter((n) => /\.(mjs|cjs)$/.test(n))
  .sort();

const moduleFailures = [];
const resolved = [];
const skipped = [];

for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(probesDir, name)], {
    encoding: "utf8",
    timeout: 15000,
    windowsHide: true
  });
  const output = (result.stdout || "") + (result.stderr || "");
  if (result.error && result.error.code === "ETIMEDOUT") {
    skipped.push([name, "timed out waiting for argv"]);
    continue;
  }
  // A module-resolution failure is the only thing the move can break.
  const badModule =
    /ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/.test(output);
  if (badModule) {
    const missing =
      (/Cannot find (?:module|package) '([^']+)'/.exec(output) || [])[1] || "?";
    moduleFailures.push([name, missing]);
  } else {
    resolved.push(name);
  }
}

console.log(`probes checked: ${files.length}`);
console.log(`imports resolve: ${resolved.length}`);
console.log(`skipped (needs argv / long): ${skipped.length}`);
for (const [n, why] of skipped) console.log(`   - ${n}: ${why}`);
console.log(`BROKEN IMPORTS: ${moduleFailures.length}`);
for (const [n, m] of moduleFailures) console.log(`   ! ${n} -> ${m}`);

if (moduleFailures.length) process.exit(1);
console.log("\nall probe imports resolve");
