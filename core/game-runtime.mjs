// Shared GUI/CLI entry point. This module sits above launcher and attach:
// attach may use launcher for takeover, so launcher must never import attach.
import { scanGame } from "./scanner.mjs";
import { launchGame } from "./launcher.mjs";
import { attachGame, launchNwInjectGame } from "./attach.mjs";
import { LaunchPlanError, planLaunch } from "./launch-plan.mjs";

function exposeLaunchPlan(summary, plan) {
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
  } catch (_) {}
  return summary;
}

export class GameRuntime {
  constructor({ scan = scanGame, launch = launchGame, attach = attachGame, launchInject = launchNwInjectGame, plan = planLaunch } = {}) {
    this.scan = scan;
    this.launchNormal = launch;
    this.attachRunning = attach;
    this.launchInject = launchInject;
    this.planLaunch = plan;
  }

  plan(options = {}) {
    const scan = this.scan(options.gameRoot);
    return this.planLaunch(scan, { strategy: options.strategy });
  }

  async launch(options) {
    const scan = this.scan(options.gameRoot);
    const plan = this.planLaunch(scan, { strategy: options.strategy });
    if (!plan.selected) throw new LaunchPlanError(plan);

    // The native route receives the same narrow input as before.  The route
    // decision is exposed on the returned summary rather than added to this
    // call, so existing adapters and test doubles keep their interface.
    if (plan.selected === "dll") {
      const summary = await this.launchInject({ scan, projectRoot: options.projectRoot, port: options.port });
      return exposeLaunchPlan(summary, plan);
    }
    const summary = await this.launchNormal(options);
    return exposeLaunchPlan(summary, plan);
  }

  async attach(options) {
    // The existing attach implementation owns takeover, rejection and the
    // running-process routes. In particular, don't silently change transports.
    return this.attachRunning(options);
  }
}

export const gameRuntime = new GameRuntime();
