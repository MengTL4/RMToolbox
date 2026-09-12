#!/usr/bin/env node
// Unit tests for core/attach.mjs — no running game or built DLLs required:
//   1. readPeArch against synthetic PE headers (and the committed hook DLLs,
//      when present);
//   2. buildNwBootstrap content and syntax (the string is what gets eval'd
//      inside the game, so a parse error here would only surface in-game);
//   3. the u32-LE pipe frame protocol (frameReader/writeFrame) over a real
//      named-pipe loopback, including split writes and back-to-back frames.
//
//   node tools/test-attach.mjs

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AttachError,
  buildNwBootstrap,
  createNwAttachment,
  frameReader,
  oepLaunchEligible,
  readPeArch,
  tryOepLaunch,
  writeFrame
} from "../core/attach.mjs";
import { buildBridge } from "../core/bridge-bundler.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
let checks = 0;
function check(name, cond, extra = "") {
  checks++;
  if (cond) {
    console.log(`  ok ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${extra ? " — " + extra : ""}`);
  }
}

// --- readPeArch ----------------------------------------------------------------

function writeSyntheticPe(dir, name, machine) {
  const buf = Buffer.alloc(0x100);
  buf.write("MZ", 0, "latin1");
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew
  buf.write("PE\0\0", 0x80, "latin1");
  buf.writeUInt16LE(machine, 0x84);
  const p = path.join(dir, name);
  writeFileSync(p, buf);
  return p;
}

function testPeArch() {
  console.log("readPeArch:");
  const dir = mkdtempSync(path.join(os.tmpdir(), "rmch-pe-"));
  try {
    check(
      "i386 -> win32",
      readPeArch(writeSyntheticPe(dir, "x86.exe", 0x14c)) === "win32"
    );
    check(
      "amd64 -> x64",
      readPeArch(writeSyntheticPe(dir, "x64.exe", 0x8664)) === "x64"
    );

    const notPe = path.join(dir, "plain.bin");
    writeFileSync(notPe, Buffer.from("not a pe at all, just text"));
    let threw = null;
    try {
      readPeArch(notPe);
    } catch (e) {
      threw = e;
    }
    check(
      "non-PE throws AttachError",
      threw instanceof AttachError,
      String(threw)
    );

    let threwUnknown = null;
    try {
      readPeArch(writeSyntheticPe(dir, "arm.exe", 0x1c0));
    } catch (e) {
      threwUnknown = e;
    }
    check(
      "unknown machine throws AttachError",
      threwUnknown instanceof AttachError,
      String(threwUnknown)
    );

    // Cross-check against the committed prebuilt hook DLLs when they exist.
    for (const [arch, file] of [
      ["win32", "rmch-mvhook.dll"],
      ["x64", "rmch-mvhook.dll"]
    ]) {
      const dll = path.join(root, "runtime", "inject", "bin", arch, file);
      if (existsSync(dll)) {
        check(
          `real ${arch}/${file}`,
          readPeArch(dll) === arch,
          readPeArch(dll)
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- buildNwBootstrap ----------------------------------------------------------

function testBootstrap() {
  console.log("buildNwBootstrap:");
  buildBridge(root); // bootstrap embeds runtime/bridge/page-bridge.js
  const boot = buildNwBootstrap({
    gameRoot: "D:\\Games\\Foo",
    projectRoot: root,
    gameKey: "foo-key",
    port: 47412,
    token: "tok-123"
  });
  check(
    "embeds game root env",
    boot.includes('"RMCH_GAME_ROOT":"D:\\\\Games\\\\Foo"')
  );
  check("embeds ws port", boot.includes('"RMCH_WS_PORT":"47412"'));
  check("embeds ws token", boot.includes('"RMCH_WS_TOKEN":"tok-123"'));
  check(
    "embeds bridge source",
    boot.includes("page-bridge") || boot.includes("RMCH")
  );
  check("idempotence guard", boot.includes("window.__rmchBridge"));
  check(
    "non-game contexts throw for re-arm",
    boot.includes("rmch-not-game-page")
  );
  check("error log under bridge-state", boot.includes("attach-error.log"));
  let parseError = null;
  try {
    // Parse-only: the bootstrap references window/process, so it cannot run
    // here — but a syntax error must be caught before it ever reaches a game.
    new Function(boot);
  } catch (e) {
    parseError = e;
  }
  check("bootstrap parses as JS", parseError === null, String(parseError));

  // bootTap/dance variant: holding-tap prelude, no-throw canvas poll, and the
  // throw-on-bridge guard that keeps a pre-armed dance DLL alive across the
  // reload it straddles.
  const dance = buildNwBootstrap({
    gameRoot: "D:\\Games\\Foo",
    projectRoot: root,
    gameKey: "foo-key",
    port: 47412,
    token: "tok-123",
    extraEnv: { RMCH_BOOT_TAP: "1", RMCH_THROW_IF_BRIDGED: "1" }
  });
  check("bootTap installs holding tap", dance.includes("__rmchBootParsed"));
  check("bootTap arms a canvas poll", dance.includes("return 'armed';"));
  check(
    "dance copy throws on live bridge",
    dance.includes(
      "if (window.__rmchBridge) throw new Error('rmch-not-game-page');"
    )
  );
  check(
    "plain bootstrap returns on live bridge",
    boot.includes("if (window.__rmchBridge) return;")
  );
  let danceParseError = null;
  try {
    new Function(dance);
  } catch (e) {
    danceParseError = e;
  }
  check(
    "dance bootstrap parses as JS",
    danceParseError === null,
    String(danceParseError)
  );
}

// --- pipe framing loopback -----------------------------------------------------

function rawFrame(text) {
  const payload = Buffer.from(text, "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(payload.length, 0);
  return Buffer.concat([hdr, payload]);
}

async function testFraming() {
  console.log("pipe framing:");
  const pipeName = `\\\\.\\pipe\\rmch-test-attach-${process.pid}`;
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, resolve);
  });
  try {
    const received = [];
    const serverSockP = new Promise((resolve) => {
      server.on("connection", (sock) => {
        frameReader(sock, (msg) => received.push(msg));
        resolve(sock);
      });
    });
    const client = net.connect(pipeName);
    await new Promise((resolve) => client.on("connect", resolve));
    const serverSock = await serverSockP;

    // Split one frame across three writes (partial header + partial payload),
    // then append a whole second frame — frameReader must reassemble both.
    const f1 = rawFrame(
      JSON.stringify({ t: "ready", dll: "test", uni: "世界" })
    );
    const f2 = rawFrame(JSON.stringify({ t: "result", ok: true, detail: "d" }));
    client.write(f1.subarray(0, 2));
    await new Promise((r) => setTimeout(r, 30));
    client.write(Buffer.concat([f1.subarray(2, 10)]));
    await new Promise((r) => setTimeout(r, 30));
    client.write(Buffer.concat([f1.subarray(10), f2]));

    await new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (received.length >= 2) return resolve();
        if (Date.now() - t0 > 3000)
          return reject(new Error("frames did not arrive"));
        setTimeout(tick, 20);
      };
      tick();
    });
    check(
      "split frame reassembled",
      received[0] && received[0].t === "ready" && received[0].uni === "世界",
      JSON.stringify(received[0])
    );
    check(
      "second frame parsed",
      received[1] && received[1].t === "result" && received[1].ok === true,
      JSON.stringify(received[1])
    );

    // writeFrame -> raw client read: exact one-frame bytes on the wire.
    const chunks = [];
    client.on("data", (d) => chunks.push(d));
    writeFrame(serverSock, JSON.stringify({ hello: "桥" }));
    await new Promise((r) => setTimeout(r, 100));
    const wire = Buffer.concat(chunks);
    check(
      "writeFrame emits u32le+payload",
      wire.equals(rawFrame(JSON.stringify({ hello: "桥" }))),
      wire.toString("hex")
    );

    client.end();
  } finally {
    server.close();
  }
}

// --- OEP launch (入口点注入) ---------------------------------------------------
// The gate is pure. The orchestration runs over a REAL loopback named pipe with
// a fake platform — the test plays mvhook (main + renderer) itself. The
// fallback's far side (attachNw) starts a real bridge server, so it stays at
// the e2e seam (real games); here we assert tryOepLaunch's own outcomes and the
// launchNw integration on the success path.

function oepScan(dir, container) {
  return {
    root: dir,
    gameKey: "oep-测试-" + (container || "std"),
    title: "OEP 测试",
    engine: { id: "MV" },
    paths: { exe: writeSyntheticPe(dir, "Game.exe", 0x8664) },
    container,
    protection: { level: 0, flags: [] }
  };
}

function testOepGate() {
  console.log("oep eligibility:");
  const base = { protection: { level: 0, flags: [] } };
  check(
    "standard nw game is eligible",
    oepLaunchEligible({ ...base }) === true
  );
  check(
    "nwjs container is eligible",
    oepLaunchEligible({ ...base, container: "nwjs" }) === true
  );
  check(
    "enigma-nb is eligible",
    oepLaunchEligible({ ...base, container: "enigma-nb" }) === true
  );
  check(
    "nb-evalnwbin keeps the measured path",
    oepLaunchEligible({ ...base, container: "nb-evalnwbin" }) === false
  );
  check(
    "grover-boot keeps the measured path",
    oepLaunchEligible({
      container: undefined,
      protection: { level: 3, flags: ["grover-boot"] }
    }) === false
  );
}

// A fake mvhook over the real OEP pipe: the main process arms, reports one
// renderer, the renderer asks for the bootstrap and reports the eval result.
function fakeMvhook(
  pipeName,
  { result = { ok: true, detail: "evaled" }, onBootstrap } = {}
) {
  const main = net.connect(pipeName);
  const renderer = net.connect(pipeName);
  main.on("connect", () => {
    writeFrame(
      main,
      JSON.stringify({ t: "ready", dll: "mvhook", mode: "main" })
    );
    writeFrame(main, JSON.stringify({ t: "renderer", pid: 4322, ok: true }));
  });
  renderer.on("connect", () =>
    writeFrame(renderer, JSON.stringify({ t: "ready", dll: "mvhook" }))
  );
  // The core tears the pipe down the moment it has its result — answer exactly
  // once, or a split bootstrap frame would make us write into a dead socket.
  let answered = false;
  renderer.on("data", (d) => {
    if (answered) return;
    answered = true;
    if (onBootstrap) onBootstrap(d);
    writeFrame(renderer, JSON.stringify({ t: "result", ...result }));
    setTimeout(() => {
      main.end();
      renderer.end();
    }, 50);
  });
  return { main, renderer };
}

function oepRuntime(over = {}) {
  const clock = { now: () => 777000, sleep: () => Promise.resolve() };
  const logs = [];
  const platform = {
    listProcessesByExeName: async () => [],
    listProcessModules: async () => [],
    showNwGameWindow: async () => 0,
    clearRunAsAdminFlag: () => {},
    cmdStartSpawn: () => {},
    shellExecuteSpawn: () => {},
    injectAndDeliver: () => Promise.resolve({ ok: false, detail: "unused" }),
    ensureServer: () => Promise.resolve({ running: false, started: false }),
    launchOepInject: () => Promise.resolve({ ok: true, pid: 4321 }),
    ...over
  };
  return {
    clock,
    logs,
    platform,
    log: (m, e) => logs.push(m + (e ? " " + JSON.stringify(e) : ""))
  };
}

async function testOepHappy() {
  console.log("oep launch (ws transport):");
  const dir = mkdtempSync(path.join(os.tmpdir(), "rmch-oep-"));
  try {
    const scan = oepScan(dir, "enigma-nb");
    let bootstrapped = "";
    const { clock, logs, platform, log } = oepRuntime({
      launchOepInject: ({ pipeName }) => {
        setTimeout(
          () =>
            fakeMvhook(pipeName, {
              onBootstrap: (raw) => {
                bootstrapped = raw.toString("utf8");
              }
            }),
          30
        );
        return Promise.resolve({ ok: true, pid: 4321 });
      }
    });
    const result = await tryOepLaunch(
      { scan, projectRoot: root, port: 47499 },
      { platform, clock },
      log
    );
    check("oep launch ok", result.ok === true, JSON.stringify(result));
    check("oep game pid from injector", result.gamePid === 4321);
    check(
      "bootstrap delivered to the renderer",
      bootstrapped.includes(scan.gameKey),
      bootstrapped.slice(0, 120)
    );
    check(
      "main-process arming logged",
      logs.some((l) => l.includes("armed")),
      logs.join(" | ")
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function testOepFailures() {
  console.log("oep failure paths:");
  // Injector never spawned the game: no gamePid, caller respawns from scratch.
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rmch-oep-"));
    try {
      const scan = oepScan(dir, "enigma-nb");
      const { clock, platform, log } = oepRuntime({
        launchOepInject: () =>
          Promise.resolve({ ok: false, detail: "injector-exit-2: simulated" })
      });
      const result = await tryOepLaunch(
        { scan, projectRoot: root, port: 47498 },
        { platform, clock },
        log
      );
      check("injector failure surfaces detail", result.ok === false);
      check(
        "no game pid on injector failure",
        !result.gamePid,
        JSON.stringify(result)
      );
      check(
        "detail is diagnosable",
        String(result.detail).includes("injector-exit-2"),
        String(result.detail)
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Game spawned but the renderer eval failed: gamePid present so the caller
  // attaches to the running game instead of respawning.
  {
    const dir = mkdtempSync(path.join(os.tmpdir(), "rmch-oep-"));
    try {
      const scan = oepScan(dir, "enigma-nb");
      const { clock, platform, log } = oepRuntime({
        launchOepInject: ({ pipeName }) => {
          setTimeout(
            () =>
              fakeMvhook(pipeName, {
                result: { ok: false, detail: "compile-failed" }
              }),
            30
          );
          return Promise.resolve({ ok: true, pid: 4321 });
        }
      });
      const result = await tryOepLaunch(
        { scan, projectRoot: root, port: 47497 },
        { platform, clock },
        log
      );
      check("renderer failure surfaces", result.ok === false);
      check("game pid kept for the attach fallback", result.gamePid === 4321);
      check(
        "renderer detail is diagnosable",
        String(result.detail).includes("compile-failed"),
        String(result.detail)
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// Standard (shell-free) games use the file transport under the launched policy:
// the bridge hello lands on the JSONL channel after the eval.
async function testOepFileChannel() {
  console.log("oep launch (file transport):");
  const dir = mkdtempSync(path.join(os.tmpdir(), "rmch-oep-"));
  const stateDir = path.join(root, "runtime", "bridge-state", "oep-测试-std");
  try {
    const scan = oepScan(dir, undefined);
    const { clock, platform, log } = oepRuntime({
      launchOepInject: ({ pipeName }) => {
        setTimeout(
          () =>
            fakeMvhook(pipeName, {
              onBootstrap: () => {
                // The bridge announcing itself on the file channel.
                writeFileSync(path.join(stateDir, "state.json"), "{}");
                writeFileSync(
                  path.join(stateDir, "events.jsonl"),
                  JSON.stringify({ t: "hello", ts: 1 }) + "\n"
                );
              }
            }),
          30
        );
        return Promise.resolve({ ok: true, pid: 4321 });
      }
    });
    const result = await tryOepLaunch(
      { scan, projectRoot: root, port: 47496 },
      { platform, clock },
      log
    );
    check(
      "file-transport oep launch ok",
      result.ok === true,
      JSON.stringify(result)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// A quiet (spare) renderer must not fail the launch: the core keeps waiting
// and the NEXT renderer gets the bootstrap — measured on a real MV game whose
// first --type=renderer child idled for two minutes without a V8 call.
async function testOepQuietRenderer() {
  console.log("oep quiet renderer keeps the launch waiting:");
  const dir = mkdtempSync(path.join(os.tmpdir(), "rmch-oep-"));
  try {
    const scan = oepScan(dir, "enigma-nb");
    const { clock, platform, log } = oepRuntime({
      launchOepInject: ({ pipeName }) => {
        setTimeout(() => {
          // First child: the idle spare — reports the quiet-timeout result.
          fakeMvhook(pipeName, {
            result: { ok: false, detail: "timeout-no-v8-call" }
          });
          // Second child moments later: the real game page.
          setTimeout(() => fakeMvhook(pipeName), 60);
        }, 30);
        return Promise.resolve({ ok: true, pid: 4321 });
      }
    });
    const result = await tryOepLaunch(
      { scan, projectRoot: root, port: 47494 },
      { platform, clock },
      log
    );
    check(
      "quiet renderer does not fail the launch",
      result.ok === true,
      JSON.stringify(result)
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The launchNw integration: an eligible scan returns the OEP strategy.
async function testOepViaLaunch() {
  console.log("oep via launchNw:");
  const dir = mkdtempSync(path.join(os.tmpdir(), "rmch-oep-"));
  try {
    const scan = oepScan(dir, "enigma-nb");
    const clock = { now: () => 555000, sleep: () => Promise.resolve() };
    const { platform } = oepRuntime({
      launchOepInject: ({ pipeName }) => {
        setTimeout(() => fakeMvhook(pipeName), 30);
        return Promise.resolve({ ok: true, pid: 4321 });
      }
    });
    const attachment = createNwAttachment({ platform, clock });
    const summary = await attachment.launch({
      scan,
      projectRoot: root,
      port: 47495
    });
    check(
      "launch route reports nw-launch-oep",
      summary.strategy === "nw-launch-oep",
      JSON.stringify({ strategy: summary.strategy })
    );
    check("launch pid from injector", summary.pid === 4321);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

testPeArch();
testBootstrap();
await testFraming();
testOepGate();
await testOepHappy();
await testOepFailures();
await testOepQuietRenderer();
await testOepFileChannel();
await testOepViaLaunch();

console.log(`test-attach: ${checks - failures}/${checks} checks ok`);
process.exit(failures ? 1 : 0);
