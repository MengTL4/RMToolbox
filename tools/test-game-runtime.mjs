import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { GameRuntime, gameRuntime } from "../core/game-runtime.mjs";
import { scanGame } from "../core/scanner.mjs";
import { planLaunch } from "../core/launch-plan.mjs";

// GUI and CLI use this same interface. Real platform execution is replaced,
// so selecting a fatal extension route is caught without launching a game.
const fixtures = [
  ["nb-evalnwbin", [], "inject"],
  ["enigma-nb", [], "inject"],
  ["nwjs", ["grover-boot"], "inject"],
  ["nwjs", [], "normal"],
  ["tauri", [], "normal"],
  ["nwjs-sealed", [], "normal"],
  ["nwjs-bundled", [], "normal"],
  ["rgss", [], "normal"],
  ["evb", [], "normal"]
];
for (const [container, flags, expected] of fixtures) {
  for (const alreadyRunning of [false, true]) {
    const scan = { container, protection: { flags } };
    const options = {
      gameRoot: "game",
      projectRoot: "toolbox",
      port: 47500,
      strategy: "extension",
      build: false
    };
    const summary = { strategy: expected, pid: 42, alreadyRunning };
    const runtime = new GameRuntime({
      scan: () => scan,
      launch: async (received) => {
        assert.equal(expected, "normal");
        assert.strictEqual(received, options);
        return summary;
      },
      launchInject: async (received) => {
        assert.equal(expected, "inject");
        assert.deepEqual(received, {
          scan,
          projectRoot: options.projectRoot,
          port: options.port
        });
        return summary;
      },
      attach: async (received) => {
        assert.strictEqual(received, options);
        return { ...summary, strategy: "attached" };
      }
    });
    assert.strictEqual(await runtime.launch(options), summary);
    assert.equal((await runtime.attach(options)).strategy, "attached");
  }
}

const shadowOptions = {
  gameRoot: "game",
  projectRoot: "toolbox",
  strategy: "shadow"
};
const shadowRuntime = new GameRuntime({
  scan: () => ({ container: "nwjs", protection: { flags: ["grover-boot"] } }),
  launch: async (options) => {
    assert.strictEqual(options, shadowOptions);
    return "shadow";
  },
  launchInject: async () => {
    throw Error("explicit shadow choice was discarded");
  }
});
assert.equal(await shadowRuntime.launch(shadowOptions), "shadow");

const dllSummary = { strategy: "dll", pid: 43 };
const dllRuntime = new GameRuntime({
  scan: () => ({
    container: "nwjs",
    engine: { id: "MV" },
    paths: { exe: "game.exe" },
    protection: { flags: [] }
  }),
  launch: async () => {
    throw Error("explicit dll route used normal launcher");
  },
  launchInject: async (received) => {
    assert.deepEqual(received, {
      scan: dllRuntime.scan("game"),
      projectRoot: "toolbox",
      port: 47501
    });
    return dllSummary;
  }
});
assert.strictEqual(
  await dllRuntime.launch({
    gameRoot: "game",
    projectRoot: "toolbox",
    port: 47501,
    strategy: "dll"
  }),
  dllSummary
);
assert.equal(dllSummary.launchPlan.selected, "dll");

// Refusal through the production interface must happen before any execution
// or runtime output. This uses the real scanner and both real dispatchers.
const root = mkdtempSync(path.join(tmpdir(), "rmch-runtime-"));
try {
  const renamed = path.join(root, "renamed");
  mkdirSync(path.join(renamed, "www", "js"), { recursive: true });
  writeFileSync(
    path.join(renamed, "package.json"),
    JSON.stringify({
      name: "mrfb",
      main: "www/loading.html",
      "bg-script": "loading"
    })
  );
  writeFileSync(path.join(renamed, "末日风暴.exe"), "MZ fake");
  writeFileSync(path.join(renamed, "notification_helper.exe"), "NW helper");
  writeFileSync(
    path.join(renamed, "www", "js", "rpg_core.js"),
    Buffer.from([3, 4, 222, 192])
  );
  const renamedScan = scanGame(renamed);
  assert.equal(
    renamedScan.paths.exe,
    path.join(renamed, "末日风暴.exe"),
    "NW notification helper must not hide a renamed game entry point"
  );
  assert.equal(
    planLaunch(renamedScan).selected,
    "dll",
    "Grover scan must plan the route GameRuntime dispatches"
  );
  writeFileSync(path.join(renamed, "AnotherGame.exe"), "other game");
  assert.equal(
    scanGame(renamed).paths.exe,
    null,
    "multiple genuine game executables remain ambiguous"
  );
  mkdirSync(path.join(root, "nb_data"));
  writeFileSync(path.join(root, "nb_data", "nbtool.node"), "MZ fake");
  writeFileSync(path.join(root, "Game.exe"), "MZ fake");
  writeFileSync(
    path.join(root, "index.html"),
    '<script>require("./nb_data/nbtool.node").bootEncryptedBin();</script>'
  );
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ main: "index.html" })
  );
  await assert.rejects(
    gameRuntime.launch({ gameRoot: root, projectRoot: root }),
    /nb-shell/
  );
  await assert.rejects(
    gameRuntime.attach({ gameRoot: root, projectRoot: root }),
    /force-exits/
  );
  // A real OS spawn error must reject launch, not escape as an unhandled
  // ChildProcess error or return a successful summary with an undefined PID.
  const invalid = path.join(root, "invalid-executable");
  mkdirSync(path.join(invalid, "runtime", "bridge"), { recursive: true });
  writeFileSync(path.join(invalid, "Game.exe"), "not an executable");
  writeFileSync(
    path.join(invalid, "package.json"),
    JSON.stringify({ name: "spawn-error-test", main: "index.html" })
  );
  writeFileSync(path.join(invalid, "index.html"), "<html></html>");
  writeFileSync(path.join(invalid, "runtime", "bridge", "manifest.json"), "{}");
  // Remove it only after scanning, while ensureServer checks the port. This
  // reliably exercises asynchronous ENOENT on Windows and POSIX alike.
  const listener = net.createServer((socket) => {
    unlinkSync(path.join(invalid, "Game.exe"));
    socket.end();
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      gameRuntime.launch({
        gameRoot: invalid,
        projectRoot: invalid,
        port: listener.address().port,
        strategy: "extension",
        build: false
      }),
      /spawn|ENOENT/
    );
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

// Fallback is honoured before the bridge is up: a preferred route that fails is
// followed by the next candidate, and the attempt trail records both.
{
  const seen = [];
  let calls = 0;
  const scan = {
    container: "nwjs",
    engine: { id: "MV" },
    paths: { exe: "game.exe" },
    manifest: { bgScript: "loading" },
    protection: { flags: [] }
  };
  const runtime = new GameRuntime({
    scan: () => scan,
    launch: async (options) => {
      seen.push(options.strategy);
      calls += 1;
      // The selected route reaches the launcher with the user's own request
      // ("auto"); only the fallback attempt spells the route out.
      if (calls === 1) throw Error("shadow patch anchor missing");
      return { pid: 7 };
    },
    launchInject: async () => {
      throw Error("renderer never appeared");
    }
  });
  const summary = await runtime.launch({
    gameRoot: "game",
    projectRoot: "toolbox",
    strategy: "auto"
  });
  assert.deepEqual(
    seen,
    ["auto", "extension"],
    "the failed route is retried with the next candidate"
  );
  assert.equal(summary.strategy, "extension");
  assert.deepEqual(
    summary.routeAttempts.map((entry) => entry.id),
    ["shadow", "extension"]
  );
}

// An OS-level refusal is not a route problem: no second route is spawned.
{
  const seen = [];
  const scan = {
    container: "nwjs",
    engine: { id: "MV" },
    paths: { exe: "game.exe" },
    manifest: { bgScript: "loading" },
    protection: { flags: [] }
  };
  const runtime = new GameRuntime({
    scan: () => scan,
    launch: async (options) => {
      seen.push(options.strategy);
      const error = Error("spawn game.exe ENOENT");
      error.code = "ENOENT";
      throw error;
    }
  });
  await assert.rejects(
    runtime.launch({
      gameRoot: "game",
      projectRoot: "toolbox",
      strategy: "auto"
    }),
    /ENOENT/
  );
  assert.deepEqual(
    seen,
    ["auto"],
    "a missing executable is not retried through another transport"
  );
}

// A fallback candidate that the scan can already rule out is skipped, not tried.
{
  const seen = [];
  let calls = 0;
  const scan = {
    container: "nwjs",
    engine: { id: "MV" },
    manifest: { bgScript: "loading" },
    protection: { flags: [] }
  };
  const runtime = new GameRuntime({
    scan: () => scan,
    launch: async (options) => {
      seen.push(options.strategy);
      calls += 1;
      if (calls === 1) throw Error("shadow patch anchor missing");
      return { pid: 8 };
    }
  });
  await assert.rejects(
    runtime.launch({
      gameRoot: "game",
      projectRoot: "toolbox",
      strategy: "auto"
    }),
    /shadow patch anchor/
  );
  assert.deepEqual(
    seen,
    ["auto"],
    "extension was skipped: the scan proves there is no exe to launch"
  );
}

console.log(
  "test-game-runtime: shared routing, fallback and real refusal passed"
);
