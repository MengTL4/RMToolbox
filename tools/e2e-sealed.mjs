// Live e2e smoke test for sealed-launcher games, mirroring tools/e2e-tauri.mjs.
//
//   1. Launch the game via the toolbox (node tools/rmch.mjs launch <gameRoot>)
//      and wait for the seeder to publish the engine + the bridge to connect.
//   2. node tools/e2e-sealed.mjs <gameRoot>
//
// Connects to the ws server's /client channel and drives every non-destructive
// bridge command against the running game, restoring game state after each
// mutation. Deliberately NOT wired into npm test — it needs the real game.
// Skipped as game-specific/dangerous: map.transfer*, scene.push/pop,
// game.repair, game.newGame, save.load (rolls back live progress).

import net from "node:net";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanGame } from "../core/scanner.mjs";
import { getToken } from "../core/token.mjs";
import { ensureServer } from "../core/launcher.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gameRoot = process.argv[2];
if (!gameRoot) {
  console.error("usage: e2e-sealed.mjs <gameRoot>");
  process.exit(2);
}
const scan = scanGame(gameRoot);
const PORT = 47412;
const TOKEN = getToken(projectRoot);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "ok" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
function assertEqual(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function serverReachable(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(1200, () => { socket.destroy(); resolve(false); });
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
  });
}

// Minimal /client ws client: send one command, await its result.
function makeClient() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/client?token=${encodeURIComponent(TOKEN)}`);
    const pending = new Map();
    let nextId = 1;
    socket.onopen = () => resolve({
      send(type, args, timeoutMs = 30000) {
        const id = nextId++;
        return new Promise((res, rej) => {
          const timer = setTimeout(() => { pending.delete(id); rej(new Error(`timeout: ${type}`)); }, timeoutMs);
          pending.set(id, { res, rej, timer });
          socket.send(JSON.stringify({ t: "send", id, gameKey: scan.gameKey, type, args: args || {} }));
        });
      },
      close() { try { socket.close(); } catch (_) {} }
    });
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch (_) { return; }
      if (message.t === "result" && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.res(message.payload);
        else entry.rej(new Error(message.error || "command failed"));
      }
    };
    socket.onerror = () => reject(new Error("client ws error"));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!scan.paths.exe) throw new Error(`game exe not found: ${scan.root}`);
  await ensureServer({ projectRoot, port: PORT, token: TOKEN });
  if (!await serverReachable(PORT)) throw new Error(`no ws server on ${PORT}`);

  const client = await makeClient();
  const send = client.send;

  // --- core / info ----------------------------------------------------------
  const ping = await send("ping");
  assertEqual("ping.bridgeVersion", ping.bridgeVersion, "0.4.0");

  const info = await send("runtime.info");
  assertEqual("runtime.info.title", info.engine && info.engine.title, scan.title);
  check("runtime.info.hooks", info.hooks && info.hooks.targets && info.hooks.targets.length >= 29,
    `targets=${info.hooks && info.hooks.targets.length} battle=${(info.hooks.targets || []).filter((t) => t.includes("BattleManager")).length}`);

  const scene = await send("scene.info");
  check("scene.info.current", !!scene.current, `current=${scene.current}`);

  const loc = await send("player.location");
  check("player.location", loc.mapId !== null && loc.mapId !== undefined, `mapId=${loc.mapId} x=${loc.x} y=${loc.y}`);

  // --- trainer options roundtrip --------------------------------------------
  await send("trainer.options.set", { expRate: 3, oneHitKill: true });
  const opts = await send("trainer.options.get");
  assertEqual("trainer.options.expRate", opts.options.expRate, 3);
  assertEqual("trainer.options.oneHitKill", opts.options.oneHitKill, true);
  await send("trainer.options.set", { expRate: 1, oneHitKill: false });

  // --- gold -------------------------------------------------------------------
  const party0 = await send("party.info");
  const gold0 = party0.gold;
  await send("gold.set", { value: 123456 });
  assertEqual("gold.set", (await send("party.info")).gold, 123456);
  await send("gold.add", { amount: -100000 });
  assertEqual("gold.add", (await send("party.info")).gold, 23456);
  await send("gold.set", { value: gold0 });

  // --- items ------------------------------------------------------------------
  await send("item.set", { kind: "item", id: 2, count: 3 });
  const inv = await send("item.list");
  check("item.list.contains", inv.entries.some((e) => e.kind === "item" && e.id === 2 && e.count === 3),
    JSON.stringify(inv.entries.slice(0, 3)));
  await send("item.set", { kind: "item", id: 2, count: 0 });
  const invAfter = await send("item.list");
  check("item.set.zero", !invAfter.entries.some((e) => e.kind === "item" && e.id === 2), "");

  // --- catalogs ----------------------------------------------------------------
  const catalog = await send("catalog.query", { kind: "item", query: "怪物" });
  check("catalog.item.query", catalog.total >= 1 && catalog.entries[0].name.includes("怪物"),
    `total=${catalog.total} name=${catalog.entries[0] && catalog.entries[0].name}`);
  check("catalog.item.icons", catalog.entries.some((e) => e.iconIndex !== null && e.iconIndex !== undefined),
    "iconIndex present");
  const skills = await send("catalog.query", { kind: "skill", limit: 5 });
  check("catalog.skill", skills.total >= 1, `total=${skills.total}`);
  const states = await send("catalog.query", { kind: "state", limit: 8 });
  check("catalog.state", states.total >= 1, `total=${states.total}`);

  // --- actor mutations (id from the current party) ----------------------------
  const actorId = party0.members[0].id;
  const actor0 = await send("actor.info", { id: actorId });
  assertEqual("actor.info.name", actor0.actor.name, party0.members[0].name);

  // Idle games gain exp/HP continuously, so exact-value roundtrips would race
  // with the game's own writes — assert directionally instead.
  const expFresh = (await send("actor.info", { id: actorId })).actor.exp;
  await send("actor.exp.add", { id: actorId, amount: 100 });
  const expUp = (await send("actor.info", { id: actorId })).actor.exp;
  await send("actor.exp.add", { id: actorId, amount: -100 });
  const expBack = (await send("actor.info", { id: actorId })).actor.exp;
  check("actor.exp.add roundtrip", expUp >= expFresh + 100 && expBack <= expUp,
    `fresh=${expFresh} up=${expUp} back=${expBack}`);

  await send("actor.param.add", { id: actorId, paramId: 0, value: 10 });
  const plusUp = (await send("actor.info", { id: actorId })).actor.paramPlus[0];
  await send("actor.param.add", { id: actorId, paramId: 0, value: -10 });
  const plusBack = (await send("actor.info", { id: actorId })).actor.paramPlus[0];
  check("actor.param.add roundtrip", plusUp === 10 && plusBack === 0, `up=${plusUp} back=${plusBack}`);

  // setHp clamps to mhp, so verify against a value inside the legal range.
  await send("actor.vitals.set", { id: actorId, hp: 1, mp: 1 });
  const vitals = (await send("actor.info", { id: actorId })).actor;
  check("actor.vitals.set", vitals.hp === 1 && vitals.mp === 1, `hp=${vitals.hp} mp=${vitals.mp}`);
  await send("actor.vitals.set", { id: actorId, hp: party0.members[0].hp, mp: party0.members[0].mp });

  await send("actor.recover", { id: actorId });
  const rec = (await send("actor.info", { id: actorId })).actor;
  check("actor.recover", rec.hp === rec.mhp && rec.mp === rec.mmp, `hp=${rec.hp}/${rec.mhp}`);

  await send("actor.name.set", { id: actorId, name: party0.members[0].name });
  check("actor.name.set", (await send("actor.info", { id: actorId })).actor.name === party0.members[0].name, "");
  await send("actor.nickname.set", { id: actorId, nickname: party0.members[0].nickname });
  check("actor.nickname.set", (await send("actor.info", { id: actorId })).actor.nickname === party0.members[0].nickname, "");

  // learn a skill the actor does not have, then forget it
  const owned = new Set(party0.members[0].skills.map((s) => s.id));
  const freeSkill = skills.entries.map((e) => e.id).find((id) => !owned.has(id));
  if (freeSkill) {
    await send("actor.skill.learn", { id: actorId, skillId: freeSkill });
    check("actor.skill.learn", (await send("actor.info", { id: actorId })).actor.skills.some((s) => s.id === freeSkill), `skill=${freeSkill}`);
    await send("actor.skill.forget", { id: actorId, skillId: freeSkill });
    check("actor.skill.forget", !(await send("actor.info", { id: actorId })).actor.skills.some((s) => s.id === freeSkill), "");
  } else {
    check("actor.skill.learn", true, "skipped — actor owns every listed skill");
  }

  // Pick a non-incapacitating state (id 1 is 战斗不能 and would KO the actor).
  const stateId = (states.entries.find((e) => e.id !== 1) || states.entries[0]).id;
  await send("actor.state.add", { id: actorId, stateId });
  check("actor.state.add", (await send("actor.info", { id: actorId })).actor.states.some((s) => s.id === stateId), `state=${stateId}`);
  await send("actor.state.remove", { id: actorId, stateId });
  check("actor.state.remove", !(await send("actor.info", { id: actorId })).actor.states.some((s) => s.id === stateId), "");
  await send("actor.recover", { id: actorId }); // undo any side effect the state had

  // --- party composition roundtrip ---------------------------------------------
  const spareActor = (await send("catalog.query", { kind: "actor", limit: 8 }))
    .entries.map((e) => e.id).find((id) => !party0.members.some((m) => m.id === id));
  if (spareActor) {
    await send("party.addActor", { id: spareActor });
    const joined = (await send("party.info")).members.some((m) => m.id === spareActor);
    await send("party.removeActor", { id: spareActor });
    const left = (await send("party.info")).members.some((m) => m.id === spareActor);
    check("party.addActor/removeActor", joined && !left, `actor=${spareActor} joined=${joined} left=${left}`);
  } else {
    check("party.addActor/removeActor", true, "skipped — no spare actor in catalog");
  }
  await send("party.recover", {});
  check("party.recover", true, "");

  // --- switches / variables ------------------------------------------------------
  const switchPage = await send("switch.list", { offset: 1, limit: 5 });
  check("switch.list", switchPage.entries.length === 5, `names=${switchPage.entries.map((e) => e.name).filter(Boolean).length}/5 named`);
  const varPage = await send("variable.list", { offset: 1, limit: 5 });
  check("variable.list", varPage.entries.length === 5, "");

  await send("switch.set", { id: 5, value: true });
  assertEqual("switch.set", (await send("switch.list", { offset: 5, limit: 1 })).entries[0].value, true);
  await send("switch.set", { id: 5, value: false });
  await send("variable.set", { id: 5, value: 777 });
  assertEqual("variable.set", (await send("variable.list", { offset: 5, limit: 1 })).entries[0].value, 777);
  await send("variable.set", { id: 5, value: 0 });

  // --- world ---------------------------------------------------------------------
  const maps = await send("map.list");
  check("map.list", maps.total >= 1, `total=${maps.total}`);
  const mapInfo = await send("map.info");
  check("map.info", mapInfo.mapId !== null, `mapId=${mapInfo.mapId}`);
  const events = await send("map.events.list");
  check("map.events.list", Array.isArray(events.entries) || typeof events.total === "number",
    `entries=${(events.entries || []).length} total=${events.total}`);
  await send("map.through.set", { value: true });
  assertEqual("map.through.set", (await send("map.through.set", { value: false })).through, false);

  // --- battle commands (no battle running: graceful no / clean error) --------------
  const battle = await send("battle.info");
  check("battle.info", typeof battle.inBattle === "boolean", `inBattle=${battle.inBattle}`);
  const kill = await send("battle.killEnemies", {}).catch((e) => e);
  check("battle.killEnemies outside battle", kill instanceof Error || (kill && kill.killed === 0),
    kill instanceof Error ? kill.message.slice(0, 80) : `killed=${kill.killed} remaining=${kill.remaining}`);

  // --- value locks ------------------------------------------------------------------
  await send("lock.set", { kind: "gold", value: 500 });
  await send("gold.set", { value: 999 });
  await sleep(1300); // the lock reasserts on the frame tick
  assertEqual("lock.gold.reasserts", (await send("party.info")).gold, 500);
  const lockList = await send("lock.list");
  check("lock.list", lockList.locks && lockList.locks.gold === 500, JSON.stringify(lockList.locks).slice(0, 80));
  await send("lock.clear", { kind: "gold" });
  await send("gold.set", { value: gold0 });

  // --- saves -------------------------------------------------------------------------
  const saves = await send("save.list");
  check("save.list", saves.entries.length >= 1, `dir=${path.basename(saves.dir)} n=${saves.entries.length}`);
  await send("save.save", { id: 20 });
  // MZ saveGame returns a promise and the bridge does not await it — the file
  // lands a moment later. Poll instead of stat-ing once.
  const saveFile = path.join(saves.dir, "file20.rmmzsave");
  let saveOk = false;
  for (let i = 0; i < 25 && !saveOk; i++) {
    saveOk = existsSync(saveFile);
    if (!saveOk) await sleep(200);
  }
  check("save.save", saveOk, saveOk ? `${statSync(saveFile).size} bytes` : "file20.rmmzsave never appeared");
  if (existsSync(saveFile)) {
    // The async write may still be in flight; wait for it to settle, then
    // remove and verify it stays gone.
    await sleep(1500);
    rmSync(saveFile);
    await sleep(700);
    if (existsSync(saveFile)) rmSync(saveFile);
    // The save wrote globalInfo too — rebuild it so no ghost slot stays in the game UI.
    await send("console.eval", { code: "DataManager.saveGlobalInfo && DataManager.saveGlobalInfo(); 'rebuilt'" });
    await sleep(300);
    const after = readdirSync(saves.dir).filter((n) => n === "file20.rmmzsave");
    check("save.cleanup", after.length === 0, "file20.rmmzsave removed and did not return");
  }

  // --- save-data tree (live in-memory path) --------------------------------------------
  const contents = await send("save.contents.get", { limitBytes: 20 * 1024 * 1024 });
  check("save.contents.get", contents.bytes > 1000 && (contents.keys || []).includes("party"),
    `${contents.bytes} bytes keys=${(contents.keys || []).join(",")}`);
  const applied = await send("save.contents.apply", { json: contents.json });
  check("save.contents.apply", applied.applied === true, `reloaded=${applied.reloaded}`);
  const identity = await send("console.eval", {
    code: "window.$gameParty === window.DataManager.makeSaveContents().party"
  });
  assertEqual("sealed.liveRefs.afterApply", identity.result, true);

  // --- console ---------------------------------------------------------------------------
  const evalSmoke = await send("console.eval", { code: "1 + 1" });
  assertEqual("console.eval", evalSmoke.result, 2);
  const battleMgr = await send("console.eval", { code: "typeof window.BattleManager.startBattle" });
  assertEqual("console.eval.BattleManager", battleMgr.result, "function");

  // --- icons -------------------------------------------------------------------------------
  const iconset = await send("assets.iconset", {}, 60000);
  check("assets.iconset", (iconset.dataUrl || "").length > 100000 && iconset.width > 0,
    `${(iconset.dataUrl || "").length} chars ${iconset.width}x${iconset.height}`);

  client.close();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("failed:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("e2e-sealed failed:", error.message);
  process.exit(1);
});
