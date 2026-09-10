// Validate the CI workflow parses and its steps are well-formed.
//
// Wired into `npm test` on purpose: a workflow that references a renamed npm
// script or a deleted tool fails on the GitHub runner, where nobody is watching,
// long after the rename. This catches it locally in milliseconds.
import fs from "node:fs";
import path from "node:path";

// This lives in tools/, so the repository root is one level up.
const root = path.resolve(import.meta.dirname, "..");
const file = path.join(root, ".github", "workflows", "verify.yml");
const text = fs.readFileSync(file, "utf8");

// No YAML dependency is available, so check the structural properties that
// actually break a workflow: indentation of the jobs/steps tree, and that every
// `run:` step has a non-empty body.
const lines = text.split("\n");
let problems = [];
let inJobs = false;
let steps = 0;

for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i];
  if (line.startsWith("jobs:")) inJobs = true;
  // A tab character anywhere is invalid YAML.
  if (line.includes("\t")) problems.push(`tab character at line ${i + 1}`);
  if (inJobs && /^\s+- name:/.test(line)) steps += 1;
  // Every `run: |` must be followed by an indented block.
  if (/run:\s*\|$/.test(line)) {
    const next = lines[i + 1] || "";
    const indent = line.search(/\S/);
    if (!next.trim() || next.search(/\S/) <= indent) {
      problems.push(`empty run block at line ${i + 1}`);
    }
  }
}

// Every `uses:` must be a known action reference shape. Comments are stripped
// first: prose can contain "uses: a" and would otherwise be read as YAML.
for (const [i, raw] of lines.entries()) {
  const line = raw.replace(/(^|\s)#.*$/, "");
  const m = /uses:\s*(\S+)/.exec(line);
  if (m && !/^[\w.-]+\/[\w.-]+@[\w.-]+$/.test(m[1])) {
    problems.push(`malformed uses at line ${i + 1}: ${m[1]}`);
  }
}

// npm scripts the workflow invokes must exist.
const pkg = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const scripts = [...text.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
for (const name of scripts) {
  if (!(name in pkg.scripts))
    problems.push(`workflow runs missing script: ${name}`);
}

console.log(`workflow lines: ${lines.length}`);
console.log(`named steps:    ${steps}`);
console.log(
  `npm scripts referenced: ${[...new Set(scripts)].join(", ") || "(none)"}`
);
const nodeTools = [...text.matchAll(/node (tools\/[\w.-]+)/g)].map((m) => m[1]);
for (const t of new Set(nodeTools)) {
  const exists = fs.existsSync(path.join(root, t));
  console.log(`node ${t}: ${exists ? "exists" : "MISSING"}`);
  if (!exists) problems.push(`workflow calls missing file: ${t}`);
}

if (problems.length) {
  console.error("\nPROBLEMS:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("\nworkflow structure OK");
