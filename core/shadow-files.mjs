import { lstatSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import path from "node:path";

// NW 0.115 / Node 26 recursive rm follows Windows junctions into the source
// game. Walk only real directories and explicitly unlink every link instead.
// Callers must restrict dest to their owned shadow/cache tree.
export function removeShadowEntry(dest) {
  const stat = lstatSync(dest, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    unlinkSync(dest);
  } else {
    for (const child of readdirSync(dest))
      removeShadowEntry(path.join(dest, child));
    rmdirSync(dest);
  }
}
