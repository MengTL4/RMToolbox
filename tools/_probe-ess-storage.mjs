// Launch the Essentials game and drive the storage round-trip end-to-end:
// roster lists boxed Pokemon, party.removeActor stores a member into a box,
// party.addActor withdraws it back, and actor.info works on boxed ids.
// Mutates the live party/storage but never saves.
//
//   node tools/_probe-ess-storage.mjs <gameRoot> [loadSlot]
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
const roster = () => session.send("catalog.query", { kind: "actor", limit: 20000 }, 30000);
const partySize = () => session.send("party.info", {}, 30000).then((p) => p.members.length);

await check("save.load", async () => JSON.stringify(await session.send("save.load", { id: loadSlot }, 30000)));
await sleep(4000); // let Scene_Map settle

const before = await check("roster lists party + boxes", async () => {
  const p = await roster();
  const party = p.entries.filter((e) => e.id < 1000);
  const boxed = p.entries.filter((e) => e.id >= 1000);
  if (!party.length) throw new Error("empty party");
  return `party=${party.length} boxed=${boxed.length}`;
});
const size0 = await partySize();
const boxed0 = (await roster()).entries.filter((e) => e.id >= 1000);

if (boxed0.length) {
  const first = boxed0[0];
  await check(`boxed entry carries box number (#${first.id} ${first.name})`, async () => {
    if (!first.box) throw new Error("no box field: " + JSON.stringify(first));
    return `box=${first.box} note=${first.note}`;
  });
  await check("actor.info on boxed id", async () => {
    const p = await session.send("actor.info", { id: first.id }, 30000);
    if (!p.actor || p.actor.id !== first.id) throw new Error(JSON.stringify(p.actor && p.actor.id));
    return `${p.actor.name} (${p.actor.className}) Lv.${p.actor.level}`;
  });
}

// Round-trip: store party member #2, then withdraw it back.
if (size0 >= 2) {
  const name2 = (await session.send("party.info", {}, 30000)).members[1].name;
  await check(`party.removeActor 2 (${name2})`, async () => {
    await session.send("party.removeActor", { id: 2 }, 30000);
    const n = await partySize();
    if (n !== size0 - 1) throw new Error(`party ${size0} -> ${n}`);
    return `party ${size0} -> ${n}`;
  });
  const stored = await check("stored member appears in roster as boxed", async () => {
    const boxed = (await roster()).entries.filter((e) => e.id >= 1000);
    const hit = boxed.find((e) => e.name === name2 && !boxed0.some((b) => b.id === e.id));
    if (!hit) throw new Error("not found: " + JSON.stringify(boxed.map((b) => b.name)));
    return hit;
  });
  if (stored) {
    await check("actor.info on the freshly stored id", async () => {
      const p = await session.send("actor.info", { id: stored.id }, 30000);
      if (!p.actor || p.actor.id !== stored.id || p.actor.name !== name2) {
        throw new Error(JSON.stringify(p.actor && { id: p.actor.id, name: p.actor.name }));
      }
      return `${p.actor.name} (${p.actor.className}) Lv.${p.actor.level} hp=${p.actor.hp}/${p.actor.mhp}`;
    });
    await check(`party.addActor ${stored.id} withdraws`, async () => {
      const p = await session.send("party.addActor", { id: stored.id }, 30000);
      const n = await partySize();
      if (n !== size0) throw new Error(`party -> ${n}`);
      if (!p.actor || p.actor.name !== name2) throw new Error("withdrew " + (p.actor && p.actor.name));
      return `${p.actor.name} -> party slot ${p.id}`;
    });
    await check("roster back to original shape", async () => {
      const boxed = (await roster()).entries.filter((e) => e.id >= 1000);
      if (boxed.length !== boxed0.length) throw new Error(`boxed ${boxed0.length} -> ${boxed.length}`);
    });
  }
} else {
  await check("party.removeActor refuses to empty the party", async () => {
    try {
      await session.send("party.removeActor", { id: 1 }, 30000);
      throw new Error("should have raised");
    } catch (error) {
      if (/至少/.test(error.message)) return error.message;
      throw error;
    }
  });
}

await check("party.addActor on a party id refuses", async () => {
  try {
    await session.send("party.addActor", { id: 1 }, 30000);
    throw new Error("should have raised");
  } catch (error) {
    if (/存储箱/.test(error.message)) return error.message;
    throw error;
  }
});
await check("party.removeActor on a boxed id refuses", async () => {
  try {
    await session.send("party.removeActor", { id: 1003 }, 30000);
    throw new Error("should have raised");
  } catch (error) {
    if (/队伍里/.test(error.message)) return error.message;
    throw error;
  }
});
await check("party.addActor on an empty box slot refuses", async () => {
  try {
    await session.send("party.addActor", { id: 999000 }, 30000);
    throw new Error("should have raised");
  } catch (error) {
    if (/空的|invalid/.test(error.message)) return error.message;
    throw error;
  }
});

// --- createPokemon (debug-menu code path) --------------------------------------
const dexEntry = await check("catalog enemy = species dex", async () => {
  const p = await session.send("catalog.query", { kind: "enemy", limit: 5 }, 30000);
  if (!p.entries.length) throw new Error("empty dex");
  return p.entries[0];
});
if (dexEntry) {
  const sizeNow = await partySize();
  await check(`party.createPokemon ${dexEntry.id} -> party`, async () => {
    const p = await session.send("party.createPokemon", { species: dexEntry.id, level: 5 }, 30000);
    if (p.where !== "party" || !p.actor) throw new Error(JSON.stringify({ where: p.where, id: p.id }));
    const n = await partySize();
    if (n !== sizeNow + 1) throw new Error(`party ${sizeNow} -> ${n}`);
    return `${p.actor.name} Lv.${p.actor.level} slot ${p.id} (party ${sizeNow} -> ${n})`;
  });
  await check("party.createPokemon with full party -> box", async () => {
    const p = await session.send("party.createPokemon", { species: dexEntry.id, level: 5 }, 30000);
    if (p.where !== "box" || !(p.id >= 1000)) throw new Error(JSON.stringify({ where: p.where, id: p.id }));
    return `${p.actor.name} -> box slot #${p.id}`;
  });
  await check("created pair visible in roster", async () => {
    const boxed = (await roster()).entries.filter((e) => e.id >= 1000);
    if (!boxed.some((e) => e.name === dexEntry.name)) throw new Error("not in roster");
    return `boxed=${boxed.length}`;
  });
}
await check("party.createPokemon bogus species refuses", async () => {
  try {
    await session.send("party.createPokemon", { species: "NOTAREALMON", level: 5 }, 30000);
    throw new Error("should have raised");
  } catch (error) {
    if (/未知物种/.test(error.message)) return error.message;
    throw error;
  }
});

handle.stop();
console.log(failures ? `ess-storage: FAIL (${failures})` : "ess-storage: PASS");
process.exit(failures ? 1 : 0);
