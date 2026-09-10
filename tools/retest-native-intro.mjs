// Drive native game message choices on an explicitly marked disposable copy.
// The game's interpreter runs every event; no events or actors are fabricated.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { getToken } from "../core/token.mjs";
const state = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
assert.ok(fs.existsSync(path.join(state.root, ".rmch-isolated-test")));
const token = getToken(
  state.projectRoot || path.resolve(import.meta.dirname, "..")
);
const socket = new WebSocket(
  `ws://127.0.0.1:${state.port}/client?token=${encodeURIComponent(token)}`
);
await new Promise((resolve, reject) => {
  socket.onopen = resolve;
  socket.onerror = reject;
});
let sequence = 0;
const pending = new Map();
socket.onmessage = (event) => {
  const r = JSON.parse(String(event.data));
  if (r.t !== "result") return;
  const p = pending.get(r.id);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(r.id);
  r.ok ? p.resolve(r.payload) : p.reject(Error(r.error));
};
function send(type, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Error("timeout " + type));
    }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(
      JSON.stringify({ t: "send", id, gameKey: state.gameKey, type, args })
    );
  });
}
try {
  let idle = 0;
  for (let i = 0; i < 240; i++) {
    const r = await send("console.eval", {
      code: `(function(){var t=window.TK&&TK.$,sm=t&&t.SceneMrg||window.SceneManager,msg=t&&t.gameMessage?t.gameMessage():window.$gameMessage;if(!sm||!msg)return 'missing engine';var s=sm._scene;if(s&&/(?:Scene|Sce)_Name$/.test(s.constructor.name)&&s.onInputOk){s.onInputOk();return 'default name';}var choices=msg.choices?msg.choices():[];if(choices.length){var index=choices.findIndex(function(x){return /自由模式|普通难度|简单难度/.test(x)});if(index<0)index=0;var text=choices[index],cw=s&&(s._choiceListWindow||s._messageWindow&&(s._messageWindow._choiceListWindow||s._messageWindow._choiceWindow));if(cw&&typeof cw.processOk==='function'){if(!cw.active)return 'choice window opening';cw.select(index);cw.processOk();}else{msg.onChoice(index);msg.clear();}return 'choice: '+text;}var w=s&&s._messageWindow;if(w&&w.pause&&typeof w.terminateMessage==='function'){w.pause=false;w.terminateMessage();return 'native message window confirmed';}if(msg.isBusy()){if(w){w._showFast=true;return 'native message rendering';}msg.clear();return 'native message advanced';}return 'idle';})()`
    });
    console.log(JSON.stringify(r.result));
    const party = await send("party.info");
    const map = await send("map.inspect").catch(() => null);
    idle = map && !map.busy && party.members?.length ? idle + 1 : 0;
    if (idle >= 10) {
      console.log(
        "READY",
        JSON.stringify({
          party: party.members.map((a) => ({ id: a.id, name: a.name })),
          mapId: map.mapId
        })
      );
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
} finally {
  socket.close();
}
