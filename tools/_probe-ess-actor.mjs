// Launch the Essentials game and drive the actor-detail (party Pokemon)
// command family end-to-end: roster, info, recover, level/exp/vitals, move
// learn/forget, status add/remove, nickname. Mutates the live party but
// never saves.
//
//   node tools/_probe-ess-actor.mjs <gameRoot> [loadSlot]
import path from "node:path";
import { launchRgssGame } from "../core/rgss-launcher.mjs";

const gameRoot = process.argv[2];
const loadSlot = Number(process.argv[3] || 1);
const projectRoot = path.resolve(import.meta.dirname, "..");
const resolved = path.resolve(gameRoot);
const gameKey = path.basename(resolved).replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);

const handle = await launchRgssGame({ gameRoot: resolved, projectRoot, gameKey });
const { session } = handle;
console.log(`bridge: connected (${session.hello?.engine || "?"})`);

let failures = 0;
async function check(label, fn) {
  try {
    const out = await fn();
    console.log(`  ok ${label}${out ? "  " + out : ""}`);
    return out;
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${label}  ${error.message}`);
    return null;
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await check("save.load", async () => JSON.stringify(await session.send("save.load", { id: loadSlot }, 30000)));
await sleep(4000); // let Scene_Map settle

const roster = await check("catalog actor = party", async () => {
  const p = await session.send("catalog.query", { kind: "actor", limit: 20 }, 30000);
  if (!p.entries.length) throw new Error("empty roster");
  return p.entries.map((e) => `#${e.id} ${e.name} (${e.note})`).join(" | ");
});

await check("actor.info 1", async () => {
  const p = await session.send("actor.info", { id: 1 }, 30000);
  const a = p.actor;
  if (!a || !a.name) throw new Error("no actor payload");
  return `${a.name} (${a.className}) Lv.${a.level} hp=${a.hp}/${a.mhp} atk=${a.params?.[2]} moves=${(a.skills || []).map((m) => m.name).join("/")}`;
});

await check("actor.recover 1", async () => {
  const p = await session.send("actor.recover", { id: 1 }, 30000);
  if (p.actor.hp !== p.actor.mhp) throw new Error(`hp ${p.actor.hp}/${p.actor.mhp}`);
  return `hp=${p.actor.hp}/${p.actor.mhp}`;
});

const before = await session.send("actor.info", { id: 1 }, 30000).then((p) => p.actor).catch(() => null);
if (before) {
  // This game runs the Level Caps EX plugin: GameData::GrowthRate.max_level
  // IS the story level cap, so leveling past it legitimately clamps back.
  // Drive the level down and back up inside the cap instead.
  const down = Math.max(1, before.level - 1);
  await check(`actor.level.set ${down}`, async () => {
    const p = await session.send("actor.level.set", { id: 1, level: down }, 30000);
    if (p.actor.level !== down) throw new Error(`level=${p.actor.level}`);
    return `level=${p.actor.level} atk=${p.actor.params?.[2]}`;
  });
  await check(`actor.level.set back ${before.level}`, async () => {
    const p = await session.send("actor.level.set", { id: 1, level: before.level }, 30000);
    if (p.actor.level !== before.level) throw new Error(`level=${p.actor.level}`);
  });
}

await check("actor.vitals.set hp=1", async () => {
  const p = await session.send("actor.vitals.set", { id: 1, hp: 1 }, 30000);
  if (p.actor.hp !== 1) throw new Error(`hp=${p.actor.hp}`);
});
await check("actor.state.add BURN", async () => {
  const p = await session.send("actor.state.add", { id: 1, stateId: "BURN" }, 30000);
  if (!(p.actor.states || []).some((s) => s.id === "BURN")) throw new Error(JSON.stringify(p.actor.states));
  return JSON.stringify(p.actor.states);
});
await check("catalog state", async () => {
  const p = await session.send("catalog.query", { kind: "state", limit: 10 }, 30000);
  if (!p.entries.length) throw new Error("empty");
  return p.entries.map((e) => `${e.id}:${e.name}`).join(" | ");
});
await check("actor.state.remove", async () => {
  const p = await session.send("actor.state.remove", { id: 1 }, 30000);
  if ((p.actor.states || []).length) throw new Error(JSON.stringify(p.actor.states));
});
await check("actor.recover again", async () => {
  const p = await session.send("actor.recover", { id: 1 }, 30000);
  if (p.actor.hp !== p.actor.mhp) throw new Error(`hp=${p.actor.hp}`);
});

await check("actor.skill.learn on full moveset refuses", async () => {
  try {
    await session.send("actor.skill.learn", { id: 1, skillId: "TACKLE" }, 30000);
    throw new Error("should have raised");
  } catch (error) {
    if (/已满/.test(error.message)) return error.message;
    throw error;
  }
});
// 念力 = CONFUSION; drop it, learn TACKLE, then put the original moveset back.
await check("actor.skill.forget CONFUSION", async () => {
  const p = await session.send("actor.skill.forget", { id: 1, skillId: "CONFUSION" }, 30000);
  if ((p.actor.skills || []).some((m) => m.id === "CONFUSION")) throw new Error("still knows CONFUSION");
});
await check("actor.skill.learn TACKLE", async () => {
  const p = await session.send("actor.skill.learn", { id: 1, skillId: "TACKLE" }, 30000);
  if (!(p.actor.skills || []).some((m) => m.id === "TACKLE")) throw new Error(JSON.stringify(p.actor.skills));
  return (p.actor.skills || []).map((m) => m.name).join("/");
});
await check("actor.skill.forget TACKLE", async () => {
  const p = await session.send("actor.skill.forget", { id: 1, skillId: "TACKLE" }, 30000);
  if ((p.actor.skills || []).some((m) => m.id === "TACKLE")) throw new Error("still knows TACKLE");
});
await check("actor.skill.learn CONFUSION (restore)", async () => {
  const p = await session.send("actor.skill.learn", { id: 1, skillId: "CONFUSION" }, 30000);
  if (!(p.actor.skills || []).some((m) => m.id === "CONFUSION")) throw new Error(JSON.stringify(p.actor.skills));
});

await check("actor.name.set", async () => {
  const p = await session.send("actor.name.set", { id: 1, name: "测试昵称" }, 30000);
  if (p.actor.name !== "测试昵称") throw new Error(p.actor.name);
  await session.send("actor.name.set", { id: 1, name: before ? before.name : "" }, 30000);
});

await check("actor.info 9 refuses", async () => {
  try {
    await session.send("actor.info", { id: 9 }, 30000);
    throw new Error("should have raised");
  } catch (error) {
    if (/empty|greater/.test(error.message)) return error.message;
    throw error;
  }
});

handle.stop();
console.log(failures ? `ess-actor: FAIL (${failures})` : "ess-actor: PASS");
process.exit(failures ? 1 : 0);
