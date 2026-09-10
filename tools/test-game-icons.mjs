// Real Vue and all three icon consumers, with only time, image decoding and
// the two image sources replaced. No game, browser or wall-clock sleep needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildFrontend } from "./gui-frontend.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const iconBundle = await buildFrontend(
  root,
  false,
  path.join(root, "tools/fixtures/icon-components.ts")
);
function harness() {
  let now = 100000,
    nextTimer = 1;
  const timers = new Map();
  const calls = { local: [], bridge: [], names: [], tiles: [] };
  const sources = {
    local: () => null,
    bridge: () => Promise.reject(new Error("booting")),
    name: () => null
  };
  let drawn = "";
  class Image {
    set src(value) {
      this.url = value;
      this.width = 512;
      this.height = 512;
      queueMicrotask(() =>
        value === "broken-image" ? this.onerror() : this.onload()
      );
    }
  }
  const context = vm.createContext({
    console,
    Image,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setTimeout(fn, ms) {
      const id = nextTimer++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    naive: { NText: "text", NCheckbox: "checkbox" },
    document: {
      createElement() {
        return {
          getContext() {
            return {
              clearRect() {},
              drawImage(image, x, y, w, h) {
                drawn = `${image.url}:${x},${y},${w},${h}`;
                calls.tiles.push(drawn);
              }
            };
          },
          toDataURL() {
            return drawn;
          }
        };
      }
    },
    window: { RMCH: {} }
  });
  vm.runInContext(
    readFileSync(path.join(root, "app/gui/vendor/vue.global.prod.js"), "utf8"),
    context
  );
  const Vue = context.Vue;
  const state = Vue.reactive({
    games: [
      { gameKey: "a", root: "root-a", engine: { id: "MZ" } },
      { gameKey: "b", root: "root-b", engine: { id: "MZ" } }
    ],
    sessions: []
  });
  const rmch = context.window.RMCH;
  rmch.store = {
    state,
    sessionFor(key) {
      return state.sessions.find((s) => s.gameKey === key && s.alive) || null;
    },
    server: {
      iconSetImage(root) {
        calls.local.push(root);
        return sources.local(root);
      },
      iconFileImage(root, name) {
        calls.names.push([root, name]);
        return sources.name(root, name);
      }
    },
    send(key, type) {
      assert.equal(type, "assets.iconset");
      calls.bridge.push(key);
      return sources.bridge(key);
    }
  };
  vm.runInContext(iconBundle, context, {
    filename: "compiled-icon-components.js"
  });
  const scopes = [];
  function use(factory) {
    const scope = Vue.effectScope();
    scopes.push(scope);
    return { scope, value: scope.run(factory) };
  }
  async function flush() {
    for (let i = 0; i < 15; i++) await Promise.resolve();
    await Vue.nextTick();
  }
  async function advance(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await flush();
    }
    now = until;
    await flush();
  }
  return {
    Vue,
    rmch,
    state,
    calls,
    sources,
    timers,
    use,
    flush,
    advance,
    close() {
      for (const scope of scopes) scope.stop();
    }
  };
}

// A failed first request must recover without changing gameKey, remounting,
// calling ensure, or manually notifying any consumer.
{
  const h = harness();
  try {
    const props = h.Vue.reactive({
      gameKey: "a",
      show: true,
      index: 17,
      iconName: null,
      size: 20,
      entries: [],
      query: "",
      checkLabel: "",
      valueOf: null,
      ownedIds: []
    });
    const list = h.use(() =>
      h.rmch.parts.EntryList.setup(props, { emit() {} })
    ).value;
    const picker = h.use(() => h.rmch.parts.Picker.setup(props)).value;
    const render = h.use(() => h.rmch.parts.GameIcon.setup(props)).value;
    const row = { id: 1, name: "item", iconIndex: 17 };
    const renderRow = () =>
      list.columns.value.find((c) => c.key === "name").render(row);
    assert.equal(render().type, "span", "placeholder while loading");
    await h.flush();
    assert.equal(h.calls.bridge.length, 1, "three consumers share one request");
    assert.equal(picker.iconsReady.value, false);
    assert.equal(render(), null);
    assert.equal(renderRow().props.class, "rm-entry-label");
    h.sources.bridge = () => Promise.resolve({ dataUrl: "bridge-sheet" });
    await h.advance(14999);
    assert.equal(h.calls.bridge.length, 1, "cooldown is respected");
    await h.advance(1);
    assert.equal(h.calls.bridge.length, 2);
    assert.equal(picker.iconsReady.value, true);
    assert.equal(
      renderRow().props.class,
      "rm-entry-name",
      "list updates automatically"
    );
    assert.equal(render().type, "img");
    assert.equal(render().props.src, "bridge-sheet:32,32,32,32");
    const drawn = h.calls.tiles.length;
    render();
    render();
    assert.equal(
      h.calls.tiles.length,
      drawn,
      "repeated renders reuse the sliced image"
    );
  } finally {
    h.close();
  }
}

// Subscription disposal cancels retries only after the last caller leaves.
{
  const h = harness();
  try {
    const first = h.use(() => h.rmch.iconset.useGame(() => "a"));
    const second = h.use(() => h.rmch.iconset.useGame(() => "a"));
    await h.flush();
    first.scope.stop();
    await h.advance(15000);
    assert.equal(
      h.calls.bridge.length,
      2,
      "remaining subscriber still retries"
    );
    second.scope.stop();
    await h.advance(45000);
    assert.equal(
      h.calls.bridge.length,
      2,
      "no requests after last subscriber leaves"
    );
    assert.equal(h.timers.size, 0);
    h.sources.local = () => "local-after-return";
    const returned = h.use(() => h.rmch.iconset.useGame(() => "a"));
    await h.flush();
    assert.equal(
      returned.value.ready.value,
      true,
      "reopening restarts a failed load"
    );
  } finally {
    h.close();
  }
}

// A picker stays mounted while hidden, so visibility must release its load.
{
  const h = harness();
  try {
    const props = h.Vue.reactive({
      gameKey: "a",
      show: false,
      entries: [],
      ownedIds: []
    });
    const picker = h.use(() => h.rmch.parts.Picker.setup(props)).value;
    await h.flush();
    assert.equal(h.calls.bridge.length, 0, "hidden picker starts no request");
    props.show = true;
    await h.flush();
    assert.equal(h.calls.bridge.length, 1);
    props.show = false;
    await h.flush();
    await h.advance(30000);
    assert.equal(
      h.calls.bridge.length,
      1,
      "closing the modal cancels its retries"
    );
    h.sources.bridge = () => Promise.resolve({ dataUrl: "reopened-picker" });
    props.show = true;
    await h.flush();
    assert.equal(picker.iconsReady.value, true);
    assert.equal(h.calls.bridge.length, 2);
  } finally {
    h.close();
  }
}

// Old asynchronous results and same-key changes must not leak across games.
{
  const h = harness();
  let finishOld;
  try {
    h.sources.bridge = (key) =>
      key === "a"
        ? new Promise((resolve) => {
            finishOld = resolve;
          })
        : Promise.resolve({ dataUrl: "game-b" });
    const selected = h.Vue.ref("a");
    const icons = h.use(() =>
      h.rmch.iconset.useGame(() => selected.value)
    ).value;
    await h.flush();
    selected.value = "b";
    await h.flush();
    assert.equal(icons.image(0), "game-b:0,0,32,32");
    finishOld({ dataUrl: "late-game-a" });
    await h.flush();
    assert.equal(icons.image(0), "game-b:0,0,32,32");
    h.sources.local = (root) => root;
    h.state.games[1].root = "replacement-root";
    await h.flush();
    assert.equal(
      icons.image(0),
      "replacement-root:0,0,32,32",
      "same key with different root gets a fresh cache"
    );
    h.sources.local = () => "new-session-sheet";
    h.state.sessions = [{ gameKey: "b", alive: true, connectedAt: 123 }];
    await h.flush();
    assert.equal(
      icons.image(0),
      "new-session-sheet:0,0,32,32",
      "new session invalidates old decoded assets"
    );
  } finally {
    h.close();
  }
}

// Decode failure falls back to the bridge; RGSS sheets keep 24px cells.
{
  const h = harness();
  try {
    h.state.games[0].engine.id = "RGSS3";
    h.sources.local = () => "broken-image";
    h.sources.bridge = () => Promise.resolve({ dataUrl: "rgss-sheet" });
    const icons = h.use(() => h.rmch.iconset.useGame(() => "a")).value;
    await h.flush();
    assert.equal(icons.image(22), "rgss-sheet:24,24,24,24");
    assert.equal(h.calls.bridge.length, 1);
  } finally {
    h.close();
  }
}

// Named RGSS1 icons have the same recovery ownership and require no sheet.
{
  const h = harness();
  try {
    h.state.games[0].engine.id = "RGSS1";
    const props = h.Vue.reactive({
      gameKey: "a",
      index: null,
      iconName: "药水",
      size: 20
    });
    const render = h.use(() => h.rmch.parts.GameIcon.setup(props)).value;
    assert.equal(render(), null);
    await h.flush();
    assert.equal(h.calls.bridge.length, 0);
    h.sources.name = (_, name) => `named:${name}`;
    await h.advance(15000);
    assert.equal(render().props.src, "named:药水");
    props.iconName = "toString";
    assert.equal(
      render().props.src,
      "named:toString",
      "names do not collide with object properties"
    );
  } finally {
    h.close();
  }
}
console.log(
  "test-game-icons: consumer recovery, request sharing, disposal, identity, fallback and named icons passed"
);
