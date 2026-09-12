#!/usr/bin/env node
// Injection self-test: verifies rmch-inject.exe (CRT + WH modes) and the pipe
// frame protocol against a local test target process, for every arch with
// built binaries under runtime/inject/bin/<arch>/test/.
//
//   node tools/test-inject-selftest.mjs
//
// Skips arches whose binaries are missing (e.g. no toolchain on the machine).
// Included in `npm test`; the committed prebuilt binaries keep it runnable
// without a compiler.

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binRoot = path.join(root, "runtime", "inject", "bin");

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

function startTarget(targetExe) {
  const child = spawn(targetExe, ["--hidden"], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("target did not print pid")),
      5000
    );
    child.stdout.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/pid (\d+)/);
      if (m && buf.includes("ready")) {
        clearTimeout(timer);
        resolve({ child, pid: Number(m[1]) });
      }
    });
    child.on("exit", () => {
      clearTimeout(timer);
      reject(new Error("target exited early"));
    });
  });
}

function pipeServerForPid(pid) {
  const name = `\\\\.\\pipe\\rmch-attach-${pid}`;
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, () => resolve(server));
  });
}

// Reads frames (u32 LE length + payload) from a socket; calls onMsg(parsedJson).
function frameReader(sock, onMsg) {
  let buf = Buffer.alloc(0);
  sock.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onMsg(JSON.parse(payload.toString("utf8")));
    }
  });
}

function writeFrame(sock, text) {
  const payload = Buffer.from(text, "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(payload.length, 0);
  sock.write(Buffer.concat([hdr, payload]));
}

function waitFor(fn, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() - t0 > timeoutMs)
        return reject(new Error("timeout waiting for " + what));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function testCrt(archDir) {
  const targetExe = path.join(archDir, "test", "test-target.exe");
  const echoDll = path.join(archDir, "test", "rmch-test-echo.dll");
  const injector = path.join(archDir, "rmch-inject.exe");
  const { child, pid } = await startTarget(targetExe);
  try {
    const server = await pipeServerForPid(pid);
    let ready = null;
    let result = null;
    server.on("connection", (sock) => {
      frameReader(sock, (msg) => {
        if (msg.t === "ready") {
          ready = { msg, sock };
        }
        if (msg.t === "result") result = msg;
      });
    });
    const inj = spawn(
      injector,
      ["--crt", "--pid", String(pid), "--dll", echoDll],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const injErr = [];
    inj.stderr.on("data", (d) => injErr.push(d.toString()));
    const injCode = await new Promise((r) => inj.on("exit", r));
    check(
      "crt injector exit 0",
      injCode === 0,
      `code=${injCode} ${injErr.join("")}`
    );

    const r = await waitFor(() => ready, 5000, "ready frame");
    check(
      "crt ready dll field",
      r.msg.dll === "test-echo",
      JSON.stringify(r.msg)
    );
    writeFrame(r.sock, 'hello-rmch-世界 "quoted"');
    const res = await waitFor(() => result, 5000, "result frame");
    check("crt echo ok", res.ok === true, JSON.stringify(res));
    check(
      "crt echo payload uppercased (utf8 kept)",
      res.detail === 'echo:HELLO-RMCH-世界 "QUOTED"',
      res.detail
    );
    server.close();
  } finally {
    child.kill();
  }
}

async function testWh(archDir) {
  const targetExe = path.join(archDir, "test", "test-target.exe");
  const echoDll = path.join(archDir, "test", "rmch-test-echo.dll");
  const injector = path.join(archDir, "rmch-inject.exe");
  const { child, pid } = await startTarget(targetExe);
  try {
    const server = await pipeServerForPid(pid);
    let ready = null;
    let result = null;
    server.on("connection", (sock) => {
      frameReader(sock, (msg) => {
        if (msg.t === "ready") ready = { msg, sock };
        if (msg.t === "result") result = msg;
      });
    });
    const inj = spawn(
      injector,
      ["--wh", "--pid", String(pid), "--dll", echoDll],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    const injErr = [];
    inj.stderr.on("data", (d) => injErr.push(d.toString()));
    let armedBuf = "";
    let armed = false;
    inj.stdout.on("data", (d) => {
      armedBuf += d.toString();
      if (armedBuf.includes("armed")) armed = true;
    });
    await waitFor(() => armed, 5000, "armed line");

    const r = await waitFor(() => ready, 8000, "ready frame");
    writeFrame(r.sock, "hook me");
    const res = await waitFor(() => result, 8000, "result frame");
    check("wh echo ok", res.ok === true, JSON.stringify(res));
    check("wh hook proc fired in target", res.hook === 1, JSON.stringify(res));

    inj.stdin.write("done\n");
    const injCode = await new Promise((r2) => inj.on("exit", r2));
    check(
      "wh injector clean exit",
      injCode === 0,
      `code=${injCode} ${injErr.join("")}`
    );
    server.close();
  } finally {
    child.kill();
  }
}

// OEP mode: launch the target suspended with the echo DLL at its entry point.
// Proves the two properties 入口点注入 exists for: the injector reports the
// pid, and the DLL's DllMain ran BEFORE the target's own main().
async function testOep(archDir) {
  const targetExe = path.join(archDir, "test", "test-target.exe");
  const echoDll = path.join(archDir, "test", "rmch-test-echo.dll");
  const injector = path.join(archDir, "rmch-inject.exe");
  const inj = spawn(
    injector,
    [
      "--oep",
      "--exe",
      targetExe,
      "--dll",
      echoDll,
      "--inherit-stdio",
      "--",
      "--hidden"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  let out = "";
  let err = "";
  inj.stdout.on("data", (d) => (out += d.toString()));
  inj.stderr.on("data", (d) => (err += d.toString()));
  let pid = 0;
  try {
    pid = await waitFor(
      () => {
        const m = out.match(/ok pid (\d+)/);
        return m ? Number(m[1]) : 0;
      },
      10000,
      "oep ok pid"
    );
    check("oep injector reports pid", pid > 0, out + err);

    // The target's own main() reports whether the DLL beat it (see
    // test-target.cpp / test-echo.cpp: the DLL creates the event in DllMain).
    const premain = await waitFor(
      () => {
        const m = out.match(/dll-premain (\d)/);
        return m ? m[1] : null;
      },
      10000,
      "dll-premain line"
    );
    check("oep dll ran before target main", premain === "1", out.trim());

    // The DLL's worker still honours the per-pid pipe handshake from here.
    const server = await pipeServerForPid(pid);
    let ready = null;
    let result = null;
    server.on("connection", (sock) => {
      frameReader(sock, (msg) => {
        if (msg.t === "ready") ready = { msg, sock };
        if (msg.t === "result") result = msg;
      });
    });
    const r = await waitFor(() => ready, 8000, "oep ready frame");
    writeFrame(r.sock, "oep hello");
    const res = await waitFor(() => result, 8000, "oep result frame");
    check("oep echo ok", res.ok === true, JSON.stringify(res));
    check("oep echo payload", res.detail === "echo:OEP HELLO", res.detail);
    server.close();
  } finally {
    if (pid)
      spawn("taskkill", ["/PID", String(pid), "/F"], { stdio: "ignore" });
    // The injector exits as soon as the game is resumed; give it a beat.
    await new Promise((resolve) => {
      if (inj.exitCode !== null) return resolve();
      inj.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    if (inj.exitCode !== null) {
      check("oep injector exit 0", inj.exitCode === 0, `code=${inj.exitCode}`);
    }
  }
}

const archs = existsSync(binRoot)
  ? readdirSync(binRoot).filter(
      (d) =>
        existsSync(path.join(binRoot, d, "rmch-inject.exe")) &&
        existsSync(path.join(binRoot, d, "test", "test-target.exe"))
    )
  : [];

if (archs.length === 0) {
  console.log(
    "test-inject-selftest: no built binaries, SKIP (run node tools/build-inject.mjs)"
  );
  process.exit(0);
}

for (const arch of archs) {
  const archDir = path.join(binRoot, arch);
  console.log(`arch ${arch}:`);
  try {
    await testCrt(archDir);
  } catch (e) {
    failures++;
    console.error(`  FAIL crt threw: ${e.message}`);
  }
  try {
    await testWh(archDir);
  } catch (e) {
    failures++;
    console.error(`  FAIL wh threw: ${e.message}`);
  }
  try {
    await testOep(archDir);
  } catch (e) {
    failures++;
    console.error(`  FAIL oep threw: ${e.message}`);
  }
}

console.log(`test-inject-selftest: ${checks - failures}/${checks} checks ok`);
process.exit(failures ? 1 : 0);
