import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, ".."),
  base = path.join(root, "tmp/full-retest-20260908"),
  out = path.join(base, "final-pass");
fs.mkdirSync(out, { recursive: true });
const results = [];
function run(label, script, args, env = {}) {
  console.log(new Date().toISOString(), "START", label);
  const fd = fs.openSync(path.join(out, label + ".log"), "w");
  const r = spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    timeout: 600000
  });
  fs.closeSync(fd);
  results.push({ label, status: r.status, error: r.error?.message });
  fs.writeFileSync(
    path.join(out, "progress.json"),
    JSON.stringify(results, null, 2)
  );
  console.log(new Date().toISOString(), "DONE", label, r.status);
}
for (const id of [
  "zsyb2",
  "daqian2",
  "shua",
  "sanguo",
  "qianlong",
  "mingyun",
  "storm",
  "homecoming",
  "liming"
])
  run(id, "tools/retest-game-20260908.mjs", [
    path.join(base, "games", id),
    path.join(out, id + ".json"),
    "--idle-fixture"
  ]);
for (const id of ["blacksouls1", "blacksouls2", "wujie"])
  run(
    id + "-contents",
    "tools/test-rgss-contents.mjs",
    [path.join(base, "games", id)],
    { RMCH_TEST_SAVE_SLOT: "18" }
  );
