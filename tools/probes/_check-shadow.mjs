import { parseScripts } from "../../core/rgss-marshal.mjs";
import zlib from "node:zlib";
import { readFileSync } from "node:fs";
const buf = readFileSync(
  "runtime/rgss-shadow/_1_0_9_1_unpacked/Data/Scripts.rxdata"
);
const parsed = parseScripts(buf);
for (const e of parsed.entries) {
  const name = e.name ? e.name.toString() : "";
  if (name.includes("RMCH")) {
    const body = zlib.inflateSync(e.zlib).toString("utf8");
    console.log(
      name,
      "len",
      body.length,
      "graphicsHook:",
      body.includes("rmch_graphics_update"),
      "disposeFallback:",
      body.includes("every live EventScene"),
      "heartbeat:",
      body.includes("rmch-heartbeat")
    );
  }
}
