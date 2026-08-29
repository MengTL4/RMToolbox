// Integration smoke test for the GUI host layer with an RGSS game, without
// NW.js: boots host.cjs under plain Node, launches a game through the normal
// launcher dispatch, then exercises the session/command routing the page uses.
//
//   node tools/test-host-rgss.mjs <gameRoot>

const path = require("path");
const host = require("../app/gui/host.cjs");

const gameRoot = process.argv[2];
if (!gameRoot) {
  console.error("usage: node tools/test-host-rgss.mjs <gameRoot>");
  process.exit(2);
}

const projectRoot = path.resolve(__dirname, "..");

async function main() {
  await host.init(projectRoot);
  const summary = await host.launch(gameRoot);
  console.log("launch:", summary.gameKey, summary.strategy, "pid", summary.pid);

  const sessions = host.listSessions();
  const mine = sessions.find((s) => s.gameKey === summary.gameKey);
  console.log("listSessions:", mine ? `found (alive=${mine.alive}, engine=${mine.engine})` : "MISSING");

  const catalog = await host.send(summary.gameKey, "catalog.query", { kind: "item" });
  console.log("catalog.query:", catalog.total, "items");

  try {
    const party = await host.send(summary.gameKey, "party.info", {});
    console.log("party.info:", (party.members || []).length, "members, gold", party.gold);
  } catch (error) {
    console.log("party.info:", /no save loaded/.test(error.message) ? "n/a (title screen)" : `FAIL ${error.message}`);
  }

  // The state push should flow through host's onState handler.
  let pushed = null;
  host.setHandlers({ onState: (gameKey, state) => { if (gameKey === summary.gameKey) pushed = state; } });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  console.log("state push:", pushed ? `ok (gold=${pushed.gold})` : "MISSING");

  const unsupported = await host.send(summary.gameKey, "battle.info", {}).catch((e) => e.message);
  console.log("battle.info error:", unsupported);

  await host.stop(summary.pid);
  const ok = mine && mine.alive && catalog.total > 0 && pushed;
  console.log(ok ? "host-rgss: PASS" : "host-rgss: FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error("host-rgss: ERROR", error);
  process.exit(1);
});
