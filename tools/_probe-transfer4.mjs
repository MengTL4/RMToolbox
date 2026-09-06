// Direct transfer_player call vs flag-based transfer, with update-loop tracing.
import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";

const gameRoot = path.resolve(process.argv[2]);
const projectRoot = path.resolve(import.meta.dirname, "..");
const gameKey = path.basename(gameRoot).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);
const handle = await launchRgssGame({ gameRoot, projectRoot, gameKey });
const { session } = handle;
console.log("connected");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ev = (code) => session.send("debug.eval", { code }, 20000)
  .then((p) => console.log(">>", code.slice(0, 100), "\n  ", p.result))
  .catch((e) => console.log(">>", code.slice(0, 100), "\n   FAIL", e.message));

await session.send("save.load", { id: 1 }, 30000).then(() => console.log("loaded"));
await sleep(4000);
// Is the base update loop even being reached? Count via prepend-style probe:
await ev('class Scene_Map; alias $__probe_base_update update unless method_defined?($__probe_base_update); end; "no" rescue "alias-skip"');
await ev('$__upd_calls = 0; Scene_Map.prepend(Module.new do; def update; $__upd_calls += 1; super; end; end); "prepended"');
await sleep(1500);
await ev('$__upd_calls.to_s');
// Now drive the flags and watch whether transfer_player gets called
await ev('$__tp_calls = 0; Scene_Map.prepend(Module.new do; def transfer_player(*a); $__tp_calls += 1; super; end; end); "prepended2"');
await session.send("map.transfer", { mapId: 2, x: 10, y: 10 }, 20000).then((p) => console.log("transfer ack", JSON.stringify(p)));
await sleep(2000);
await ev('[$__upd_calls, $__tp_calls, $game_temp.player_transferring, $game_map.map_id].inspect');
// Manual direct call as fallback
await ev('$scene.transfer_player(false) rescue "ERR #{$!.class}: #{$!.message}"; $game_map.map_id.to_s');
await sleep(1500);
await ev('[$game_map.map_id, $game_player.x, $game_player.y].inspect');

handle.stop();
process.exit(0);
