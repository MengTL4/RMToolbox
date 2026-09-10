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
// name a route the same way. Only the container-specific *reason* is decided here.

import { ROUTES, routeLabel, routeMechanism, routeMechanismText, preflightOf } from "./launch-routes.mjs";

export class LaunchPlanError extends Error {
  constructor(plan) {
    super(plan && plan.error || "no compatible launch route");
    this.name = "LaunchPlanError";
    this.plan = plan;
  }
}

// The request vocabulary is the catalogue's route ids plus "auto" — nothing
// else. The old aliases (inject/native/native-dll) died with LAUNCH_ROUTES.
function requestedRoute(value) {
  return String(value || "auto").trim().toLowerCase();
}

function hasFlag(scan, flag) {
  return Array.isArray(scan && scan.protection && scan.protection.flags)
    && scan.protection.flags.includes(flag);
}

function isRgss(scan, engine, container) {
  return container === "rgss" || /^RGSS/i.test(engine);
}

function isStandardNw(scan, engine, container) {
  if (container === "nwjs") return true;
  if (container && /^nwjs-/i.test(container)) return false;
  if (engine === "unknown-nwjs" || engine === "MV" || engine === "MZ" || engine === "MV/MZ") return true;
  return !!(scan && (scan.manifest || scan.paths && scan.paths.exe));
}

// A candidate is the catalogue entry plus the reason that applies to this game,
// so every consumer (GUI dropdown, log, summary) reads the same label.
function candidate(id, reason) {
  const entry = ROUTES[id] || { id, label: id, mechanism: null, transport: null, preflight: [] };
  return {
    id,
    label: entry.label,
    userGoal: entry.userGoal || null,
    mechanism: routeMechanism(id),
    mechanismLabel: routeMechanismText(id),
    reason: reason || entry.reason,
    transport: entry.transport,
    preflight: [...(entry.preflight || [])]
  };
}

function blocked(id, reason) {
  return { id, label: routeLabel(id), reason };
}

function finish(plan) {
  const selected = plan.candidates.find((entry) => entry.id === plan.selected) || null;
  plan.selectedReason = selected ? selected.reason : null;
  plan.selectedLabel = selected ? selected.label : null;
  plan.fallback = plan.candidates
    .filter((entry) => entry.id !== plan.selected)
    .map((entry) => entry.id);
  plan.canFallbackBeforeBridge = plan.fallback.length > 0;
  if (!plan.selected && !plan.error) {
    plan.error = "没有可用的启动路线";
  }
  return plan;
}

function specialPlan(scan, requested, container, engine) {
  if (container === "nb-shell") {
    return finish({
      version: 1,
      family: "unsupported-shell",
      requested,
      preferred: null,
      selected: null,
      candidates: [],
      blocked: [blocked("shadow", "nb-shell 会校验启动文件并检测 DLL 注入"), blocked("extension", "nb-shell 拒绝启动参数")],
      error: "nb-shell protected game: 没有存活的工具箱启动路线"
    });
  }

  const special = (() => {
    if (container === "evb") return candidate("evb-unpack-rgss-script");
    if (isRgss(scan, engine, container)) return candidate("rgss-script");
    if (container === "tauri") return candidate("tauri-cdp");
    if (container === "nwjs-sealed") return candidate("extension-cdp-seed");
    if (container === "nwjs-bundled") return candidate("shadow-engine-publish");
    return null;
  })();

  if (!special) return null;
  return finish({
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
    override: requested !== "auto"
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
  const container = String(scan.container || "");
  const engine = String(scan.engine && scan.engine.id || "");
  const grover = hasFlag(scan, "grover-boot");
  const bgScript = !!(scan.manifest && scan.manifest.bgScript);
  const hasExe = !!(scan.paths && scan.paths.exe);
  const special = specialPlan(scan, route, container, engine);
  if (special) return special;

  if (engine === "RM2K") {
    return finish({
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

  if (container === "nb-evalnwbin" || container === "enigma-nb" || grover || isStandardNw(scan, engine, container)) {
    const candidates = [];
    const blockedRoutes = [];

    if (container === "nb-evalnwbin") {
      candidates.push(candidate("dll", "NB evalNWBin 拒绝启动参数，只接受裸启动后 DLL 注入"));
      blockedRoutes.push(blocked("shadow", "该壳会因启动参数退出"), blocked("extension", "该壳会因启动参数退出"));
    } else if (container === "enigma-nb") {
      candidates.push(candidate("dll", "Enigma-NB 对任何启动参数敏感，采用裸启动后 DLL 注入"));
      blockedRoutes.push(blocked("shadow", "Enigma-NB 会因启动参数退出"), blocked("extension", "Enigma-NB 会因启动参数退出"));
    } else if (grover) {
      candidates.push(candidate("dll", "Grover 启动链需要裸启动并等待保护检查结束后注入"));
      // Keep an explicit shadow request visible even when a sparse scan/test
      // fixture omitted the manifest.  The launcher will perform the final
      // bg-script preflight and report its precise error; silently converting
      // that explicit request to DLL would hide the user's choice.
      candidates.push(candidate("shadow", bgScript
        ? "该游戏有可补丁的 bg-script，影子目录可作为显式备用路线"
        : "影子路线已被显式请求，但启动前仍需发现 bg-script"));
      if (!bgScript) blockedRoutes.push(blocked("shadow-preflight", preflightOf(scan, "shadow").reason));
      blockedRoutes.push(blocked("extension", "Grover 对带启动参数的扩展启动不稳定"));
    } else {
      if (bgScript) {
        candidates.push(candidate("shadow"));
      } else {
        blockedRoutes.push(blocked("shadow", preflightOf(scan, "shadow").reason));
      }
      candidates.push(candidate("extension"));
      candidates.push(candidate("dll", "标准 NW.js 可裸启动后向 renderer 投递 native bridge"));
    }

    // A static scan cannot prove the executable is runnable. Keep the route in
    // the plan so the launcher can report the missing preflight item instead of
    // silently selecting a different transport.
    if (!hasExe) {
      blockedRoutes.push(blocked("preflight", "扫描结果没有确定的游戏 EXE，启动前必须先解决入口歧义"));
    }

    const preferred = candidates[0] && candidates[0].id || null;
    let selected = preferred;
    let override = null;
    if (route !== "auto") {
      const requestedCandidate = candidates.find((entry) => entry.id === route);
      if (requestedCandidate) {
        selected = requestedCandidate.id;
      } else if ((container === "nb-evalnwbin" || container === "enigma-nb" || grover) && route !== "dll" && preferred === "dll") {
        // Preserve the old public behaviour: a generic/extension request on a
        // shell is translated to its only safe route, with the override made
        // visible in the plan instead of being an unexplained dispatch.
        selected = preferred;
        override = `请求的 ${route} 被保护壳拒绝，已改用 ${preferred}`;
      } else {
        selected = null;
      }
    }

    const plan = {
      version: 1,
      family: grover ? "grover-nwjs" : container === "nb-evalnwbin" ? "nb-evalnwbin" : container === "enigma-nb" ? "enigma-nb" : "standard-nwjs",
      requested: route,
      preferred,
      selected,
      candidates,
      blocked: blockedRoutes,
      override,
      readiness: {
        required: ["process", "bridge-hello", "runtime-ready"],
        fallbackOnlyBefore: "bridge-hello"
      }
    };
    if (!selected) {
      plan.error = `请求的启动路线 ${route} 不适用于此游戏；可用路线：${candidates.map((entry) => entry.id).join(", ") || "无"}`;
    }
    return finish(plan);
  }

  return finish({
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
