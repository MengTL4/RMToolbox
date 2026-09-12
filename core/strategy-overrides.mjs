// 策略覆盖记录 (CONTEXT.md): a per-game persisted route choice — only the
// diff from scanner-derived defaults is stored. Choosing 自动 clears the
// record; a record that no longer fits the current scan is ignored, never
// fatal. Records live one-file-per-game under runtime/strategy-overrides/,
// the same per-game persistence idiom as runtime/locks/.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import path from "node:path";

const FORMAT_VERSION = 1;

// The per-game file-name key, shared with host.cjs's locks persistence (same
// idiom, one sanitiser — a drift here would make locks and overrides disagree
// on the same game).
export function sanitizeKey(gameKey) {
  return String(gameKey).replace(/[\\/:*?"<>|]/g, "_");
}

function overrideDir(projectRoot) {
  return path.join(projectRoot, "runtime", "strategy-overrides");
}

function overridePath(projectRoot, gameKey) {
  return path.join(overrideDir(projectRoot), `${sanitizeKey(gameKey)}.json`);
}

// Missing, unreadable or malformed all mean the same thing: no override —
// derive the route automatically. The record must never break a launch.
export function loadStrategyOverride(projectRoot, gameKey) {
  let parsed;
  try {
    parsed = JSON.parse(
      readFileSync(overridePath(projectRoot, gameKey), "utf8")
    );
  } catch (_) {
    return null;
  }
  if (!parsed || parsed.version !== FORMAT_VERSION) return null;
  if (typeof parsed.route !== "string" || !parsed.route) return null;
  if (parsed.route === "auto") return null; // auto is the default, never stored
  return { gameKey, route: parsed.route, savedAt: parsed.savedAt || null };
}

export function saveStrategyOverride(projectRoot, gameKey, route) {
  if (!route || route === "auto")
    return { cleared: clearStrategyOverride(projectRoot, gameKey).cleared };
  const record = {
    version: FORMAT_VERSION,
    gameKey,
    route,
    savedAt: new Date().toISOString()
  };
  const file = overridePath(projectRoot, gameKey);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record, null, 2), "utf8");
  return record;
}

export function clearStrategyOverride(projectRoot, gameKey) {
  const file = overridePath(projectRoot, gameKey);
  if (!existsSync(file)) return { cleared: false };
  rmSync(file, { force: true });
  return { cleared: true };
}

// All persisted overrides as { gameKey: route }. The file name is the
// sanitised key; the record's own gameKey field is authoritative.
export function listStrategyOverrides(projectRoot) {
  let names;
  try {
    names = readdirSync(overrideDir(projectRoot));
  } catch (_) {
    return {};
  }
  const result = {};
  for (const name of names) {
    if (!/\.json$/i.test(name)) continue;
    const record = loadStrategyOverride(
      projectRoot,
      name.replace(/\.json$/i, "")
    );
    if (record) result[record.gameKey] = record.route;
  }
  return result;
}

// An override applies only while the current plan still offers the route: a
// game update that retires the route falls back to 自动 instead of failing.
// (An explicit choice that equals today's preferred route is still pinned —
// that is what "手动选择" means; it survives future scan changes.)
export function resolveRouteOverride(plan, route) {
  if (!route || !plan) return null;
  const candidates = Array.isArray(plan.candidates) ? plan.candidates : [];
  return candidates.some((entry) => entry.id === route) ? route : null;
}
