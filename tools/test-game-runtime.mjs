import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  unlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { GameRuntime, gameRuntime } from "../core/game-runtime.mjs";
import { launchGame } from "../core/launcher.mjs";
import { scanGame } from "../core/scanner.mjs";
import { LaunchPlanError, planLaunch } from "../core/launch-plan.mjs";

// GUI and CLI use this same interface. Real platform execution is replaced,
// so selecting a fatal extension route is caught without launching a game.
const fixtures = [
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
      attach: async (received) => {
        assert.strictEqual(received, options);
        return { ...summary, strategy: "attached" };
      }
    });
    assert.strictEqual(await runtime.launch(options), summary);
    assert.equal((await runtime.attach(options)).strategy, "attached");
  }
}

// The flag-refusing shells have no launch route at all: launch() refuses at
// the plan stage, before any process effect, and the refusal points at attach.
// Attach stays available for the game the user started themselves.
for (const container of ["nb-evalnwbin", "enigma-nb"]) {
  const scan = { container, protection: { flags: [] } };
  const options = { gameRoot: "game", projectRoot: "toolbox", port: 47500 };
  const runtime = new GameRuntime({
    scan: () => scan,
    launch: async () => {
      throw Error("an attach-only game must never reach the launcher");
    },
    attach: async (received) => {
      assert.strictEqual(received, options);
      return { strategy: "nw-inject", pid: 42 };
    }
  });
  await assert.rejects(runtime.launch(options), LaunchPlanError);
  await assert.rejects(runtime.launch(options), /附加到运行中/);
  assert.equal((await runtime.attach(options)).strategy, "nw-inject");
}

// Grover's only launch route is shadow: asking for another route by name is
// refused with the available routes listed.
{
  const runtime = new GameRuntime({
    scan: () => ({ container: "nwjs", protection: { flags: ["grover-boot"] } }),
    launch: async () => {
      throw Error("a refused route must never reach the launcher");
    }
  });
  await assert.rejects(
    runtime.launch({
      gameRoot: "game",
      projectRoot: "toolbox",
      strategy: "extension"
    }),
    /不适用于此游戏；可用路线：shadow/
  );
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
  }
});
assert.equal(await shadowRuntime.launch(shadowOptions), "shadow");

// The retired dll route is refused at the plan stage even when asked for by
// name (a stale remembered route is reclaimed as 自动 before this — the plan
// refusal is the CLI-facing backstop).
const dllRuntime = new GameRuntime({
  scan: () => ({
    container: "nwjs",
    engine: { id: "MV" },
    paths: { exe: "game.exe" },
    protection: { flags: [] }
  }),
  launch: async () => {
    throw Error("the retired dll route reached the launcher");
  }
});
await assert.rejects(
  dllRuntime.launch({
    gameRoot: "game",
    projectRoot: "toolbox",
    port: 47501,
    strategy: "dll"
  }),
  (error) => {
    assert.ok(error instanceof LaunchPlanError);
    assert.match(error.message, /dll/);
    return true;
  }
);

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
    "shadow",
    "Grover scan must plan the route GameRuntime dispatches"
  );
  // The planner hands a non-fallback attempt to the launcher with the ORIGINAL
  // request ("auto"), so the launcher must resolve the route itself: comparing
  // the raw request string against "shadow" refused the Grover route the plan
  // had just selected. A shadow launch must also use the ORDINARY chain — the
  // shim+guards variant stalls before any scene (the user's black window), so
  // the launcher drops the flag and the patched bg-script carries no guards.
  // An explicit flagged transport stays refused before any process work.
  mkdirSync(path.join(renamed, "runtime", "bridge"), { recursive: true });
  writeFileSync(path.join(renamed, "runtime", "bridge", "manifest.json"), "{}");
  // The scanner only needs the manifest entry, but a shadow launch patches the
  // bg-script file itself, so the fixture needs one.
  writeFileSync(path.join(renamed, "loading"), "// shell loading script");
  const portProbe = net.createServer((socket) => socket.end());
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  try {
    const launchOptions = {
      gameRoot: renamed,
      projectRoot: renamed,
      port: portProbe.address().port,
      build: false
    };
    await assert.rejects(
      launchGame({ ...launchOptions, strategy: "auto" }),
      (error) => {
        assert.doesNotMatch(error.message, /only the shadow launch route/);
        // The shadow copy is built, so the failure is the fake exe spawn —
        // never the guarded chain's missing wmic shim.
        assert.doesNotMatch(error.message, /wmic shim/);
        return true;
      }
    );
    const patched = readFileSync(
      path.join(
        renamed,
        "runtime",
        "shadow-apps",
        renamedScan.gameKey,
        "loading"
      ),
      "utf8"
    );
    assert.doesNotMatch(
      patched,
      /__rmchGroverGuards/,
      "an automatic Grover launch must use the ordinary shadow chain"
    );
    assert.match(
      patched,
      /rmch-page-bridge/,
      "the bridge patch is still there"
    );
    await assert.rejects(
      launchGame({ ...launchOptions, strategy: "extension" }),
      /only the shadow launch route/
    );
  } finally {
    await new Promise((resolve) => portProbe.close(resolve));
  }
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

// OS refusals and live-copy guards must not spawn another route.
for (const code of ["ENOENT", "GAME_ALREADY_RUNNING", "PROCESS_QUERY_FAILED"]) {
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
      const error = Error(code);
      error.code = code;
      throw error;
    }
  });
  await assert.rejects(
    runtime.launch({
      gameRoot: "game",
      projectRoot: "toolbox",
      strategy: "auto"
    }),
    (error) => error.code === code
  );
  assert.deepEqual(
    seen,
    ["auto"],
    `${code} is not retried through another transport`
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
