import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scopeTimers = new Set();
const dialogs = [];
const context = vm.createContext({
  console,
  Promise,
  setTimeout(fn, ms) {
    const id = setTimeout(fn, ms);
    scopeTimers.add(id);
    return id;
  },
  clearTimeout,
  window: {
    RMCH: {},
    innerWidth: 1180,
    innerHeight: 800,
    addEventListener() {}
  },
  document: {
    createElement() {
      return {};
    }
  },
  naive: new Proxy(
    { useDialog: () => ({ warning: (options) => dialogs.push(options) }) },
    {
      get(t, p) {
        return t[p] || String(p);
      }
    }
  )
});
function load(file) {
  vm.runInContext(fs.readFileSync(path.join(root, file), "utf8"), context, {
    filename: file
  });
}
load("tools/fixtures/gui-host.js");
context.require = context.window.require;
load("app/gui/vendor/vue.global.prod.js");
const scripts = [
  ...fs
    .readFileSync(path.join(root, "app/gui/index.html"), "utf8")
    .matchAll(/<script src="(ui\/[^"]+)"/g)
]
  .map((m) => m[1])
  .filter((s) => !["ui/main.js", "ui/boot-guard.js"].includes(s));
for (const file of scripts) load("app/gui/" + file);
const { Vue } = context;
const rmch = context.window.RMCH,
  store = rmch.store,
  host = context.window.__guiFixture;
const scopes = [];
function setup(component, props = {}, ctx = {}) {
  const scope = Vue.effectScope();
  scopes.push(scope);
  return scope.run(() => component.setup(props, ctx));
}
async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await Vue.nextTick();
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
try {
  await store.init();
  store.selectGame("a");
  await flush();
  const saves = setup(rmch.views.Saves),
    editor = setup(rmch.views.Console);
  const items = setup(rmch.views.DataItems, Vue.reactive({ kind: "item" }));
  const gold = setup(rmch.parts.GoldPanel),
    rates = setup(rmch.parts.CheatRates);
  items.select({ id: 1 });
  gold.amount.value = 900;
  items.draft.value = 77;
  rates.push("expRate", 5);
  editor.code.value = "hello-a";
  await flush();
  assert.equal(saves.gameKey.value, "a");
  assert.equal(editor.gameKey.value, "a");
  assert.equal(
    host.calls.filter((c) => c.type === "trainer.options.set").length,
    0,
    "editing rates must not send"
  );
  store.selectGame("b");
  await flush();
  items.select({ id: 1 });
  assert.equal(gold.amount.value, null);
  assert.equal(items.draft.value, 3);
  assert.equal(saves.gameKey.value, "b");
  assert.equal(editor.code.value, "");
  gold.amount.value = 40;
  items.draft.value = 8;
  store.selectGame("a");
  await flush();
  assert.equal(gold.amount.value, 900);
  assert.equal(items.draft.value, 77);
  assert.equal(editor.code.value, "hello-a");
  store.data.counts.item[1] = 19;
  assert.equal(items.count.value, 19);
  assert.equal(items.draft.value, 77, "live refresh preserves draft");
  rates.apply();
  await flush();
  assert.equal(host.options.a.expRate, 5);
  assert.equal(host.options.b.expRate, 2);

  const emitted = [];
  const delta = setup(
    rmch.parts.Delta,
    { value: 4, min: 0 },
    { emit: (...args) => emitted.push(args) }
  );
  delta.bump(1);
  assert.deepEqual(emitted, [["update:value", 5]], "plus only updates draft");

  const originalSend = host.send;
  const old = deferred();
  host.send = (key, type, args) =>
    type === "gold.set" ? old.promise : originalSend(key, type, args);
  gold.apply("gold.set");
  store.selectGame("b");
  await flush();
  old.resolve({ gold: 900 });
  await flush();
  assert.notEqual(
    store.trainer.gold,
    900,
    "old request cannot overwrite new game"
  );
  host.send = originalSend;

  const tree = deferred();
  host.send = (key, type, args) =>
    type === "save.contents.get" ? tree.promise : originalSend(key, type, args);
  const treeRequest = store.loadSaveTree();
  store.selectGame("a");
  await flush();
  tree.resolve({ json: '{"from":"b"}', bytes: 12 });
  assert.equal(await treeRequest, null);
  assert.equal(store.data.tree.json, null);
  assert.equal(store.data.tree.loading, false);

  const actors = setup(rmch.views.DataActors);
  actors.select({ id: 1 });
  await flush();
  actors.form.value.level = 20;
  actors.form.value.exp = 50;
  const level = deferred();
  host.send = (key, type, args) =>
    type === "actor.level.set" ? level.promise : originalSend(key, type, args);
  const levelRequest = actors.applyLevel();
  store.selectGame("b");
  await flush();
  level.resolve({ actor: { id: 1, level: 20 } });
  await levelRequest;
  assert.equal(
    host.calls.filter((c) => c.type === "actor.exp.add").length,
    0,
    "stale chained edit must stop"
  );
  host.send = originalSend;

  let applied = false;
  store.gameDialog({ warning: (o) => dialogs.push(o) }).warning({
    onPositiveClick: () => {
      applied = true;
    }
  });
  store.selectGame("a");
  await flush();
  dialogs.pop().onPositiveClick();
  assert.equal(applied, false, "old confirmation cannot act on another game");

  const before = host.calls.length;
  host.sessions = host.sessions.filter((s) => s.gameKey !== "a");
  host.handlers.onSessions(host.sessions);
  await flush();
  assert.equal(store.trainer.gameKey, "a");
  assert.equal(store.currentConnected.value, false);
  await store.cmdWarn("gold.set", { value: 100 });
  assert.equal(
    host.calls.length,
    before,
    "disconnected selection sends nothing"
  );
  assert.match(store.currentGameOptions.value[0].label, /已断开/);
  host.sessions.push({ gameKey: "a", alive: true, connectedAt: 2 });
  host.handlers.onSessions(host.sessions);
  await flush();
  assert.equal(
    store.currentConnected.value,
    true,
    "reused host array still triggers reconnect"
  );
  assert.equal(items.draft.value, 77);
  const toggles = setup(rmch.parts.CheatToggles);
  host.send = (key, type, args) =>
    type === "trainer.options.set"
      ? Promise.reject(new Error("switch refused"))
      : originalSend(key, type, args);
  toggles.toggle("invincible", true);
  await flush();
  assert.notEqual(
    store.trainer.options.invincible,
    true,
    "failed switch cannot look enabled"
  );
  assert.ok(store.state.log.some((line) => line.includes("switch refused")));
  host.send = originalSend;
  store.noteBattle(true);
  const battleDraft = store.useDraft(
    () => "battle." + store.trainer.battleToken + ".hp",
    {}
  );
  battleDraft.value[0] = 1;
  store.noteBattle(false);
  store.noteBattle(true);
  assert.equal(
    battleDraft.value[0],
    undefined,
    "new battle does not inherit old enemy HP drafts"
  );

  const launch = deferred();
  host.launch = () => launch.promise;
  const c = host.games[2],
    inFlight = store.launch(c);
  assert.equal(await store.attach(c), null);
  assert.equal(await store.stop(c), null);
  launch.reject(new Error("fixture connection failed"));
  await inFlight;
  assert.equal(store.state.operations.c.status, "error");
  assert.match(store.state.operations.c.text, /fixture connection failed/);
  host.launch = () => Promise.resolve({ gameKey: "c", pid: 123 });
  await store.launch(c);
  assert.equal(store.state.operations.c.status, "success");
  assert.equal(store.trainer.gameKey, "a", "launch never steals selection");
  console.log(
    "test-ui-interactions: shared selection, drafts, explicit submit, stale results, disconnect and operation exclusion passed"
  );
} finally {
  scopes.forEach((s) => s.stop());
  scopeTimers.forEach(clearTimeout);
}
