// M2 acceptance driver: launch a game through the same code path the GUI uses
// (launcher.launchGame -> GUI's bridge server on 127.0.0.1:47412), then drive
// the full command suite over the server's /client channel exactly like the
// GUI panel does. Prints one [OK]/[FAIL] line per check and exits non-zero if
// any core check fails.
//
//   node tools/m2-acceptance.mjs <gameRoot> [--keep]   (--keep: don't kill the game)

import { spawn, execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGame } from "../core/scanner.mjs";
import { getToken } from "../core/token.mjs";
import { launchGame } from "../core/launcher.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 47412;

const keep = process.argv.includes("--keep");
const gameRootArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
if (!gameRootArg) {
  console.error("usage: node tools/m2-acceptance.mjs <gameRoot> [--keep]");
  process.exit(2);
}

// --- client channel -----------------------------------------------------------

const token = getToken(projectRoot);

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/client?token=${encodeURIComponent(token)}`);
    const pending = new Map();
    let listResolver = null;
    socket.onopen = () => resolve({
      socket,
      list() {
        return new Promise((res, rej) => {
          listResolver = { res, rej };
          socket.send(JSON.stringify({ t: "list" }));
          setTimeout(() => rej(new Error("list timed out")), 8000);
        });
      },
      send(gameKey, type, args, timeoutMs = 25000) {
        return new Promise((res, rej) => {
          const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
          pending.set(id, { res, rej });
          socket.send(JSON.stringify({ t: "send", id, gameKey, type, args: args || {} }));
          setTimeout(() => {
            if (pending.delete(id)) rej(new Error(`${type} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
      }
    });
    socket.onerror = () => reject(new Error("cannot connect to the RMCH server"));
    socket.onmessage = (event) => {
      let message = null;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.t === "list" && listResolver) {
        const { res } = listResolver;
        listResolver = null;
        res(message.sessions);
      } else if (message.t === "result") {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.ok) entry.res(message.payload);
          else entry.rej(new Error(message.error || "command failed"));
        }
      }
    };
  });
}

// --- check runner --------------------------------------------------------------

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "[OK]  " : "[FAIL]"} ${name}${detail ? " — " + detail : ""}`);
}

// Run one check step; a throw (bridge error / timeout) becomes a FAIL instead
// of aborting the whole suite.
async function step(name, fn) {
  try {
    return await fn();
  } catch (error) {
    check(name, false, String(error.message || error));
    return null;
  }
}

// L1/L2 games load (and decrypt) their databases slowly: the bridge connects
// long before the data layer is usable. Probe with the bridge's own catalog
// command — it goes through the alias resolver, so it also works on protected
// games where bare $dataItems isn't a global.
async function waitDataReady(client, gameKey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const probe = await client.send(gameKey, "catalog.query", { kind: "item", limit: 1 }, 15000);
      if (probe && probe.total > 0) return true;
    } catch (_) {}
    await sleep(2000);
  }
  return false;
}

function summarize(detail) {
  const text = JSON.stringify(detail);
  return text && text.length > 140 ? `${text.slice(0, 140)}…` : (text || "");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitBridge(client, gameKey, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let sessions = [];
    try { sessions = await client.list(); } catch (_) {}
    const session = sessions.find((entry) => entry.gameKey === gameKey);
    if (session && session.alive !== false) return session;
    await sleep(1000);
  }
  return null;
}

// --- main ----------------------------------------------------------------------

const scan = scanGame(gameRootArg);
console.log(`\n=== M2 acceptance: ${scan.title} ===`);
console.log(`engine=${scan.engine.id} protection=L${scan.protection.level} key=${scan.gameKey}`);

const summary = await launchGame({ gameRoot: scan.root, projectRoot, port: PORT });
console.log(`launched: strategy=${summary.strategy} pid=${summary.pid}`);

const client = await connectClient();
const session = await waitBridge(client, summary.gameKey, 90000);
check("bridge connects to GUI server", !!session, session
  ? `v${session.bridgeVersion || "?"} engine=${session.engine ? session.engine.maker : "?"}`
  : "session never appeared in /client list");

if (!session) {
  console.error("\nresult: FAILED (bridge never connected)");
  process.exit(1);
}

// -- data-layer commands (work from the title screen)
const dataReady = await waitDataReady(client, summary.gameKey, 150000);
check("data layer ready ($dataSystem/$dataItems loaded)", dataReady, dataReady ? "" : "timed out after 90s");

const state = await step("ping / state snapshot", async () => {
  const payload = await client.send(summary.gameKey, "ping", {});
  check("ping / state snapshot", !!payload && !!payload.engine, summarize({ engine: payload.engine, map: payload.map, gold: payload.gold, party: (payload.party || []).length }));
  return payload;
});

await step("runtime.info", async () => {
  const runtime = await client.send(summary.gameKey, "runtime.info", {});
  check("runtime.info", !!runtime && !!runtime.bridgeVersion, summarize(runtime));
});

let options = null;
await step("trainer.options.get", async () => {
  options = (await client.send(summary.gameKey, "trainer.options.get", {})).options;
  check("trainer.options.get", !!options && typeof options.invincible === "boolean", `invincible=${options.invincible}`);
});

await step("trainer.options.set", async () => {
  const result = (await client.send(summary.gameKey, "trainer.options.set", { options: { invincible: true, expRate: 2 } })).options;
  check("trainer.options.set", result.invincible === true && result.expRate === 2, summarize({ invincible: result.invincible, expRate: result.expRate }));
  await client.send(summary.gameKey, "trainer.options.set", { options: { invincible: false, expRate: 1 } });
});

let catalog = null;
await step("catalog.query items", async () => {
  catalog = await client.send(summary.gameKey, "catalog.query", { kind: "item", limit: 3 });
  check("catalog.query items", catalog.total > 0 && catalog.entries.length > 0,
    `total=${catalog.total} first=#${catalog.entries[0] && catalog.entries[0].id} "${catalog.entries[0] && catalog.entries[0].name}"`);
});

await step("switch.list", async () => {
  const switches = await client.send(summary.gameKey, "switch.list", { offset: 1, limit: 3 });
  check("switch.list", Array.isArray(switches.entries), `count=${switches.entries.length}`);
});

await step("map.list", async () => {
  const maps = await client.send(summary.gameKey, "map.list", {});
  check("map.list", maps.total > 0, `total=${maps.total}`);
});

await step("save.list", async () => {
  const saves = await client.send(summary.gameKey, "save.list", {});
  check("save.list", !!saves.dir, `dir=${saves.dir} files=${(saves.entries || []).length}`);
});

await step("console.eval", async () => {
  const evalResult = await client.send(summary.gameKey, "console.eval", { code: "6*7" });
  check("console.eval", evalResult.result === 42, `6*7=${evalResult.result}`);
});

// -- in-game commands (need $gameParty; bootstrap otherwise)
// Preferred: start a new game (non-destructive). Some games' plugins can't
// initialize through the raw setupNewGame path (YEP class-base-params and
// similar read data the title screen normally prepares), so fall back to
// loading an existing save slot — in-memory only, nothing is written back.
async function partyMemberCount() {
  try {
    const info = await client.send(summary.gameKey, "party.info", {}, 15000);
    return (info.members || []).length;
  } catch (_) {
    return 0;
  }
}

if (!((state && state.party) || []).length) {
  console.log("no party yet — entering the game (game.newGame / save.load)");
  await step("enter game (new game or save load)", async () => {
    try {
      await client.send(summary.gameKey, "game.newGame", {});
    } catch (error) {
      console.log(`  new-game path failed (${String(error.message).slice(0, 80)}…), trying save load`);
    }
    await sleep(6000);
    if (await partyMemberCount()) return;

    // Collect save slot ids from the bridge's save.list (file naming varies:
    // file1.rpgsave, TCLH1.rpgsave, ... — config/global carry no slot number).
    const saveIds = [];
    try {
      const saves = await client.send(summary.gameKey, "save.list", {});
      for (const entry of saves.entries || []) {
        const match = entry.name.match(/(\d+)\.rpgsave$/i);
        if (match) saveIds.push(parseInt(match[1], 10));
      }
      saveIds.sort((a, b) => a - b);
    } catch (_) {}
    for (const saveId of [...new Set(saveIds)].slice(0, 3)) {
      try {
        await client.send(summary.gameKey, "save.load", { id: saveId });
      } catch (_) {}
      await sleep(6000);
      if (await partyMemberCount()) return;
    }
    if (!(await partyMemberCount())) {
      throw new Error(`party still empty after new-game and save-load attempts (slots tried: ${[...new Set(saveIds)].slice(0, 3).join(", ") || "none"})`);
    }
  });
}

const party = await step("party.info", async () => {
  const payload = await client.send(summary.gameKey, "party.info", {});
  check("party.info", (payload.members || []).length > 0,
    (payload.members || []).map((m) => `#${m.id} ${m.name} Lv${m.level}`).join(", ") || "empty party");
  return payload;
});

if (party && (party.members || []).length > 0) {
  await step("gold.set", async () => {
    const gold = await client.send(summary.gameKey, "gold.set", { value: 123456 });
    check("gold.set", gold.gold === 123456, `gold=${gold.gold}`);
  });

  await step("item.add", async () => {
    const firstItem = catalog && catalog.entries[0];
    if (!firstItem) return check("item.add", false, "no catalog entry available");
    const item = await client.send(summary.gameKey, "item.add", { kind: "item", id: firstItem.id, amount: 2 });
    check("item.add", item.ok !== false && item.id === firstItem.id, `+${item.amount} item#${item.id} "${firstItem.name}"`);
  });

  await step("actor.vitals.set", async () => {
    const actor = party.members[0];
    const vitals = await client.send(summary.gameKey, "actor.vitals.set", { id: actor.id, hp: actor.mhp, mp: actor.mmp, tp: 100 });
    check("actor.vitals.set", vitals.actor && vitals.actor.hp === actor.mhp, `#${actor.id} hp=${vitals.actor.hp}/${vitals.actor.mhp}`);
  });

  await step("switch.set", async () => {
    const sw = await client.send(summary.gameKey, "switch.set", { id: 1, value: true });
    check("switch.set", sw.value === true, `#1=${sw.value}`);
  });

  await step("live state reflects edits", async () => {
    const state2 = await client.send(summary.gameKey, "ping", {});
    check("live state reflects edits", state2.gold === 123456, `gold=${state2.gold}`);
  });
}

// -- teardown
if (!keep) {
  await new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(summary.pid), "/T", "/F"], () => resolve());
  });
  // The server can take up to ~25s to notice (ping interval + pong timeout),
  // so poll for the session to disappear instead of sampling once.
  let gone = false;
  let lastCount = -1;
  for (let attempt = 0; attempt < 15 && !gone; attempt += 1) {
    await sleep(2000);
    try {
      const sessions = await client.list();
      lastCount = sessions.length;
      gone = !sessions.some((entry) => entry.gameKey === summary.gameKey && entry.alive !== false);
    } catch (_) {}
  }
  check("game stopped, session closed", gone, gone ? "" : `session still listed (${lastCount} total)`);
  try { client.socket.close(); } catch (_) {}
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\nresult: ${failed.length ? `FAILED (${failed.length}/${results.length})` : `PASSED (${results.length}/${results.length})`}\n`);
process.exit(failed.length ? 1 : 0);
