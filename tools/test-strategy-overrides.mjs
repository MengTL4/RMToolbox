// 策略覆盖记录 tests: the full 默认推导 → 手动覆盖 → 持久化 → 恢复自动 cycle
// plus corrupt/incompatible-record tolerance. Pure core seam — no game, no GUI.

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearStrategyOverride,
  listStrategyOverrides,
  loadStrategyOverride,
  resolveRouteOverride,
  saveStrategyOverride
} from "../core/strategy-overrides.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "rmch-overrides-"));
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch (_) {}
});

const plan = {
  selected: "shadow",
  candidates: [{ id: "shadow" }, { id: "extension" }, { id: "dll" }]
};

// Default: nothing persisted, nothing loaded.
assert.equal(loadStrategyOverride(scratch, "测试游戏"), null);
assert.deepEqual(listStrategyOverrides(scratch), {});

// Manual override persists as only the diff field.
const record = saveStrategyOverride(scratch, "测试游戏", "dll");
assert.equal(record.route, "dll");
assert.equal(record.version, 1);
assert.ok(existsSync(path.join(scratch, "runtime", "strategy-overrides")));
// Keys with filesystem-hostile characters land in a sanitised file name.
assert.ok(
  existsSync(
    path.join(scratch, "runtime", "strategy-overrides", "测试游戏.json")
  )
);

// A "fresh boot" reads it back.
const loaded = loadStrategyOverride(scratch, "测试游戏");
assert.equal(loaded.route, "dll");
assert.ok(loaded.savedAt);
assert.deepEqual(listStrategyOverrides(scratch), { 测试游戏: "dll" });

// The override resolves while the plan still offers the route…
assert.equal(resolveRouteOverride(plan, loaded.route), "dll");
// …and is ignored once the game no longer offers it (e.g. after an update).
assert.equal(
  resolveRouteOverride(
    { selected: "extension", candidates: [{ id: "extension" }] },
    loaded.route
  ),
  null
);
assert.equal(resolveRouteOverride(plan, null), null);
assert.equal(resolveRouteOverride(null, loaded.route), null);

// 恢复自动 clears the record; choosing auto never writes one in the first place.
saveStrategyOverride(scratch, "测试游戏", "auto");
assert.equal(loadStrategyOverride(scratch, "测试游戏"), null);
assert.equal(
  existsSync(
    path.join(scratch, "runtime", "strategy-overrides", "测试游戏.json")
  ),
  false
);
assert.equal(clearStrategyOverride(scratch, "测试游戏").cleared, false);

// Corrupt or malformed records are tolerated: load returns null, and the next
// save replaces the evidence.
saveStrategyOverride(scratch, "坏档", "dll");
const badFile = path.join(
  scratch,
  "runtime",
  "strategy-overrides",
  "坏档.json"
);
writeFileSync(badFile, "{not json", "utf8");
assert.equal(loadStrategyOverride(scratch, "坏档"), null);
writeFileSync(badFile, JSON.stringify({ version: 1, route: "" }), "utf8");
assert.equal(loadStrategyOverride(scratch, "坏档"), null);
writeFileSync(badFile, JSON.stringify({ version: 99, route: "dll" }), "utf8");
assert.equal(loadStrategyOverride(scratch, "坏档"), null);
assert.deepEqual(listStrategyOverrides(scratch), {});

// A clear after corruption still works.
assert.equal(clearStrategyOverride(scratch, "坏档").cleared, true);

console.log(
  "test-strategy-overrides: persist/resolve/clear cycle and corrupt-record tolerance passed"
);
