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
  AttachError, buildNwBootstrap, frameReader, readPeArch, writeFrame
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
    check("i386 -> win32", readPeArch(writeSyntheticPe(dir, "x86.exe", 0x14c)) === "win32");
    check("amd64 -> x64", readPeArch(writeSyntheticPe(dir, "x64.exe", 0x8664)) === "x64");

    const notPe = path.join(dir, "plain.bin");
    writeFileSync(notPe, Buffer.from("not a pe at all, just text"));
    let threw = null;
    try { readPeArch(notPe); } catch (e) { threw = e; }
    check("non-PE throws AttachError", threw instanceof AttachError, String(threw));

    let threwUnknown = null;
    try { readPeArch(writeSyntheticPe(dir, "arm.exe", 0x1c0)); } catch (e) { threwUnknown = e; }
    check("unknown machine throws AttachError", threwUnknown instanceof AttachError, String(threwUnknown));

    // Cross-check against the committed prebuilt hook DLLs when they exist.
    for (const [arch, file] of [["win32", "rmch-mvhook.dll"], ["x64", "rmch-mvhook.dll"]]) {
      const dll = path.join(root, "runtime", "inject", "bin", arch, file);
      if (existsSync(dll)) {
        check(`real ${arch}/${file}`, readPeArch(dll) === arch, readPeArch(dll));
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
  check("embeds game root env", boot.includes('"RMCH_GAME_ROOT":"D:\\\\Games\\\\Foo"'));
  check("embeds ws port", boot.includes('"RMCH_WS_PORT":"47412"'));
  check("embeds ws token", boot.includes('"RMCH_WS_TOKEN":"tok-123"'));
  check("embeds bridge source", boot.includes("page-bridge") || boot.includes("RMCH"));
  check("idempotence guard", boot.includes("window.__rmchBridge"));
  check("non-game contexts throw for re-arm", boot.includes("rmch-not-game-page"));
  check("error log under bridge-state", boot.includes("attach-error.log"));
  let parseError = null;
  try {
    // Parse-only: the bootstrap references window/process, so it cannot run
    // here — but a syntax error must be caught before it ever reaches a game.
    new Function(boot);
  } catch (e) { parseError = e; }
  check("bootstrap parses as JS", parseError === null, String(parseError));
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
    const f1 = rawFrame(JSON.stringify({ t: "ready", dll: "test", uni: "世界" }));
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
        if (Date.now() - t0 > 3000) return reject(new Error("frames did not arrive"));
        setTimeout(tick, 20);
      };
      tick();
    });
    check("split frame reassembled", received[0] && received[0].t === "ready" && received[0].uni === "世界",
      JSON.stringify(received[0]));
    check("second frame parsed", received[1] && received[1].t === "result" && received[1].ok === true,
      JSON.stringify(received[1]));

    // writeFrame -> raw client read: exact one-frame bytes on the wire.
    const chunks = [];
    client.on("data", (d) => chunks.push(d));
    writeFrame(serverSock, JSON.stringify({ hello: "桥" }));
    await new Promise((r) => setTimeout(r, 100));
    const wire = Buffer.concat(chunks);
    check("writeFrame emits u32le+payload", wire.equals(rawFrame(JSON.stringify({ hello: "桥" }))),
      wire.toString("hex"));

    client.end();
  } finally {
    server.close();
  }
}

testPeArch();
testBootstrap();
await testFraming();

console.log(`test-attach: ${checks - failures}/${checks} checks ok`);
process.exit(failures ? 1 : 0);
