// One-off: verify CDP target matching against a live Tauri game.
import { openCdpSession } from "../../core/cdp-client.mjs";

const port = Number(process.argv[2] || 14717);
const cdp = await openCdpSession({
  port,
  matchUrl: ["http://tauri.localhost/", "https://tauri.localhost/"],
  timeoutMs: 8000
});
console.log("connected:", cdp.target.url);
const out = await cdp.evaluate(
  "JSON.stringify({title: document.title, mz: !!(window.Utils && Utils.RPGMAKER_NAME), name: window.Utils && Utils.RPGMAKER_NAME, ver: window.Utils && Utils.RPGMAKER_VERSION})"
);
console.log("eval:", out);
cdp.close();
process.exit(0);
