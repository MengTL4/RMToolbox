// Shared GUI/CLI entry point. This module sits above launcher and attach:
// attach may use launcher for takeover, so launcher must never import attach.
import { scanGame } from "./scanner.mjs";
import { launchGame } from "./launcher.mjs";
import { attachGame } from "./attach.mjs";
import { LaunchPlanError, planLaunch } from "./launch-plan.mjs";
import { preflightOf, routeLabel } from "./launch-routes.mjs";

// How many routes a single user action may try. Two is enough for the observed
// failures (a shell refusing the preferred transport) and keeps a launch from
// turning into a parade of game windows.
const MAX_ATTEMPTS = 2;

// The operating system rejecting the executable (missing, not runnable, no
// permission) is a property of the game, not of the route — trying another
// transport would only produce the same failure with a worse message.
const NOT_RETRYABLE_CODES = new Set(["ENOENT", "EACCES", "EPERM", "ENOEXEC"]);

function isRetryable(error) {
  const code = error && error.code;
  return !(typeof code === "string" && NOT_RETRYABLE_CODES.has(code));
}

function exposeLaunchPlan(summary, plan, attempts) {
  // Keep the historical enumerable summary shape stable for CLI callers while
  // making the decision available to the GUI/logging seam.  Tests and older
  // hosts that retain object identity continue to receive the same summary.
  if (!summary || typeof summary !== "object") return summary;
  try {
    Object.defineProperty(summary, "launchPlan", {
      configurable: true,
      enumerable: false,
      value: plan,
      writable: false
    });
    if (attempts && attempts.length) {
      Object.defineProperty(summary, "routeAttempts", {
        configurable: true,
        enumerable: false,
        value: attempts,
        writable: false
      });
    }
  } catch (_) {}
  return summary;
}

export class GameRuntime {
  constructor({
    scan = scanGame,
    launch = launchGame,
    attach = attachGame,
    plan = planLaunch,
    log = null
  } = {}) {
    this.scan = scan;
    this.launchNormal = launch;
    this.attachRunning = attach;
    this.planLaunch = plan;
    this.log = log;
  }

  plan(options = {}) {
    const scan = this.scan(options.gameRoot);
    return this.planLaunch(scan, { strategy: options.strategy });
  }

  attemptRoute(id, options, isFallback) {
    // The route the user asked for reaches the launcher untouched: the launcher
    // owns the precise diagnostics (missing bg-script, ambiguous exe). Only a
    // fallback attempt has to spell the route out, because by then it differs
    // from what was requested.
    return this.launchNormal(
      isFallback ? { ...options, strategy: id } : options
    );
  }

  async launch(options) {
    const scan = this.scan(options.gameRoot);
    const plan = this.planLaunch(scan, { strategy: options.strategy });
    if (!plan.selected) throw new LaunchPlanError(plan);

    // Fallback is only honoured before the bridge is up: once a game has
    // announced itself, another attempt would just spawn a second instance.
    const order = [plan.selected, ...(plan.fallback || [])].slice(
      0,
      MAX_ATTEMPTS
    );
    const attempts = [];
    let lastError = null;

    for (let index = 0; index < order.length; index += 1) {
      const id = order[index];
      const isFallback = index > 0;
      // Only fallback candidates are pruned by the static preflight. The
      // selected route is always attempted, even when the scan says it will
      // fail, because the launcher reports that failure precisely ("no
      // bg-script to patch", "no unambiguous exe") and the user chose it.
      if (isFallback) {
        const preflight = preflightOf(scan, id);
        if (!preflight.ok) {
          attempts.push({
            id,
            label: routeLabel(id),
            skipped: preflight.reason
          });
          continue;
        }
      }
      try {
        const summary = await this.attemptRoute(id, options, isFallback);
        attempts.push({ id, label: routeLabel(id), ok: true });
        if (isFallback && this.log) {
          this.log("launch route fallback", {
            gameRoot: options.gameRoot,
            attempts
          });
        }
        if (
          summary &&
          typeof summary === "object" &&
          summary.strategy === undefined
        ) {
          summary.strategy = id;
        }
        return exposeLaunchPlan(summary, plan, attempts);
      } catch (error) {
        lastError = error;
        attempts.push({
          id,
          label: routeLabel(id),
          error: String((error && error.message) || error)
        });
        if (this.log)
          this.log("launch route failed", {
            gameRoot: options.gameRoot,
            route: id,
            error: String((error && error.message) || error)
          });
        // The OS refusing to run the file is not a route problem: every other
        // route would hit the same executable.
        if (!isRetryable(error)) break;
      }
    }

    if (!lastError) {
      lastError = new LaunchPlanError({
        ...plan,
        error: `所有候选路线在启动前就被否决：${attempts.map((a) => a.id + "(" + a.skipped + ")").join("; ")}`
      });
    }
    throw lastError;
  }

  async attach(options) {
    // The existing attach implementation owns takeover, rejection and the
    // running-process routes. In particular, don't silently change transports.
    return this.attachRunning(options);
  }
}

export const gameRuntime = new GameRuntime();
