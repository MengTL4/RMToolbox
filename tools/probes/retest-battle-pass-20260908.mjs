import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const project = path.resolve(import.meta.dirname, "..", ".."),
  base = path.join(project, "tmp/full-retest-20260908"),
  out = path.join(base, "native-battle");
fs.mkdirSync(out, { recursive: true });
while (true) {
  try {
    if (
      JSON.parse(fs.readFileSync(path.join(base, "final-pass/progress.json")))
        .length >= 12
    )
      break;
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
const results = [];
for (const id of ["shua", "zsyb2", "daqian2", "sanguo", "qianlong", "lunhui"]) {
  console.log(new Date().toISOString(), "START", id);
  const fd = fs.openSync(path.join(out, id + ".log"), "w");
  const r = spawnSync(
    process.execPath,
    [
      path.join(project, "tools/probes/retest-game-20260908.mjs"),
      path.join(base, "games", id),
      path.join(out, id + ".json"),
      "--idle-fixture",
      "--skip-scenes"
    ],
    {
      cwd: project,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
      timeout: 480000
    }
  );
  fs.closeSync(fd);
  results.push({ id, status: r.status, error: r.error?.message });
  fs.writeFileSync(
    path.join(out, "progress.json"),
    JSON.stringify(results, null, 2)
  );
  console.log(new Date().toISOString(), "DONE", id, r.status);
}
