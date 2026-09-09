// Exercise the production NW attachment module without Windows processes.
// Only process effects and time are replaced. Bridge assembly, PE parsing,
// bootstrap rendering, file hello detection and reload commands use real files.
import assert from "node:assert/strict";
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmSync, utimesSync, writeFileSync
} from "node:fs";
import net from "node:net";
import vm from "node:vm";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttachError, createNwAttachment } from "../core/attach.mjs";
import { buildGroverCompatibilityBootstrap, hasGroverModuleMonitor } from "../core/grover-compat.mjs";

const projectSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = mkdtempSync(path.join(tmpdir(), "rmch-nw-attachment-"));
const previousProgramFiles = process.env["ProgramFiles(x86)"];
process.env["ProgramFiles(x86)"] = "C:\\Program Files (x86)";
// ensureServer probes this real loopback listener and never launches serve.mjs.
const server = net.createServer((socket) => socket.end());
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const port = server.address().port;
let checks = 0;

function fixture(family, options = {}) {
  const root = mkdtempSync(path.join(tempRoot, "case-"));
  const projectRoot = path.join(root, "toolbox");
  const gameRoot = path.join(root, "游戏");
  const parts = path.join(projectRoot, "runtime", "bridge", "src", "parts");
  mkdirSync(parts, { recursive: true });
  for (const name of readdirSync(path.join(projectSource, "runtime", "bridge", "src", "parts"))) {
    if (name.endsWith(".js")) {
      copyFileSync(path.join(projectSource, "runtime", "bridge", "src", "parts", name), path.join(parts, name));
    }
  }
  mkdirSync(gameRoot, { recursive: true });
  const exe = path.join(gameRoot, "游戏.exe");
  const pe = Buffer.alloc(256);
  pe.write("MZ", 0, "latin1");
  pe.writeUInt32LE(128, 60);
  pe.write("PE\0\0", 128, "latin1");
  pe.writeUInt16LE(0x14c, 132);
  writeFileSync(exe, pe);
  const scan = {
    root: gameRoot, gameKey: "fixture", title: "测试游戏", paths: { exe },
    engine: { id: "MV/MZ" }, container: family === "grover" ? "nwjs" : family,
    protection: { flags: family === "grover" ? ["grover-boot"] : [] }
  };
  const stateDir = path.join(projectRoot, "runtime", "bridge-state", scan.gameKey);
  const commandPath = path.join(stateDir, "commands.jsonl");
  const eventPath = path.join(stateDir, "events.jsonl");
  const statePath = path.join(stateDir, "state.json");
  const cachePath = path.join(stateDir, "catalog-cache.json");
  const processRow = (pid, cmd, executable = exe) => ({
    ProcessId: pid, ParentProcessId: 101, ExecutablePath: executable, CommandLine: cmd
  });
  // Deliberately shuffled, including an unrelated game's renderer.
  const gameProcesses = [
    processRow(103, "--type=renderer --extension-process"),
    processRow(201, "--type=renderer", path.join(root, "游戏-other", "游戏.exe")),
    processRow(104, "--type=gpu-process"),
    processRow(101, ""),
    processRow(102, "--type=renderer")
  ];
  if (options.outerLauncher) gameProcesses.unshift(processRow(100, ""));
  const context = {
    scan, projectRoot, stateDir, commandPath, eventPath, statePath, cachePath,
    processRow, gameProcesses, processes: options.running === false ? [] : gameProcesses,
    now: Date.now(), sleeps: [], spawns: [], spawnTimes: [], injections: [], clearedFlags: [],
    queries: 0, moduleQueries: 0, captureReplies: new Set(), bridgeAlive: false
  };
  context.commands = () => existsSync(commandPath)
    ? readFileSync(commandPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  context.publishHello = (timestamp = context.now) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, "{}");
    utimesSync(statePath, timestamp / 1000, timestamp / 1000);
    appendFileSync(eventPath, JSON.stringify({ t: "hello", ts: timestamp, gameKey: scan.gameKey }) + "\n");
    context.bridgeAlive = timestamp === context.now;
  };
  const clock = {
    now: () => context.now,
    sleep: async (ms) => {
      context.now += ms;
      context.sleeps.push(ms);
      assert.ok(context.sleeps.length < 2000, "orchestration must terminate");
      if (options.onSleep) await options.onSleep(ms, context);
      if (context.compatReadyAt && context.now >= context.compatReadyAt + (options.compatibilityLateMs || 0) && !options.compatibilityNeverReady && (!options.lateWindow || context.windowShown)) {
        context.publishHello();
        context.compatReadyAt = null;
      }
      if (context.bridgeAlive && existsSync(statePath)) {
        utimesSync(statePath, context.now / 1000, context.now / 1000);
      }
      // Stand in for the already-injected bridge handling its real JSONL
      // reboot command, after the module has pre-armed the reload bootstrap.
      if (options.capture !== false) {
        for (const command of context.commands()) {
          if (command.type !== "system.rebootCapture" || context.captureReplies.has(command.commandId)) continue;
          assert.ok(context.injections.some((entry) => entry.env.RMCH_THROW_IF_BRIDGED === "1"),
            "capture reload must have been pre-armed");
          context.captureReplies.add(command.commandId);
          context.publishHello();
          writeFileSync(cachePath, JSON.stringify({ version: 1, tables: Object.fromEntries(
            ["actor", "skill", "item", "weapon", "armor", "state"].map(key => [key, [null, { id: 1 }]])
          ) }));
        }
      }
    }
  };
  const platform = {
    listProcessModules: async (pid) => {
      context.moduleQueries += 1;
      const race = options.moduleQueryRace;
      if (race && context.moduleQueries <= (race.failures || 1)) {
        if (race.replaceRenderer && context.moduleQueries === 1) {
          context.processes = [processRow(101, ""), processRow(202, "--type=renderer")];
        }
        throw new AttachError("process query failed: Cannot find a process with the process identifier");
      }
      return options.modules || [];
    },
    listProcessesByExeName: async (name) => {
      assert.equal(name, "游戏.exe");
      context.queries += 1;
      return options.onQuery ? options.onQuery(context) : context.processes;
    },
    clearRunAsAdminFlag: (file) => { context.clearedFlags.push(file); },
    cmdStartSpawn: (...args) => {
      assert.deepEqual(args.slice(0, 2), [exe, gameRoot]);
      assert.equal(args.length, 3, "plain launch must not gain extraEnv or flags");
      context.spawns.push("primary");
      context.spawnTimes.push(context.now);
      if (options.primaryAppears !== false) context.processes = gameProcesses;
    },
    shellExecuteSpawn: (...args) => {
      assert.deepEqual(args.slice(0, 2), [exe, gameRoot]);
      assert.equal(args.length, 3);
      context.spawns.push("fallback");
      context.spawnTimes.push(context.now);
      if (options.fallbackAppears !== false) context.processes = gameProcesses;
    },
    showNwGameWindow: async (pid) => {
      if (options.outerLauncher && pid === 100) return [];
      if (options.lateWindow && !context.compatReadyAt) return [];
      assert.equal(pid, 101); context.windowShown = true; return true;
    },
    injectAndDeliver: async (request) => {
      const match = request.bootstrap.match(/Object\.assign\(process\.env, (.+)\);/);
      if (request.bootstrap.includes("__rmchGroverCompatibility")) {
        assert.deepEqual(context.commands(), [], "cold compatibility injection must not replay old commands");
        assert.equal(existsSync(eventPath), false, "old hello/results are cleared before delayed bridge starts");
        assert.equal(existsSync(statePath), false, "old state cannot satisfy delayed readiness");
        assert.ok(Buffer.byteLength(request.bootstrap) < 16000, "early payload must reference the bridge file, never embed the full bridge source");
        context.injections.push({ ...request, env: {}, compatibility: true, at: context.now });
        if (options.deliveryLateMs) {
          context.now += Math.min(options.deliveryLateMs, request.timeoutMs);
          if (request.timeoutMs < options.deliveryLateMs) return {ok:false,detail:'core-timeout'};
        }
        if (options.compatibilityStalePid && request.pid !== 202) {
          context.processes = [processRow(101, ""), processRow(202, "--type=renderer")];
          return {ok:false,detail:"injector-exit-2: OpenProcess failed: 87"};
        }
        if (options.compatibilityTimeoutRace && context.injections.filter((entry) => entry.compatibility).length <= (options.compatibilityTimeoutRaceFailures || 1)) {
          context.processes = [processRow(101, ""), processRow(202, "--type=renderer")];
          return { ok: false, detail: "core-timeout" };
        }
        if (options.compatibilityFailure) return { ok: false, detail: "compatibility probe failed" };
        vm.runInNewContext(request.bootstrap, {
          window: { SceneManager: { _scene: {} }, document: { hidden: false } },
          process: { env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, report: {
            getReport: () => ({ sharedObjects: options.modules || [] })
          } }, require: name => name === "fs" ? fs : name === "timers" ? {
            setTimeout: (_callback, delay) => { context.compatReadyAt = context.now + delay; }
          } : path,
          nw: { Window: {} }
        });
        return { ok: true, detail: "evaled" };
      }
      assert.ok(match, "use the real rendered bootstrap");
      const env = JSON.parse(match[1]);
      const entry = { ...request, env };
      context.injections.push(entry);
      assert.equal(request.arch, "win32", "read the synthetic PE through production code");
      assert.equal(request.dllName, "rmch-mvhook.dll");
      assert.equal(request.mode, "crt");
      const result = options.onInject
        ? await options.onInject(entry, context)
        : { ok: true, detail: "evaled" };
      if (result.ok && env.RMCH_TRANSPORT === "file" && !env.RMCH_THROW_IF_BRIDGED && options.announce !== false) {
        context.publishHello();
      }
      return result;
    }
  };
  const module = createNwAttachment({ platform, clock });
  context.attach = () => module.attach({ scan, projectRoot, port });
  context.launch = () => module.launch({ scan, projectRoot, port });
  return context;
}

try {
  // This matrix intentionally records existing transport differences. A
  // refactor must not silently unify Enigma-NB or Grover across operations.
  for (const family of ["nb-evalnwbin", "enigma-nb", "grover"]) {
    for (const operation of ["attach", "existing", "launched"]) {
      const game = fixture(family, { running: operation !== "launched" });
      const result = await (operation === "attach" ? game.attach() : game.launch());
      const file = operation === "existing" || family === "nb-evalnwbin"
        || (family === "grover" && operation === "launched");
      const sealed = file || family === "enigma-nb";
      const first = game.injections[0];
      assert.equal(first.env.RMCH_TRANSPORT, file ? "file" : undefined);
      assert.equal(first.env.RMCH_SEALED, sealed ? "1" : undefined);
      assert.equal(first.env.RMCH_SELF_SEED, family === "nb-evalnwbin" ? "1" : undefined,
        "Enigma publishes native globals after login; heap publication is only needed for sealed evalNWBin");
      assert.equal(first.env.RMCH_BOOT_TAP, undefined, "normal attachment never installs the boot tap");
      assert.equal(first.timeoutMs, file && operation === "launched" ? 10000 : 30000);
      assert.equal(result.strategy, operation === "launched"
        ? file ? "nw-launch-inject-file" : "nw-launch-inject"
        : file ? "nw-inject-file" : "nw-inject");
      assert.equal(result.pid, 101);
      assert.deepEqual(result.injected, [102], "stop after the first successful renderer");
      assert.equal(result.port, file ? null : port);
      assert.deepEqual(game.spawns, operation === "launched" ? ["primary"] : []);
      assert.equal(game.commands().length, file && operation === "launched" ? 1 : 0,
        "only a file game actually spawned in this call may reload for capture");
      assert.equal(game.injections.filter((entry) => entry.env.RMCH_BOOT_TAP === "1").length > 0,
        file && operation === "launched");
      if (operation === "launched") {
        assert.ok(game.sleeps.includes(family === "grover" ? 60000 : 30000));
        assert.equal(result.launchedPid, 101);
      } else {
        assert.equal(result.launchedPid, undefined);
        assert.equal(game.sleeps.length, 0, "a settled existing instance needs no startup wait");
      }
      checks += 1;
    }
  }

  for (const family of ["nwjs", "nb-evalnwbin"]) {
    const game = fixture(family, {
      onInject: async (entry) => ({ ok: entry.pid === 103, detail: "fixture" })
    });
    game.processes.push(game.processRow(105, "--type=renderer"));
    const result = await game.attach();
    assert.deepEqual(game.injections.map((entry) => entry.pid), [102, 105, 103]);
    assert.deepEqual(result.injected, [103]);
    assert.equal(result.pid, 101);
    checks += 1;
  }

  const single = fixture("nwjs");
  single.processes = [single.processRow(101, "")];
  assert.deepEqual((await single.attach()).injected, [101]);
  checks += 1;

  // Retry budgets and timeouts are exercised through real attachment/launch.
  for (const [family, launch, attempts, timeout, existing] of [
    ["nwjs", false, 1, 30000], ["enigma-nb", false, 5, 30000],
    ["enigma-nb", true, 8, 30000], ["nb-evalnwbin", true, 8, 10000],
    ["enigma-nb", true, 1, 30000, true]
  ]) {
    const game = fixture(family, {
      running: existing || !launch,
      onInject: async () => ({ ok: false, detail: "fixture miss" })
    });
    await assert.rejects(launch ? game.launch() : game.attach(), /injection failed/);
    assert.equal(game.injections.length, attempts * 2);
    assert.ok(game.injections.every((entry) => entry.timeoutMs === timeout));
    assert.equal(game.sleeps.filter((ms) => ms === 4000).length, attempts - 1);
    assert.equal(game.commands().length, 0);
    checks += 1;
  }

  const appearing = fixture("enigma-nb", {
    onQuery: (game) => {
      if (game.queries === 1) throw new AttachError("transient process query");
      if (game.queries === 2) return [];
      return game.gameProcesses;
    }
  });
  assert.equal((await appearing.attach()).strategy, "nw-inject");
  assert.deepEqual(appearing.sleeps, [4000, 4000]);
  assert.equal(appearing.injections.length, 1);
  checks += 1;

  for (const operation of ["attach", "launch"]) {
    const game = fixture("nb-evalnwbin");
    game.publishHello();
    writeFileSync(game.commandPath, '{"type":"pending"}\n');
    const previousEvents = readFileSync(game.eventPath, "utf8");
    const result = await game[operation]();
    assert.deepEqual(result.injected, []);
    assert.deepEqual(game.injections, []);
    assert.deepEqual(game.spawns, []);
    assert.equal(readFileSync(game.eventPath, "utf8"), previousEvents);
    assert.deepEqual(game.commands(), [{ type: "pending" }]);
    checks += 1;
  }

  const raced = fixture("nb-evalnwbin", {
    announce: false,
    onInject: async (_entry, game) => {
      assert.equal(existsSync(game.commandPath), false, "discard stale queued commands");
      assert.equal(existsSync(game.eventPath), false, "discard stale hello");
      game.publishHello();
      return { ok: false, detail: "result pipe raced" };
    }
  });
  raced.processes = [raced.processRow(101, ""), raced.processRow(102, "--type=renderer")];
  raced.publishHello(raced.now - 6000);
  writeFileSync(raced.commandPath, '{"type":"old"}\n');
  const racedResult = await raced.attach();
  assert.deepEqual(racedResult.injected, []);
  assert.equal(racedResult.results[0].ok, false, "a real fresh hello confirms the otherwise-failed injection");
  assert.equal(raced.injections.length, 1);
  checks += 1;

  for (const launch of [false, true]) {
    const game = fixture("nb-evalnwbin", { running: !launch, announce: false });
    await assert.rejects(launch ? game.launch() : game.attach(), launch ? /within 60s/ : /within 30s/);
    assert.equal(game.injections.length, 1, "successful eval waits for hello without more DLL injections");
    assert.equal(game.commands().length, 0);
    checks += 1;
  }

  const absent = fixture("nb-evalnwbin", { running: false });
  await assert.rejects(absent.attach(), /no running/);
  assert.equal(existsSync(path.join(absent.projectRoot, "runtime", "rmch.token")), false);
  assert.equal(existsSync(path.join(absent.projectRoot, "runtime", "bridge", "page-bridge.js")), false);
  assert.equal(existsSync(absent.stateDir), false);
  checks += 1;

  const fallback = fixture("enigma-nb", { running: false, primaryAppears: false });
  assert.equal((await fallback.launch()).strategy, "nw-launch-inject");
  assert.deepEqual(fallback.spawns, ["primary", "fallback"]);
  assert.equal(fallback.spawnTimes[1] - fallback.spawnTimes[0], 25000);
  checks += 1;

  const neverStarts = fixture("enigma-nb", {
    running: false, primaryAppears: false, fallbackAppears: false
  });
  const neverStartsAt = neverStarts.now;
  await assert.rejects(neverStarts.launch(), /within 60s/);
  assert.deepEqual(neverStarts.spawns, ["primary", "fallback"]);
  assert.equal(neverStarts.now - neverStartsAt, 60000);
  assert.equal(neverStarts.injections.length, 0);
  checks += 1;

  const queryRace = fixture("enigma-nb", {
    running: false,
    onQuery: (game) => {
      if (game.queries === 2) throw new AttachError("transient launch poll");
      return game.processes;
    }
  });
  assert.equal((await queryRace.launch()).strategy, "nw-launch-inject");
  assert.deepEqual(queryRace.spawns, ["primary"]);
  assert.match(readFileSync(path.join(queryRace.stateDir, "bridge.log"), "utf8"), /process poll error/);
  checks += 1;

  const noRenderer = fixture("enigma-nb", {
    running: false,
    onSleep: (ms, game) => {
      if (ms === 400) game.processes = [game.processRow(101, "")];
    }
  });
  await assert.rejects(noRenderer.launch(), /no renderer process appeared within 90s/);
  assert.equal(noRenderer.injections.length, 0);
  checks += 1;

  const exitedBeforeRetry = fixture("nb-evalnwbin", {
    running: false,
    onInject: async () => ({ ok: false, detail: "renderer not ready" }),
    onSleep: (ms, game) => { if (ms === 4000) game.processes = []; }
  });
  await assert.rejects(exitedBeforeRetry.launch(), /game exited while waiting to attach/);
  assert.equal(exitedBeforeRetry.injections.length, 2);
  assert.equal(exitedBeforeRetry.commands().length, 0);
  checks += 1;

  for (const duringSettle of [false, true]) {
    const game = fixture("nb-evalnwbin", {
      running: false,
      onSleep: (ms, current) => {
        if (ms === (duringSettle ? 30000 : 400)) current.processes = [];
      }
    });
    await assert.rejects(game.launch(), duringSettle ? /before attach/ : /exited during boot/);
    assert.equal(game.injections.length, 0);
    assert.equal(game.commands().length, 0);
    checks += 1;
  }

  for (const operation of ["attach", "launch"]) {
    const game = fixture("nb-evalnwbin");
    game.processes = [{ ProcessId: 101, ExecutablePath: "", CommandLine: "" }];
    await assert.rejects(game[operation](), /管理员/);
    assert.deepEqual(game.clearedFlags, [game.scan.paths.exe]);
    assert.deepEqual(game.spawns, []);
    assert.deepEqual(game.injections, []);
    checks += 1;
  }

  const partialCatalog = fixture("nb-evalnwbin", {
    running: false,
    onInject: async (entry, game) => {
      if (!entry.env.RMCH_THROW_IF_BRIDGED) {
        mkdirSync(game.stateDir, { recursive: true });
        writeFileSync(game.cachePath, JSON.stringify({ version: 1, tables: {
          item: [null, { id: 1 }], weapon: [null], armor: [null], state: [null]
        } }));
      }
      return { ok: true, detail: "evaled" };
    }
  });
  await partialCatalog.launch();
  assert.equal(partialCatalog.commands().length, 1, "partial cache must retry early capture for missing actor and skill tables");
  checks += 1;

  const noCatalog = fixture("nb-evalnwbin", { running: false, capture: false });
  assert.equal((await noCatalog.launch()).strategy, "nw-launch-inject-file");
  assert.equal(noCatalog.commands().length, 2, "capture remains bounded and best-effort");
  assert.equal(existsSync(noCatalog.cachePath), false);
  checks += 1;

  const knownModule = "C:\\Program Files (x86)\\Sangfor\\SSL\\SangforPWEx\\SangforUDProtectEx_202591913857893.dll";
  for (const modules of [[], [knownModule], ["D:\\MacType\\MacType.dll", "D:\\MacType\\MacType.Core.dll"]]) {
    const game = fixture("grover", { running: false, modules });
    if (!modules.some(value => value.includes("MacType"))) game.scan.protection.flags.push("grover-module-monitor");
    if (modules.length) {
      mkdirSync(game.stateDir, { recursive: true });
      writeFileSync(game.commandPath, JSON.stringify({ commandId: "f1", type: "game.newGame", args: {} }) + "\n");
      game.publishHello(game.now - 60000);
    }
    assert.equal((await game.launch()).strategy, "nw-launch-inject-file");
    if (modules.length) {
      assert.equal(game.injections.length, 1, "one native delivery; no reload loses the compatibility layer");
      assert.equal(game.injections[0].compatibility, true);
      assert.equal(game.windowShown, true, "restore the known game's native window for its first animation frame");
      assert.ok(game.now - game.injections[0].at < 5000, "a ready scene must not accumulate uncapped frames in a fixed settle delay");
      const status = JSON.parse(readFileSync(path.join(game.stateDir, "grover-compat.json"), "utf8"));
      assert.equal(status.status, "applied");
    } else {
      assert.ok(game.injections.every(i => !i.compatibility), "without actual known modules the old route is unchanged");
    }
    checks++;
  }
  const lateDelivery = fixture("grover", {running:false,modules:[knownModule],deliveryLateMs:19000});
  await lateDelivery.launch();
  assert.equal(lateDelivery.injections.length,1,"wait for the native hook result without injecting twice");
  checks++;
  const outerLauncher = fixture("grover", {running:false,modules:[knownModule],outerLauncher:true});
  await outerLauncher.launch();
  assert.equal(outerLauncher.windowShown,true,"restore NW's game window even when an outer launcher appears first");
  checks++;
  const lateWindow = fixture("grover", {running:false,modules:[knownModule],lateWindow:true});
  await lateWindow.launch();assert.equal(lateWindow.windowShown,true,"retry window restoration after renderer discovery precedes window creation");checks++;
  const compatFailure = fixture("grover", { running: false, compatibilityFailure: true, modules: [knownModule] });
  compatFailure.scan.protection.flags.push("grover-module-monitor");
  await assert.rejects(compatFailure.launch(), /compatibility could not reach/);
  assert.ok(compatFailure.injections.every(i => i.compatibility), "never install full bridge after failed preparation");
  checks++;
  const liveCompat = fixture("grover", { modules: [knownModule] });
  liveCompat.scan.protection.flags.push("grover-module-monitor");
  liveCompat.publishHello();
  writeFileSync(liveCompat.commandPath, JSON.stringify({commandId:"previous-session",type:"ping",args:{}})+"\n");
  await liveCompat.launch();
  assert.equal(liveCompat.commands()[0].commandId,"previous-session", "existing live file session is never cleared");
  assert.equal(liveCompat.injections.length,0, "existing hello is reused without another native hook");
  checks++;
  const staleCompat = fixture("grover", {running:false,modules:[knownModule],compatibilityStalePid:true});
  staleCompat.scan.protection.flags.push("grover-module-monitor");
  await staleCompat.launch();
  assert.equal(staleCompat.injections.at(-1).pid,202,"only a failed OpenProcess permits refreshing the replacement renderer");
  checks++;
  const moduleQueryRace = fixture("grover", {
    running: false, modules: [knownModule],
    moduleQueryRace: { failures: 1, replaceRenderer: true }
  });
  moduleQueryRace.scan.protection.flags.push("grover-module-monitor");
  await moduleQueryRace.launch();
  assert.equal(moduleQueryRace.moduleQueries >= 2, true, "retry module inspection after a renderer replacement");
  assert.equal(moduleQueryRace.injections.find((entry) => entry.compatibility).pid, 202);
  assert.ok(!moduleQueryRace.sleeps.includes(60000), "a transient module query race must not fall into the 60s fallback");
  assert.match(readFileSync(path.join(moduleQueryRace.stateDir, "bridge.log"), "utf8"), /module query/);
  checks++;
  const compatibilityTimeoutRace = fixture("grover", {
    running: false, modules: [knownModule], compatibilityTimeoutRace: true,
    compatibilityTimeoutRaceFailures: 2
  });
  compatibilityTimeoutRace.scan.protection.flags.push("grover-module-monitor");
  await compatibilityTimeoutRace.launch();
  assert.deepEqual(compatibilityTimeoutRace.injections.filter((entry) => entry.compatibility).map((entry) => entry.pid), [102, 103, 202]);
  checks++;
  for (const never of [false, true]) {
    const game = fixture("grover", { running: false, modules: [knownModule], compatibilityLateMs: 20000, compatibilityNeverReady: never });
    game.scan.protection.flags.push("grover-module-monitor");
    if (never) await assert.rejects(game.launch(), /delayed game bridge did not become ready/);
    else await game.launch();
    assert.equal(game.injections.filter(i => i.compatibility).length, 1);
    if (never) assert.equal(game.injections.length, 1, "timeout does not fall through to another DLL injection");
    checks++;
  }

  const statusPath = path.join(tempRoot, "compat-unit.json");
  const retained = ["C:\\Windows\\System32\\winmm.dll", "C:\\Other\\Sangfor\\SSL\\ClientComponent\\SangforTcp.dll", "C:\\Program Files (x86)\\Sangfor\\SSL\\unknown.dll", "C:\\Tools\\rmch-mvhook.dll"];
  retained.push("D:\\Other\\MacType.dll", "D:\\MacType\\unknown.dll");
  const report = { getReport: () => ({ sharedObjects: [knownModule, "D:\\MacType\\MacType.dll", "D:\\MacType\\MacType.Core.dll", ...retained], header: { unchanged: true } }) };
  vm.runInNewContext(buildGroverCompatibilityBootstrap(statusPath), { window: { SceneManager: { _scene: {} }, document: { hidden: false } }, process: { env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, report }, require: name => name === "fs" ? fs : path });
  assert.deepEqual(report.getReport().sharedObjects, retained, "unknown modules, system DLLs and toolbox DLLs remain visible");
  assert.deepEqual(report.getReport().header, { unchanged: true });
  let delayed;
  let polling;
  const delayedPath = path.join(tempRoot, "delayed-bootstrap.js");
  writeFileSync(delayedPath, "throw Error('delayed failure')");
  vm.runInNewContext(buildGroverCompatibilityBootstrap(statusPath, { delayedBootstrapPath: delayedPath, delayMs: 60000 }), {
    window: { $dataSystem: {}, SceneManager: { _scene: {} }, document: { hidden: false }, eval: code => vm.runInNewContext(code) }, process: { env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, report: { getReport: () => ({ sharedObjects: [knownModule] }) } },
    require: name => name === "fs" ? fs : name === "timers" ? {
      setTimeout: (callback, delay) => { if (delay === 60000) delayed = callback; else assert.ok([1000,5000,15000,30000,45000,55000].includes(delay)); },
      setInterval: callback => { polling = callback; return 1; }, clearInterval: () => {}
    } : path,
    nw: { Window: { getAll: callback => callback([{ window: { SceneManager: { _scene: {} }, document: { hidden: true }, location: { href: 'file:///www/index.html' } }, show: () => {}, restore: () => {}, focus: () => {}, eval: (_frame, code) => vm.runInNewContext(code) }]) } }
  });
  assert.equal(JSON.parse(readFileSync(statusPath, "utf8")).status, "applied", "full bridge is not evaluated early");
  delayed();
  if (polling) polling();
  assert.match(JSON.parse(readFileSync(statusPath, "utf8")).error, /delayed failure/);
  for (const mode of ["captured", "fallback", "unready", "no-callback", "logs-fail"]) {
    let now = 0, sequence = 0;
    const scheduled = new Map();
    const schedule = (callback, delay, repeat = false) => {
      const id = ++sequence;
      scheduled.set(id, { id, callback, at: now + delay, repeat: repeat ? delay : 0 });
      return id;
    };
    const timers = {
      setTimeout: (callback, delay) => schedule(callback, delay),
      setInterval: (callback, delay) => schedule(callback, delay, true),
      clearInterval: id => scheduled.delete(id)
    };
    const makeWindow = ready => {
      const value = { closed: false, $dataSystem: {}, SceneManager: { _scene: ready ? {} : null }, document: { hidden: true }, location: { href: "file:///www/index.html" }, Graphics: { frameCount: 30 } };
      value.eval = code => vm.runInNewContext(code, { window: value });
      return value;
    };
    const captured = makeWindow(["captured", "logs-fail"].includes(mode));
    captured.closed = mode === "fallback";
    const fallback = makeWindow(mode === "fallback");
    const report = { getReport: () => { throw Error("must not eagerly generate a report in the startup window"); } };
    const diagnosticPath = path.join(tempRoot, "realm-" + mode + ".json");
    const sourcePath = path.join(tempRoot, "realm-" + mode + ".js");
    writeFileSync(sourcePath, "window.delivered=(window.delivered||0)+1");
    vm.runInNewContext(buildGroverCompatibilityBootstrap(diagnosticPath, {
      delayMs: 5000, matchedModules: [knownModule], delayedBootstrapPath: sourcePath
    }), {
      window: captured, Date: { now: () => now },
      process: { env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" }, report },
      require: name => name === "fs" ? mode === "logs-fail" ? {...fs,writeFileSync(){throw Error("disk logging unavailable")},appendFileSync(){throw Error("disk logging unavailable")}} : fs : name === "timers" ? timers : path,
      nw: { Window: { getAll: callback => { if (mode !== "no-callback") callback([{ window: fallback, show() {}, restore() {}, focus() {}, eval: (_frame, code) => fallback.eval(code) }]); } } }
    });
    for (let count = 0; scheduled.size && count < 500; count++) {
      const next = [...scheduled.values()].sort((a, b) => a.at - b.at)[0];
      if (next.at > 80000) break;
      now = next.at;
      if (next.repeat) next.at += next.repeat; else scheduled.delete(next.id);
      next.callback();
    }
    assert.equal(captured.delivered || 0, ["captured", "logs-fail"].includes(mode) ? 1 : 0);
    assert.equal(fallback.delivered || 0, mode === "fallback" ? 1 : 0);
    if (["unready", "no-callback"].includes(mode)) assert.match(JSON.parse(readFileSync(diagnosticPath, "utf8")).error, /game window became ready/);
    checks++;
  }
  const jsDir = path.join(tempRoot, "fingerprint-js");
  mkdirSync(path.join(jsDir, "plugins"), { recursive: true });
  assert.equal(hasGroverModuleMonitor(jsDir), false);
  writeFileSync(path.join(jsDir, "plugins", "TH-QianC.js"), "modulesMmt sharedObjects");
  assert.equal(hasGroverModuleMonitor(jsDir), false);
  appendFileSync(path.join(jsDir, "plugins", "TH-QianC.js"), " Suspect Module =>");
  assert.equal(hasGroverModuleMonitor(jsDir), true);
  checks++;

  console.log("test-nw-attachment: " + checks + " production flow cases passed");
} finally {
  if (previousProgramFiles === undefined) delete process.env["ProgramFiles(x86)"];
  else process.env["ProgramFiles(x86)"] = previousProgramFiles;
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
}
