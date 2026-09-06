// Trace why map.transfer didn't take: check flags + scene after the command.
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
  .then((p) => console.log(">>", code.slice(0, 75), "\n  ", p.result))
  .catch((e) => console.log(">>", code.slice(0, 75), "\n   FAIL", e.message));

await session.send("save.load", { id: 1 }, 30000).then(() => console.log("loaded"));
await sleep(4000);
await ev('$scene.class.to_s');
await session.send("map.transfer", { mapId: 2, x: 10, y: 10 }, 20000).then((p) => console.log("transfer ack", JSON.stringify(p)));
await ev('[$game_temp.player_transferring, $game_temp.player_new_map_id, $game_temp.player_new_x, $game_temp.player_new_y].inspect');
await sleep(1500);
await ev('[$game_temp.player_transferring, $game_temp.player_new_map_id].inspect');
await sleep(3000);
await ev('[$game_temp.player_transferring, $game_map.map_id, $scene.class.to_s].inspect');

handle.stop();
process.exit(0);
