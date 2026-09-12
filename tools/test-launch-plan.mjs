import assert from "node:assert/strict";
import { LaunchPlanError, planLaunch } from "../core/launch-plan.mjs";
import {
  ROUTES,
  ATTACH_ROUTES,
  routeLabel,
  routeMechanismText,
  preflightOf
} from "../core/launch-routes.mjs";

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
  assert.equal(plan.preferred, "shadow");
  assert.equal(plan.selected, "shadow");
  assert.deepEqual(ids(plan), ["shadow", "extension", "dll"]);
  assert.equal(
    plan.blocked.some((entry) => entry.id === "shadow"),
    false
  );
  assert.deepEqual(plan.fallback, ["extension", "dll"]);
}

// A no-bg-script game cannot be forced through the ordinary shadow patch.
{
  const plan = planLaunch(nw());
  assert.equal(plan.preferred, "extension");
  assert.deepEqual(ids(plan), ["extension", "dll"]);
  assert.equal(
    plan.blocked
      .find((entry) => entry.id === "shadow")
      .reason.includes("bg-script"),
    true
  );
  assert.equal(planLaunch(nw(), { strategy: "dll" }).selected, "dll");
}

// Grover keeps the explicit shadow route but defaults to plain launch + DLL.
{
  const scan = nw({
    manifest: { bgScript: "loading" },
    protection: { flags: ["grover-boot"] }
  });
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
  assert.equal(
    plan.blocked.some((entry) => entry.id === "shadow"),
    true
  );
  assert.equal(
    planLaunch(nw({ container }), { strategy: "shadow" }).selected,
    "dll"
  );
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

assert.equal(
  planLaunch({ engine: { id: "RGSS1" }, container: "rgss" }).selected,
  "rgss-script"
);
assert.equal(planLaunch({ engine: { id: "RM2K" } }).selected, null);
assert.equal(planLaunch(nw({ container: "nb-shell" })).selected, null);

// A missing executable stays a clear preflight diagnostic rather than changing
// the chosen delivery route.
{
  const plan = planLaunch(nw({ paths: {} }), { strategy: "dll" });
  assert.equal(plan.selected, "dll");
  assert.equal(
    plan.blocked.some((entry) => entry.id === "preflight"),
    true
  );
}

const rejected = planLaunch(nw(), { strategy: "shadow" });
assert.equal(rejected.selected, null);
assert.match(rejected.error, /shadow/);
assert.throws(() => {
  throw new LaunchPlanError(rejected);
}, LaunchPlanError);

// One catalogue, one vocabulary: every strategy string the toolbox can report
// (launch routes and attach-side strategies alike) has a Chinese name and a
// mechanism, so the GUI dropdown, the plan and the log cannot drift apart.
for (const id of [...Object.keys(ROUTES), ...Object.keys(ATTACH_ROUTES)]) {
  assert.notEqual(
    routeLabel(id),
    id,
    `route ${id} must be named in the catalogue`
  );
  assert.ok(
    routeMechanismText(id).length > 0,
    `route ${id} must declare a mechanism`
  );
}

// Launch routes share the operation axis with attach strategies, and each one
// carries the user-goal phrase the GUI shows instead of keeping its own labels.
for (const route of Object.values(ROUTES)) {
  assert.equal(
    route.operation,
    "launch",
    `route ${route.id} must declare operation "launch"`
  );
  assert.ok(route.userGoal, `route ${route.id} must carry a userGoal`);
  // The primary action button is labelled with what the route actually DOES,
  // because "启动并注入" alone hides the difference that matters: the dll route
  // starts the game bare (no launch flags) and hooks it afterwards, which is
  // the only thing a blacklist shell accepts. A route without its own wording
  // would fall back to the generic label and re-hide that.
  assert.ok(
    route.actionLabel,
    `route ${route.id} must carry an actionLabel for the launch button`
  );
}

// The dll route is the one whose action is least guessable from its name, so
// pin the wording that says the game starts bare.
assert.match(ROUTES.dll.actionLabel, /裸启动|不带任何启动参数/);

// 运行副本 is a mechanism, not a route a user picks: the copy-based routes say
// so instead of each inventing its own name for the same trick.
assert.deepEqual(ROUTES["rgss-script"].alsoUses, ["copy"]);
assert.deepEqual(ROUTES["evb-unpack-rgss-script"].alsoUses, ["copy", "script"]);
assert.equal(ROUTES.shadow.mechanism, "copy");
assert.match(routeMechanismText("evb-unpack-rgss-script"), /解包/);

// Candidates carry their label, userGoal, actionLabel and mechanism so the GUI
// needs no second map.
{
  const plan = planLaunch(nw({ manifest: { bgScript: "loading" } }));
  const shadow = plan.candidates.find((entry) => entry.id === "shadow");
  assert.equal(shadow.label, "影子目录");
  assert.equal(shadow.userGoal, "不动原目录");
  assert.equal(shadow.mechanismLabel, "运行副本");
  assert.ok(shadow.actionLabel, "candidates must carry actionLabel");
  assert.equal(plan.selectedLabel, "影子目录");
}

// The nb-evalnwbin family has exactly one route and it is dll: whatever else
// happens, the plan handed to the GUI must carry the bare-launch wording that
// stops the button from reading as "the toolbox will relaunch the game its way".
{
  const plan = planLaunch({
    root: "C:/games/_V1.2.2_B电脑端",
    gameKey: "_V1.2.2_B电脑端",
    container: "nb-evalnwbin",
    paths: { exe: "C:/games/_V1.2.2_B电脑端/万族穿越-源启崛起.exe" },
    protection: { level: 2, flags: [] }
  });
  assert.equal(plan.selected, "dll");
  assert.equal(plan.candidates.length, 1);
  assert.match(plan.candidates[0].actionLabel, /裸启动/);
  assert.equal(plan.fallback.length, 0);
}

// The static half of preflight is decided by the catalogue, not inline.
assert.equal(preflightOf(nw(), "shadow").ok, false);
assert.match(preflightOf(nw(), "shadow").reason, /bg-script/);
assert.equal(
  preflightOf(nw({ manifest: { bgScript: "loading" } }), "shadow").ok,
  true
);
assert.equal(preflightOf(nw({ paths: {} }), "extension").ok, false);
assert.equal(
  preflightOf(nw({ paths: {} }), "rgss-script").ok,
  true,
  "RGSS preflight is a runtime question"
);

console.log(
  "test-launch-plan: route classification, overrides and catalogue naming passed"
);
