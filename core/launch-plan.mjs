// Launch-route planner.
//
// The scanner describes what a game is.  This module turns that description
// into one small, serialisable decision: which delivery route is preferred,
// which routes are safe fallbacks, and which routes must be refused.  It does
// not start a process.  Keeping the decision pure gives the GUI, CLI and tests
// the same seam without making the planner know about Windows process APIs.
//
// Route identities, Chinese labels, user-goal phrases and mechanisms come from
// core/launch-routes.mjs so the planner, the launchers, the log and the GUI all
// name a route the same way.
//
// Since the engine adapters landed (core/adapters/, ADR 0002) this module is
// an orchestrator: each registered adapter decides the plans for its own game
// family. Only families without an adapter yet (rgss / evb / tauri / RM2K) are
// still planned by the legacy code below; each one moves out when its adapter
// lands.

import { candidate, blocked, finishPlan } from "./launch-routes.mjs";
import { adapters } from "./adapters/index.mjs";

export class LaunchPlanError extends Error {
  constructor(plan) {
    super((plan && plan.error) || "no compatible launch route");
    this.name = "LaunchPlanError";
    this.plan = plan;
  }
}

// The request vocabulary is the catalogue's route ids plus "auto" — nothing
// else. The old aliases (inject/native/native-dll) died with LAUNCH_ROUTES.
function requestedRoute(value) {
  return String(value || "auto")
    .trim()
    .toLowerCase();
}

function isRgss(scan, engine, container) {
  return container === "rgss" || /^RGSS/i.test(engine);
}

// Legacy single-route plans for the families that have no adapter yet. Same
// shape the nwjs adapter produces for its own sealed/bundled containers.
function specialPlan(scan, requested, container, engine) {
  const special = (() => {
    if (container === "evb") return candidate("evb-unpack-rgss-script");
    if (isRgss(scan, engine, container)) return candidate("rgss-script");
    if (container === "tauri") return candidate("tauri-cdp");
    return null;
  })();

  if (!special) return null;
  return finishPlan({
    version: 1,
    family: "special",
    requested,
    preferred: special.id,
    selected: special.id,
    candidates: [special],
    blocked: [
      blocked("shadow", "该游戏使用专用容器路线，不能套用普通影子目录"),
      blocked("dll", "该游戏使用专用容器路线，不能套用普通 MV/MZ DLL 路线"),
      blocked("extension", "该游戏使用专用容器路线，不能套用普通扩展启动")
    ],
    override:
      requested !== "auto"
        ? `请求的 ${requested} 不适用于 ${container || engine}，已使用专用路线 ${special.id}`
        : null
  });
}

/**
 * Build a route decision from a scanner result.
 *
 * The planner deliberately does not claim that a route is fully working.  A
 * candidate's preflight list is the static part; launchers must still confirm
 * process appearance, bridge hello and runtime readiness before recording a
 * route as healthy. core/game-runtime.mjs consumes both: preflightOf() prunes
 * candidates before the first attempt, and `fallback` is retried when an attempt
 * fails before the bridge says hello.
 */
export function planLaunch(scan = {}, { requested = "auto", strategy } = {}) {
  const route = requestedRoute(strategy === undefined ? requested : strategy);
  for (const adapter of adapters()) {
    if (typeof adapter.plan !== "function") continue;
    const plan = adapter.plan(scan, { requested: route });
    if (plan) return plan;
  }
  return legacyPlan(scan, route);
}

function legacyPlan(scan, route) {
  const container = String(scan.container || "");
  const engine = String((scan.engine && scan.engine.id) || "");
  const special = specialPlan(scan, route, container, engine);
  if (special) return special;

  if (engine === "RM2K") {
    return finishPlan({
      version: 1,
      family: "unsupported-engine",
      requested: route,
      preferred: null,
      selected: null,
      candidates: [],
      blocked: [blocked("all", "RM2K 没有可用的 MV/MZ/RGSS 运行时桥")],
      error: "engine RM2K is not supported by the toolbox launch routes"
    });
  }

  return finishPlan({
    version: 1,
    family: "unknown",
    requested: route,
    preferred: null,
    selected: null,
    candidates: [],
    blocked: [blocked("all", "扫描结果不足以确认任何安全启动路线")],
    error: `无法根据扫描结果选择启动路线（engine=${engine || "unknown"}, container=${container || "unknown"}）`
  });
}
