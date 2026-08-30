// Tauri-CDP unit test: the pure/half-pure pieces of core/tauri-cdp.mjs plus
// scanner detection. No real game, no WebView2 — a synthetic "exe" buffer
// stands in for the 150MB Tauri binary (the patch logic only ever touches a
// byte range, so a 4KB fixture proves the same things).
//
//   - probeTauriShell finds markers + patch anchor, and refuses non-Tauri exes
//   - buildPatchReplacement keeps byte length exactly and rejects overflows
//   - buildPatchedExe patches the copy, never the source, and verifies anchors
//   - scanGame labels the layout (lowercase game.exe + arc_* dirs + Tauri
//     markers) as container "tauri" instead of "unknown-nwjs"

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  probeTauriShell,
  buildPatchReplacement,
  buildPatchedExe,
  TauriLaunchError
} from "../core/tauri-cdp.mjs";
import { scanGame, injectionStrategy } from "../core/scanner.mjs";

const ANCHOR = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

// A stand-in Tauri binary: MZ header, NUL padding, the WRY args string as a
// NUL-bounded printable region, the tauri.localhost marker, trailing filler.
function makeFakeTauriExe(file) {
  const head = Buffer.from("MZ" + "\0".repeat(256), "latin1");
  const argsString = `${ANCHOR} --autoplay-policy=no-user-gesture-required --proxy-server=http:// --proxy-server=socks5://`;
  const argsRegion = Buffer.from(`\0\0\0${argsString}\0`, "latin1");
  const marker = Buffer.from("...https://tauri.localhost/...", "latin1");
  writeFileSync(file, Buffer.concat([head, argsRegion, marker]));
  return { offset: head.length + 3, length: argsString.length }; // the args string region
}

function main() {
  const tempRoot = mkdtempSync(path.join(tmpdir(), "rmch-tauri-test-"));
  try {
    // --- probe + patch -------------------------------------------------------
    const exe = path.join(tempRoot, "game.exe");
    const region = makeFakeTauriExe(exe);

    const probe = probeTauriShell(exe);
    assert.equal(probe.isTauri, true, "fake exe should probe as Tauri");
    assert.ok(probe.anchor, "anchor should be found");
    // The anchor is the WHOLE args string region, not one token — the whole
    // thing gets replaced (WRY caps the re-joined args, so no original token
    // may survive next to ours).
    assert.equal(probe.anchor.offset, region.offset);
    assert.equal(probe.anchor.length, region.length);

    const plain = path.join(tempRoot, "plain.exe");
    writeFileSync(plain, "MZ just some game binary without markers");
    assert.equal(probeTauriShell(plain).isTauri, false, "plain exe must not probe as Tauri");

    const replacement = buildPatchReplacement(region.length, 9333);
    assert.equal(replacement.length, region.length, "replacement must be byte-exact");
    assert.ok(replacement.startsWith("--remote-debugging-port=9333 "));
    assert.throws(() => buildPatchReplacement(10, 9333), TauriLaunchError);

    const dest = path.join(tempRoot, "game.rmch-cdp.exe");
    const before = readFileSync(exe);
    buildPatchedExe({ exePath: exe, destPath: dest, anchor: probe.anchor, cdpPort: 9333 });
    assert.deepEqual(readFileSync(exe), before, "source exe must stay untouched");
    const patched = readFileSync(dest);
    assert.equal(patched.length, before.length, "patched copy keeps the exact file size");
    assert.equal(
      patched.toString("latin1", region.offset, region.offset + region.length),
      replacement
    );
    // Nothing outside the region may change.
    assert.equal(patched.toString("latin1", 0, region.offset), before.toString("latin1", 0, region.offset));

    // Mutated anchor in the source must be caught before any write.
    const mutated = path.join(tempRoot, "mutated.exe");
    const badBytes = Buffer.from(readFileSync(exe));
    badBytes[region.offset] = 0x21; // '!' over '-'
    writeFileSync(mutated, badBytes);
    assert.throws(
      () => buildPatchedExe({ exePath: mutated, destPath: path.join(tempRoot, "out.exe"), anchor: probe.anchor, cdpPort: 9333 }),
      /region mismatch/
    );
    assert.ok(!existsSync(path.join(tempRoot, "out.exe")), "failed patch must not leave a copy");

    // --- scanner ---------------------------------------------------------------
    const gameRoot = path.join(tempRoot, "Demon Fake");
    mkdirSync(path.join(gameRoot, "arc_img"), { recursive: true });
    mkdirSync(path.join(gameRoot, "arc_audio"), { recursive: true });
    mkdirSync(path.join(gameRoot, "save"), { recursive: true });
    makeFakeTauriExe(path.join(gameRoot, "game.exe"));

    const scan = scanGame(gameRoot);
    assert.equal(scan.container, "tauri");
    assert.equal(scan.engine.id, "MZ", "Tauri-MZ should report as MZ");
    assert.equal(scan.paths.exe, path.join(gameRoot, "game.exe"));
    assert.equal(scan.paths.saveDir, path.join(gameRoot, "save"));
    assert.equal(scan.saveDirKnown, true);
    assert.ok(scan.protection.flags.includes("tauri-webview2"));
    assert.equal(injectionStrategy(scan).id, "tauri-cdp");

    // Without the arc dirs the shallow probe window still catches this small
    // exe, but confidence drops — and a dir with NO markers stays unknown.
    const bareRoot = path.join(tempRoot, "Bare");
    mkdirSync(bareRoot, { recursive: true });
    makeFakeTauriExe(path.join(bareRoot, "game.exe"));
    assert.equal(scanGame(bareRoot).container, "tauri");

    const foreignRoot = path.join(tempRoot, "Foreign");
    mkdirSync(foreignRoot, { recursive: true });
    writeFileSync(path.join(foreignRoot, "game.exe"), "MZ not tauri at all");
    const foreign = scanGame(foreignRoot);
    assert.notEqual(foreign.container, "tauri");
    assert.equal(foreign.engine.id, "unknown-nwjs", "unmarked game.exe still falls through to unknown-nwjs");

    console.log("test-tauri-cdp: all checks ok");
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main();
