// Shared GUI/CLI entry point. This module sits above launcher and attach:
// attach may use launcher for takeover, so launcher must never import attach.
import { scanGame } from "./scanner.mjs";
import { launchGame } from "./launcher.mjs";
import { attachGame, launchNwInjectGame } from "./attach.mjs";

export class GameRuntime {
  constructor({ scan = scanGame, launch = launchGame, attach = attachGame, launchInject = launchNwInjectGame } = {}) {
    this.scan = scan;
    this.launchNormal = launch;
    this.attachRunning = attach;
    this.launchInject = launchInject;
  }

  async launch(options) {
    const scan = this.scan(options.gameRoot);
    // These shells need a flag-free launch followed by DLL injection. Grover
    // has a different reason (shadow boot freezes), but the same delivery path.
    const grover = scan.protection && scan.protection.flags
      && scan.protection.flags.includes("grover-boot");
    if (scan.container === "nb-evalnwbin" || scan.container === "enigma-nb" || (grover && options.strategy !== "shadow")) {
      return this.launchInject({ scan, projectRoot: options.projectRoot, port: options.port });
    }
    return this.launchNormal(options);
  }

  async attach(options) {
    // The existing attach implementation owns takeover, rejection and the
    // running-process routes. In particular, don't silently change transports.
    return this.attachRunning(options);
  }
}

export const gameRuntime = new GameRuntime();
