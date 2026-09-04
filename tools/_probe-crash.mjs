// One-off verification probe: ask a live bridge for the page's crash-overlay
// state and current scene (TK.$ alias aware). Usage: node tools/_probe-crash.mjs <gameKey>
import { sendCommand } from "./send.mjs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const target = process.argv[2];
if (!target) {
  console.error("usage: node tools/_probe-crash.mjs <gameKey>");
  process.exit(1);
}

const code = `(function () {
  var text = (document.body && document.body.textContent || "").replace(/\\s+/g, " ").slice(0, 200);
  var crash = /encountered a bug|TypeError|Press F5/i.test(text);
  var scene = null;
  var sm = (window.TK && window.TK.$ && (TK.$.SceneMrg || TK.$.SceneManager)) || window.SceneManager;
  try {
    if (sm && sm._scene) scene = (sm._scene.constructor && sm._scene.constructor.name) || "anonymous";
  } catch (e) { scene = "ERR:" + e.message; }
  var dm = (window.TK && window.TK.$ && TK.$.DataMrg) || window.DataManager;
  var lg;
  if (!dm) lg = "NO-DM";
  else {
    try { lg = JSON.stringify(dm.loadGlobalInfo()).slice(0, 150); }
    catch (e) { lg = "THROW:" + e.message; }
  }
  return JSON.stringify({ title: document.title, scene: scene, crashVisible: crash, loadGlobalInfo: lg, bodyText: text });
})()`;

const result = await sendCommand({ projectRoot, target, type: "console.eval", args: { code } });
console.log(JSON.stringify(result, null, 2));
