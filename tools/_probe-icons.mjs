// One-off: inspect archive layout / find icon entries.
import { listEntries } from "../core/rgss-archive.mjs";

const archive = process.argv[2];
const pattern = process.argv[3] ? new RegExp(process.argv[3], "i") : null;
const entries = listEntries(archive);
console.log("total:", entries.length);
if (pattern) {
  const hits = entries.filter((e) => pattern.test(e.name));
  console.log("matches:", hits.length);
  for (const e of hits.slice(0, 30)) console.log(" ", e.name, e.size);
} else {
  const dirs = new Set();
  for (const e of entries) {
    const parts = e.name.split("\\");
    dirs.add(parts.slice(0, Math.min(2, parts.length - 1)).join("/"));
  }
  console.log([...dirs].sort().join("\n"));
}
