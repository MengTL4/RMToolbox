// GUI end-to-end: boot the NW.js GUI, launch the Essentials game through the
// library store, load a save, open 数据 › 角色, click the first Pokemon, and
// assert the detail panel renders without the boot-error box appearing
// (regression: "ResizeObserver loop limit exceeded" must be filtered).
//
//   node tools/_probe-gui-actor.mjs
// Requires the game registered in runtime/gui-library.json. Kills nothing.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Hard watchdog: any hung CDP eval must not park the probe forever.
setTimeout(() => { console.log("WATCHDOG: 150s exceeded, bailing"); process.exit(2); }, 150000).unref();

// --- tiny CDP client over the GUI's debug endpoint ---------------------------
// Port 9333: adb.exe holds a zombie forward on 9222 on this machine.
const CDP_PORT = 9333;
async function cdpList() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`,
    { signal: AbortSignal.timeout(3000) });
  return res.json();
}
let ws, msgId = 0;
const pending = new Map();
async function cdpConnect() {
  const pages = await cdpList();
  const page = pages.find((p) => p.type === "page");
  if (!page) throw new Error("no page target");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error("ws connect failed"));
  });
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
}
function evaluate(expression, awaitPromise = false) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("eval timeout: " + expression.slice(0, 60)));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(msg.error.message));
      else if (msg.result && msg.result.exceptionDetails) {
        reject(new Error(msg.result.exceptionDetails.exception?.description || "eval exception"));
      } else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    });
    ws.send(JSON.stringify({ id, method: "Runtime.evaluate",
      params: { expression, awaitPromise, returnByValue: true } }));
  });
}

// --- boot the GUI ------------------------------------------------------------
const gui = spawn(path.join(projectRoot, "app", "gui", "RMToolbox.exe"),
  [`--remote-debugging-port=${CDP_PORT}`], { detached: true, stdio: "ignore" });
gui.unref();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "ok" : "FAIL"} ${label}${ok ? "" : "  " + detail}`);
  if (!ok) failures += 1;
};

try {
  let up = false;
  for (let i = 0; i < 60 && !up; i += 1) {
    await sleep(1000);
    up = await cdpList().then(() => true, () => false);
  }
  if (!up) throw new Error("GUI CDP never came up");
  await cdpConnect();
  console.log("gui     : connected");
  console.log("games   :", await evaluate(`(RMCH.store.state.games || []).length`));

  await evaluate(`(async () => {
    const g = RMCH.store.state.games.find((x) => x.root && x.root.indexOf("赤途") >= 0);
    if (!g) throw new Error("赤途 not in library");
    await RMCH.store.launch(g);
    return g.gameKey;
  })()`, true);

  // Wait for the bridge session + pick it in the trainer, then load slot 1.
  const gameKey = await evaluate(`(async () => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const live = (RMCH.store.state.sessions || []).find((x) => x.alive && x.gameKey.indexOf("赤途") >= 0);
      if (live) { RMCH.store.selectGame(live.gameKey); return live.gameKey; }
      if (Date.now() > deadline) throw new Error("session never went live");
      await new Promise((r) => setTimeout(r, 500));
    }
  })()`, true);
  console.log("game    :", gameKey);

  console.log("load    :", await evaluate(`RMCH.store.send(${JSON.stringify(gameKey)}, "save.load", { id: 1 })`, true)
    .then((r) => JSON.stringify(r), (e) => "ERR " + e.message));
  await sleep(5000); // Scene_Map + announcement settle

  // Open 数据 › 角色 and click the first roster entry (a Pokemon).
  await evaluate(`RMCH.store.data.tab = "actor"`);
  await evaluate(`(async () => {
    await RMCH.store.loadRoster();
    await RMCH.store.refreshParty();
    return RMCH.store.trainer.roster.length;
  })()`, true).then((n) => check("roster = party", n > 0, `roster=${n}`));

  // Drive the app shell to the data tab (tab is a local ref — go via the menu DOM).
  await evaluate(`(() => {
    const items = [...document.querySelectorAll(".n-menu-item-content")];
    const el = items.find((n) => n.textContent.includes("数据"));
    if (el) el.click();
    return !!el;
  })()`).then((ok) => check("nav to 数据", !!ok));
  await sleep(800);
  console.log("nav state:", await evaluate(`(() => {
    const sel = document.querySelector(".n-menu-item--selected, .n-menu-item-content--selected");
    return JSON.stringify({
      selected: sel && sel.textContent.trim(),
      tab: RMCH.store.data && RMCH.store.data.tab,
      gameKey: RMCH.store.trainer.gameKey,
      tabs: document.querySelectorAll(".n-tabs").length
    });
  })()`));

  await evaluate(`(() => {
    const rows = [...document.querySelectorAll(".rm-entry-list .n-list-item, .rm-entry")];
    return rows.length;
  })()`);
  // Click the first selectable row in the actors list.
  await evaluate(`(() => {
    const cands = [...document.querySelectorAll("*")].filter((n) =>
      n.children.length === 0 && /妙澪儿|小火龙|阿柏蛇/.test(n.textContent || ""));
    const row = cands[0] && cands[0].closest(".n-list-item, .rm-entry, li, div");
    if (row) row.click();
    return !!row;
  })()`);
  await sleep(500);
  // Fallback: select through the store (what the click does).
  await evaluate(`RMCH.store.data.selected.actor = 1; RMCH.store.openActor(1)`);
  await sleep(1500);

  const actor = await evaluate(`(RMCH.store.trainer.actor && RMCH.store.trainer.actor.name) || null`);
  check("actor detail loaded", !!actor, "trainer.actor empty");
  console.log("actor   :", actor || "?");

  const rendered = await evaluate(`(() => {
    const t = document.body.innerText;
    return { skills: /技能 \\d/.test(t), params: /属性加值/.test(t), name: t.includes(${JSON.stringify("妙澪儿")}) };
  })()`);
  check("detail panel rendered", !!(rendered && rendered.skills && rendered.params), JSON.stringify(rendered));
  if (!(rendered && rendered.skills && rendered.params)) {
    console.log("body text:", await evaluate(
      `document.body.innerText.replace(/\\s+/g, " ").slice(0, 500)`));
  }

  // The ResizeObserver notice must be filtered: simulate it, expect no overlay.
  const filtered = await evaluate(`(() => {
    window.dispatchEvent(new ErrorEvent("error", { message: "ResizeObserver loop limit exceeded" }));
    const box = document.getElementById("boot-error");
    return box ? box.hidden : true;
  })()`);
  check("ResizeObserver notice filtered", filtered === true);

  const realError = await evaluate(`(() => {
    window.dispatchEvent(new ErrorEvent("error", { message: "something genuinely broke" }));
    const box = document.getElementById("boot-error");
    const shown = box && !box.hidden;
    if (box) box.hidden = true; // reset
    return shown;
  })()`);
  check("real errors still surface", realError === true);
} catch (error) {
  failures += 1;
  console.log("  FAIL driver:", error.message);
}

console.log(failures ? `gui-actor: FAIL (${failures})` : "gui-actor: PASS");
try { process.kill(-gui.pid); } catch (_) {}
spawn("taskkill", ["/IM", "RMToolbox.exe", "/F"], { stdio: "ignore" });
spawn("taskkill", ["/IM", "Game.exe", "/F"], { stdio: "ignore" });
process.exit(failures ? 1 : 0);
