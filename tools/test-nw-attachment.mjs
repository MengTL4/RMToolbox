// Exercise the production NW attachment module without Windows processes.
// Only process effects and time are replaced. Bridge assembly, PE parsing,
// bootstrap rendering and file hello detection use real files.
import assert from "node:assert/strict";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import net from "node:net";
import vm from "node:vm";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AttachError, createNwAttachment } from "../core/attach.mjs";
import {
  buildGroverCompatibilityBootstrap,
  hasGroverModuleMonitor
} from "../core/grover-compat.mjs";

const projectSource = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
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
  for (const name of readdirSync(
    path.join(projectSource, "runtime", "bridge", "src", "parts")
  )) {
    if (name.endsWith(".js")) {
      copyFileSync(
        path.join(projectSource, "runtime", "bridge", "src", "parts", name),
        path.join(parts, name)
      );
    }
  }
  mkdirSync(gameRoot, { recursive: true });
  const exe = path.join(gameRoot, "游戏.exe");
  const pe = Buffer.alloc(256);
  pe.write("MZ", 0, "latin1");
  pe.writeUInt16LE(128, 60);
  pe.write("PE\0\0", 128, "latin1");
  pe.writeUInt16LE(0x14c, 132);
  writeFileSync(exe, pe);
  const scan = {
    root: gameRoot,
    gameKey: "fixture",
    title: "测试游戏",
    paths: { exe },
    engine: { id: "MV/MZ" },
    container: family === "grover" ? "nwjs" : family,
    protection: { flags: family === "grover" ? ["grover-boot"] : [] }
  };
  const stateDir = path.join(
    projectRoot,
    "runtime",
    "bridge-state",
    scan.gameKey
  );
  const commandPath = path.join(stateDir, "commands.jsonl");
  const eventPath = path.join(stateDir, "events.jsonl");
  const statePath = path.join(stateDir, "state.json");
  const processRow = (pid, cmd, executable = exe) => ({
    ProcessId: pid,
    ParentProcessId: 101,
    ExecutablePath: executable,
    CommandLine: cmd
  });
  // Deliberately shuffled, including an unrelated game's renderer.
  const gameProcesses = [
    processRow(103, "--type=renderer --extension-process"),
    processRow(
      201,
      "--type=renderer",
      path.join(root, "游戏-other", "游戏.exe")
    ),
    processRow(104, "--type=gpu-process"),
    processRow(101, ""),
    processRow(102, "--type=renderer")
  ];
  const context = {
    scan,
    projectRoot,
    stateDir,
    commandPath,
    eventPath,
    statePath,
    processRow,
    gameProcesses,
    processes: options.running === false ? [] : gameProcesses,
    now: Date.now(),
    sleeps: [],
    injections: [],
    clearedFlags: [],
    queries: 0,
    bridgeAlive: false
  };
  context.commands = () =>
    existsSync(commandPath)
      ? readFileSync(commandPath, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  context.publishHello = (timestamp = context.now) => {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(statePath, "{}");
    utimesSync(statePath, timestamp / 1000, timestamp / 1000);
    appendFileSync(
      eventPath,
      JSON.stringify({ t: "hello", ts: timestamp, gameKey: scan.gameKey }) +
        "\n"
    );
    context.bridgeAlive = timestamp === context.now;
  };
  const clock = {
    now: () => context.now,
    sleep: async (ms) => {
      context.now += ms;
      context.sleeps.push(ms);
      assert.ok(context.sleeps.length < 2000, "orchestration must terminate");
      if (context.bridgeAlive && existsSync(statePath)) {
        utimesSync(statePath, context.now / 1000, context.now / 1000);
      }
    }
  };
  const platform = {
    listProcessesByExeName: async (name) => {
      assert.equal(name, "游戏.exe");
      context.queries += 1;
      return options.onQuery ? options.onQuery(context) : context.processes;
    },
    clearRunAsAdminFlag: (file) => {
      context.clearedFlags.push(file);
    },
    injectAndDeliver: async (request) => {
      const match = request.bootstrap.match(
        /Object\.assign\(process\.env, (.+)\);/
      );
      assert.ok(match, "use the real rendered bootstrap");
      const env = JSON.parse(match[1]);
      const entry = { ...request, env };
      context.injections.push(entry);
      assert.equal(
        request.arch,
        "win32",
        "read the synthetic PE through production code"
      );
      assert.equal(request.dllName, "rmch-mvhook.dll");
      assert.equal(request.mode, "crt");
      const result = options.onInject
        ? await options.onInject(entry, context)
        : { ok: true, detail: "evaled" };
      if (
        result.ok &&
        env.RMCH_TRANSPORT === "file" &&
        options.announce !== false
      ) {
        context.publishHello();
      }
      return result;
    }
  };
  const module = createNwAttachment({ platform, clock });
  context.attach = () => module.attach({ scan, projectRoot, port });
  return context;
}

try {
  // Transport choices are the attach policy's own: the evalNWBin shell rides
  // the file channel, Enigma-NB retries WS, everything else is a single-shot
  // WS attach. A refactor must not silently unify this matrix.
  for (const family of ["nb-evalnwbin", "enigma-nb", "grover"]) {
    const game = fixture(family);
    const result = await game.attach();
    const file = family === "nb-evalnwbin";
    const sealed = file || family === "enigma-nb";
    const first = game.injections[0];
    assert.equal(first.env.RMCH_TRANSPORT, file ? "file" : undefined);
    assert.equal(first.env.RMCH_SEALED, sealed ? "1" : undefined);
    assert.equal(
      first.env.RMCH_SELF_SEED,
      family === "nb-evalnwbin" ? "1" : undefined,
      "Enigma publishes native globals after login; heap publication is only needed for sealed evalNWBin"
    );
    assert.equal(first.timeoutMs, 30000);
    assert.equal(result.strategy, file ? "nw-inject-file" : "nw-inject");
    assert.equal(result.pid, 101);
    assert.deepEqual(
      result.injected,
      [102],
      "stop after the first successful renderer"
    );
    assert.equal(result.port, file ? null : port);
    assert.equal(game.commands().length, 0);
    assert.equal(
      game.sleeps.length,
      0,
      "a settled existing instance needs no startup wait"
    );
    checks += 1;
  }

  for (const family of ["nwjs", "nb-evalnwbin"]) {
    const game = fixture(family, {
      onInject: async (entry) => ({ ok: entry.pid === 103, detail: "fixture" })
    });
    game.processes.push(game.processRow(105, "--type=renderer"));
    const result = await game.attach();
    assert.deepEqual(
      game.injections.map((entry) => entry.pid),
      [102, 105, 103]
    );
    assert.deepEqual(result.injected, [103]);
    assert.equal(result.pid, 101);
    checks += 1;
  }

  const single = fixture("nwjs");
  single.processes = [single.processRow(101, "")];
  assert.deepEqual((await single.attach()).injected, [101]);
  checks += 1;

  // Retry budgets and timeouts are exercised through real attachment.
  for (const [family, attempts, timeout] of [
    ["nwjs", 1, 30000],
    ["enigma-nb", 5, 30000]
  ]) {
    const game = fixture(family, {
      onInject: async () => ({ ok: false, detail: "fixture miss" })
    });
    await assert.rejects(game.attach(), /injection failed/);
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

  // A bridge that is already live is re-adopted, never re-injected, and its
  // queued commands survive untouched.
  {
    const game = fixture("nb-evalnwbin");
    game.publishHello();
    writeFileSync(game.commandPath, '{"type":"pending"}\n');
    const previousEvents = readFileSync(game.eventPath, "utf8");
    const result = await game.attach();
    assert.deepEqual(result.injected, []);
    assert.deepEqual(game.injections, []);
    assert.equal(readFileSync(game.eventPath, "utf8"), previousEvents);
    assert.deepEqual(game.commands(), [{ type: "pending" }]);
    checks += 1;
  }

  const raced = fixture("nb-evalnwbin", {
    announce: false,
    onInject: async (_entry, game) => {
      assert.equal(
        existsSync(game.commandPath),
        false,
        "discard stale queued commands"
      );
      assert.equal(existsSync(game.eventPath), false, "discard stale hello");
      game.publishHello();
      return { ok: false, detail: "result pipe raced" };
    }
  });
  raced.processes = [
    raced.processRow(101, ""),
    raced.processRow(102, "--type=renderer")
  ];
  raced.publishHello(raced.now - 6000);
  writeFileSync(raced.commandPath, '{"type":"old"}\n');
  const racedResult = await raced.attach();
  assert.deepEqual(racedResult.injected, []);
  assert.equal(
    racedResult.results[0].ok,
    false,
    "a real fresh hello confirms the otherwise-failed injection"
  );
  assert.equal(raced.injections.length, 1);
  checks += 1;

  // A successful eval still waits for the bridge hello on the file channel —
  // without piling more DLL injections on.
  {
    const game = fixture("nb-evalnwbin", { announce: false });
    await assert.rejects(game.attach(), /within 30s/);
    assert.equal(
      game.injections.length,
      1,
      "successful eval waits for hello without more DLL injections"
    );
    assert.equal(game.commands().length, 0);
    checks += 1;
  }

  // Attaching with no running game fails before any file or token write, and
  // the error teaches the manual-start flow.
  const absent = fixture("nb-evalnwbin", { running: false });
  await assert.rejects(absent.attach(), /no running/);
  await assert.rejects(absent.attach(), /附加到运行中/);
  assert.equal(
    existsSync(path.join(absent.projectRoot, "runtime", "rmch.token")),
    false
  );
  assert.equal(
    existsSync(
      path.join(absent.projectRoot, "runtime", "bridge", "page-bridge.js")
    ),
    false
  );
  assert.equal(existsSync(absent.stateDir), false);
  checks += 1;

  // An elevated (RUNASADMIN) instance is unreadable: fail loudly and clear the
  // flag for next time instead of polling past it forever.
  {
    const game = fixture("nb-evalnwbin");
    game.processes = [{ ProcessId: 101, ExecutablePath: "", CommandLine: "" }];
    await assert.rejects(game.attach(), /管理员/);
    assert.deepEqual(game.clearedFlags, [game.scan.paths.exe]);
    assert.deepEqual(game.injections, []);
    checks += 1;
  }

  const knownModule =
    "C:\\Program Files (x86)\\Sangfor\\SSL\\SangforPWEx\\SangforUDProtectEx_202591913857893.dll";
  const statusPath = path.join(tempRoot, "compat-unit.json");
  const retained = [
    "C:\\Windows\\System32\\winmm.dll",
    "C:\\Other\\Sangfor\\SSL\\ClientComponent\\SangforTcp.dll",
    "C:\\Program Files (x86)\\Sangfor\\SSL\\unknown.dll",
    "C:\\Tools\\rmch-mvhook.dll"
  ];
  retained.push("D:\\Other\\MacType.dll", "D:\\MacType\\unknown.dll");
  const report = {
    getReport: () => ({
      sharedObjects: [
        knownModule,
        "D:\\MacType\\MacType.dll",
        "D:\\MacType\\MacType.Core.dll",
        ...retained
      ],
      header: { unchanged: true }
    })
  };
  vm.runInNewContext(buildGroverCompatibilityBootstrap(statusPath), {
    window: { SceneManager: { _scene: {} }, document: { hidden: false } },
    process: {
      env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
      report
    },
    require: (name) => (name === "fs" ? fs : path)
  });
  assert.deepEqual(
    report.getReport().sharedObjects,
    retained,
    "unknown modules, system DLLs and toolbox DLLs remain visible"
  );
  assert.deepEqual(report.getReport().header, { unchanged: true });
  let delayed;
  let polling;
  const delayedPath = path.join(tempRoot, "delayed-bootstrap.js");
  writeFileSync(delayedPath, "throw Error('delayed failure')");
  vm.runInNewContext(
    buildGroverCompatibilityBootstrap(statusPath, {
      delayedBootstrapPath: delayedPath,
      delayMs: 60000
    }),
    {
      window: {
        $dataSystem: {},
        SceneManager: { _scene: {} },
        document: { hidden: false },
        eval: (code) => vm.runInNewContext(code)
      },
      process: {
        env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
        report: { getReport: () => ({ sharedObjects: [knownModule] }) }
      },
      require: (name) =>
        name === "fs"
          ? fs
          : name === "timers"
            ? {
                setTimeout: (callback, delay) => {
                  if (delay === 60000) delayed = callback;
                  else
                    assert.ok(
                      [1000, 5000, 15000, 30000, 45000, 55000].includes(delay)
                    );
                },
                setInterval: (callback) => {
                  polling = callback;
                  return 1;
                },
                clearInterval: () => {}
              }
            : path,
      nw: {
        Window: {
          getAll: (callback) =>
            callback([
              {
                window: {
                  SceneManager: { _scene: {} },
                  document: { hidden: true },
                  location: { href: "file:///www/index.html" }
                },
                show: () => {},
                restore: () => {},
                focus: () => {},
                eval: (_frame, code) => vm.runInNewContext(code)
              }
            ])
        }
      }
    }
  );
  assert.equal(
    JSON.parse(readFileSync(statusPath, "utf8")).status,
    "applied",
    "full bridge is not evaluated early"
  );
  delayed();
  if (polling) polling();
  assert.match(
    JSON.parse(readFileSync(statusPath, "utf8")).error,
    /delayed failure/
  );
  for (const mode of [
    "captured",
    "fallback",
    "unready",
    "no-callback",
    "logs-fail"
  ]) {
    let now = 0,
      sequence = 0;
    const scheduled = new Map();
    const schedule = (callback, delay, repeat = false) => {
      const id = ++sequence;
      scheduled.set(id, {
        id,
        callback,
        at: now + delay,
        repeat: repeat ? delay : 0
      });
      return id;
    };
    const timers = {
      setTimeout: (callback, delay) => schedule(callback, delay),
      setInterval: (callback, delay) => schedule(callback, delay, true),
      clearInterval: (id) => scheduled.delete(id)
    };
    const makeWindow = (ready) => {
      const value = {
        closed: false,
        $dataSystem: {},
        SceneManager: { _scene: ready ? {} : null },
        document: { hidden: true },
        location: { href: "file:///www/index.html" },
        Graphics: { frameCount: 30 }
      };
      value.eval = (code) => vm.runInNewContext(code, { window: value });
      return value;
    };
    const captured = makeWindow(["captured", "logs-fail"].includes(mode));
    captured.closed = mode === "fallback";
    const fallback = makeWindow(mode === "fallback");
    const report = {
      getReport: () => {
        throw Error("must not eagerly generate a report in the startup window");
      }
    };
    const diagnosticPath = path.join(tempRoot, "realm-" + mode + ".json");
    const sourcePath = path.join(tempRoot, "realm-" + mode + ".js");
    writeFileSync(sourcePath, "window.delivered=(window.delivered||0)+1");
    vm.runInNewContext(
      buildGroverCompatibilityBootstrap(diagnosticPath, {
        delayMs: 5000,
        matchedModules: [knownModule],
        delayedBootstrapPath: sourcePath
      }),
      {
        window: captured,
        Date: { now: () => now },
        process: {
          env: { "ProgramFiles(x86)": "C:\\Program Files (x86)" },
          report
        },
        require: (name) =>
          name === "fs"
            ? mode === "logs-fail"
              ? {
                  ...fs,
                  writeFileSync() {
                    throw Error("disk logging unavailable");
                  },
                  appendFileSync() {
                    throw Error("disk logging unavailable");
                  }
                }
              : fs
            : name === "timers"
              ? timers
              : path,
        nw: {
          Window: {
            getAll: (callback) => {
              if (mode !== "no-callback")
                callback([
                  {
                    window: fallback,
                    show() {},
                    restore() {},
                    focus() {},
                    eval: (_frame, code) => fallback.eval(code)
                  }
                ]);
            }
          }
        }
      }
    );
    for (let count = 0; scheduled.size && count < 500; count++) {
      const next = [...scheduled.values()].sort((a, b) => a.at - b.at)[0];
      if (next.at > 80000) break;
      now = next.at;
      if (next.repeat) next.at += next.repeat;
      else scheduled.delete(next.id);
      next.callback();
    }
    assert.equal(
      captured.delivered || 0,
      ["captured", "logs-fail"].includes(mode) ? 1 : 0
    );
    assert.equal(fallback.delivered || 0, mode === "fallback" ? 1 : 0);
    if (["unready", "no-callback"].includes(mode))
      assert.match(
        JSON.parse(readFileSync(diagnosticPath, "utf8")).error,
        /game window became ready/
      );
    checks++;
  }
  const jsDir = path.join(tempRoot, "fingerprint-js");
  mkdirSync(path.join(jsDir, "plugins"), { recursive: true });
  assert.equal(hasGroverModuleMonitor(jsDir), false);
  writeFileSync(
    path.join(jsDir, "plugins", "TH-QianC.js"),
    "modulesMmt sharedObjects"
  );
  assert.equal(hasGroverModuleMonitor(jsDir), false);
  appendFileSync(
    path.join(jsDir, "plugins", "TH-QianC.js"),
    " Suspect Module =>"
  );
  assert.equal(hasGroverModuleMonitor(jsDir), true);
  checks++;

  console.log(
    "test-nw-attachment: " + checks + " production flow cases passed"
  );
} finally {
  if (previousProgramFiles === undefined)
    delete process.env["ProgramFiles(x86)"];
  else process.env["ProgramFiles(x86)"] = previousProgramFiles;
  await new Promise((resolve) => server.close(resolve));
  rmSync(tempRoot, { recursive: true, force: true });
}
