import assert from "node:assert/strict";
import { LaunchPlanError, LAUNCH_ROUTES, planLaunch } from "../core/launch-plan.mjs";

const exe = "C:/games/Test/Game.exe";

function nw(overrides = {}) {
  return {
    root: "C:/games/Test",
    container: "nwjs",
    engine: { id: "MV", confidence: "high" },
    paths: { exe },
    manifest: { bgScript: null },
    protection: { flags: [] },
    ...overrides
  };
}

function ids(plan) {
  return plan.candidates.map((entry) => entry.id);
}

// A normal bg-script game has both possible delivery planes. Shadow is the
// safe default, while native DLL remains an explicit fallback/override.
{
  const plan = planLaunch(nw({ manifest: { bgScript: "loading" } }));
  assert.equal(plan.family, "standard-nwjs");
  assert.equal(plan.preferred, LAUNCH_ROUTES.SHADOW);
  assert.equal(plan.selected, LAUNCH_ROUTES.SHADOW);
  assert.deepEqual(ids(plan), ["shadow", "extension", "dll"]);
  assert.equal(plan.blocked.some((entry) => entry.id === "shadow"), false);
  assert.deepEqual(plan.fallback, ["extension", "dll"]);
}

// A no-bg-script game cannot be forced through the ordinary shadow patch.
{
  const plan = planLaunch(nw());
  assert.equal(plan.preferred, LAUNCH_ROUTES.EXTENSION);
  assert.deepEqual(ids(plan), ["extension", "dll"]);
  assert.equal(plan.blocked.find((entry) => entry.id === "shadow").reason.includes("bg-script"), true);
  assert.equal(planLaunch(nw(), { strategy: "dll" }).selected, "dll");
}

// Grover keeps the explicit shadow route but defaults to plain launch + DLL.
{
  const scan = nw({ manifest: { bgScript: "loading" }, protection: { flags: ["grover-boot"] } });
  const auto = planLaunch(scan);
  assert.equal(auto.preferred, "dll");
  assert.deepEqual(ids(auto), ["dll", "shadow"]);
  assert.equal(planLaunch(scan, { strategy: "shadow" }).selected, "shadow");
  const extension = planLaunch(scan, { strategy: "extension" });
  assert.equal(extension.selected, "dll");
  assert.match(extension.override, /保护壳拒绝/);
}

// NB shells expose only their safe native route; no flag-bearing route is
// silently attempted.
for (const container of ["nb-evalnwbin", "enigma-nb"]) {
  const plan = planLaunch(nw({ container }));
  assert.equal(plan.selected, "dll");
  assert.deepEqual(ids(plan), ["dll"]);
  assert.equal(plan.blocked.some((entry) => entry.id === "shadow"), true);
  assert.equal(planLaunch(nw({ container }), { strategy: "shadow" }).selected, "dll");
}

// Dedicated containers never fall through to a generic MV/MZ route.
for (const [container, selected] of [
  ["tauri", "tauri-cdp"],
  ["nwjs-sealed", "extension-cdp-seed"],
  ["nwjs-bundled", "shadow-engine-publish"],
  ["evb", "evb-unpack-rgss-script"]
]) {
  const plan = planLaunch(nw({ container }));
  assert.equal(plan.selected, selected);
  assert.deepEqual(ids(plan), [selected]);
}

assert.equal(planLaunch({ engine: { id: "RGSS1" }, container: "rgss" }).selected, "rgss-script");
assert.equal(planLaunch({ engine: { id: "RM2K" } }).selected, null);
assert.equal(planLaunch(nw({ container: "nb-shell" })).selected, null);

// Aliases are accepted for scripts and the missing executable remains a clear
// preflight diagnostic rather than changing the chosen delivery route.
{
  const plan = planLaunch(nw({ paths: {} }), { strategy: "inject" });
  assert.equal(plan.selected, "dll");
  assert.equal(plan.blocked.some((entry) => entry.id === "preflight"), true);
}

const rejected = planLaunch(nw(), { strategy: "shadow" });
assert.equal(rejected.selected, null);
assert.match(rejected.error, /shadow/);
assert.throws(() => { throw new LaunchPlanError(rejected); }, LaunchPlanError);

console.log("test-launch-plan: route classification and overrides passed");
