  // Native inventory adapters preserve each plugin's grant/removal behavior.
  // TH_ItemCore replaces the party's numeric containers with per-actor bags
  // and a warehouse. Keep the game's own grant/removal methods and its unique
  // equipment instances; the old _items/numItems API no longer describes it.
  function resolveCustomInventory(party) {
    // Some TH_ItemCore builds retain the encoded numeric containers but gate
    // every gainItem call behind a private flag. The normal game flow sets
    // this flag around its own grants; toolbox calls must do the same or the
    // method silently returns without touching _items. Recognise this shape
    // from the public methods and the gate reference in gainItem's wrapper.
    const encodedGainSource = party && typeof party.gainItem === "function" ?
      Function.prototype.toString.call(party.gainItem) : "";
    const encodedThInventory = encodedGainSource.includes("_GITHGT") ||
      (party && typeof party.newNumItems === "function" &&
       typeof party.thTyGetOnOver === "function" && Array.isArray(party._equipBaseRmPr));
    if (party && typeof party.gainItem === "function" &&
        typeof party.numItems === "function" && typeof party.items === "function" &&
        typeof party.weapons === "function" && typeof party.armors === "function" &&
        typeof party.thTyZhNumGain === "function" && typeof party.thTyZhNumGet === "function" &&
        encodedThInventory) {
      const manager = window.DataManager || {};
      const kinds = [["item", "items"], ["weapon", "weapons"], ["armor", "armors"]];
      const kindOf = (data) => {
        if (manager && typeof manager.isItem === "function" && manager.isItem(data)) return "item";
        if (manager && typeof manager.isWeapon === "function" && manager.isWeapon(data)) return "weapon";
        if (manager && typeof manager.isArmor === "function" && manager.isArmor(data)) return "armor";
        if (data && data.itypeId != null) return "item";
        if (data && data.wtypeId != null) return "weapon";
        if (data && data.atypeId != null) return "armor";
        throw new Error("游戏没有识别这个物品");
      };
      const isInstance = (data, kind = kindOf(data)) =>
        kind !== "item" && data && data.baseItemId != null && Number(data.baseItemId) !== Number(data.id);
      const count = (data) => {
        const kind = kindOf(data);
        if (!isInstance(data, kind) && kind !== "item" && typeof party.newNumItems === "function") {
          try {
            const aggregate = Number(party.newNumItems(data, false));
            if (Number.isFinite(aggregate)) return Math.max(0, aggregate);
          } catch (_) {}
        }
        return Math.max(0, Number(party.numItems(data)) || 0);
      };
      const rows = () => {
        const result = [], seen = new Set();
        for (const [kind, method] of kinds) {
          let list;
          try { list = party[method]() || []; } catch (_) { list = []; }
          for (const data of list) {
            if (!data || seen.has(data)) continue;
            seen.add(data);
            const amount = count(data);
            if (amount > 0) result.push({ kind, data, count: amount });
          }
        }
        return result;
      };
      return {
        count,
        entries() {
          return rows().map((row) => ({
            kind: row.kind, id: row.data.id, name: row.data.name || "",
            count: row.count, baseItemId: row.data.baseItemId || null
          }));
        },
        validateLock(data, value) {
          kindOf(data);
          if (!Number.isInteger(value) || value < 0 || value > 1000) {
            throw new Error("物品锁数量必须在 0 到 1000 之间");
          }
        },
        change(data, delta) {
          if (!Number.isInteger(delta) || Math.abs(delta) > 1000) {
            throw new Error("每次最多修改 1000 件物品");
          }
          if (!delta) return count(data);
          const kind = kindOf(data);
          const instance = isInstance(data, kind);
          if (delta > 0 && instance) {
            throw new Error("这是独立装备实例；添加装备时请选择基础装备目录");
          }
          const before = count(data);
          const invokeGain = (target, amount) => {
            const hadOwnGate = Object.prototype.hasOwnProperty.call(party, "_GITHGT");
            const oldGate = party._GITHGT;
            party._GITHGT = true;
            try {
              party.gainItem(target, amount);
            } finally {
              if (hadOwnGate) party._GITHGT = oldGate;
              else delete party._GITHGT;
            }
          };
          for (let step = 0; step < Math.abs(delta); step += 1) {
            const old = count(data);
            let target = data;
            if (delta < 0 && kind !== "item" && !instance) {
              const baseId = Number(data.id);
              const row = rows().find((candidate) => candidate.kind === kind &&
                Number(candidate.data.baseItemId || candidate.data.id) === baseId);
              if (!row) break;
              target = row.data;
            }
            invokeGain(target, delta > 0 ? 1 : -1);
            const actual = count(data);
            if (actual !== old + (delta > 0 ? 1 : -1)) {
              throw new Error(`游戏仅应用了部分变化：当前数量 ${actual}（原数量 ${before}）；请检查背包容量或物品类型限制`);
            }
          }
          return count(data);
        }
      };
    }

    if (!party || typeof party.newGetItem !== "function" || typeof party.thTyZhNumGain !== "function" ||
        typeof party.thTyZhNumGet !== "function" || !Array.isArray(party._tkCkItem) ||
        typeof party.members !== "function") return resolveIndependentInventory(party);

    const prefixes = { I: "item", W: "weapon", A: "armor" };
    function kindOf(data) {
      const manager = window.DataManager;
      if (manager.isItem(data)) return "item";
      if (manager.isWeapon(data)) return "weapon";
      if (manager.isArmor(data)) return "armor";
      // Removing a unique instance removes its database entry too. Its object
      // still describes the requested operation while the final count is read.
      if (data && data.wtypeId != null) return "weapon";
      if (data && data.atypeId != null) return "armor";
      if (data && data.itypeId != null) return "item";
      throw new Error("游戏没有识别这个物品");
    }
    function owners() {
      const list = [], seen = new Set();
      const add = actor => {
        if (actor && Array.isArray(actor._newItemList) && !seen.has(actor)) { seen.add(actor); list.push(actor); }
      };
      for (const actor of party.members()) {
        add(actor);
        const id = actor && typeof actor.actorId === "function" ? actor.actorId() : actor && actor._actorId;
        const pilot = party._cxJsId && party._cxJsId[id];
        const actors = window.$gameActors;
        if (pilot && actors && typeof actors.actor === "function") add(actors.actor(pilot));
      }
      return list;
    }
    function rows() {
      const result = [];
      const collect = (list, owner) => list.forEach((token, index) => {
        const match = /^([IWA])(\d+)$/.exec(String(token));
        if (!match) return;
        const kind = prefixes[match[1]], data = runtimeDataTable(kind)[Number(match[2])];
        if (data) result.push({ kind, data, owner, index, list });
      });
      for (const actor of owners()) collect(actor._newItemList, actor);
      collect(party._tkCkItem, null);
      return result;
    }
    function matches(row, data, kind) {
      if (row.kind !== kind) return false;
      if (data.baseItemId && Number(data.baseItemId) !== Number(data.id)) return row.data.id === data.id;
      return Number(row.data.baseItemId || row.data.id) === Number(data.id);
    }
    function count(data) {
      const kind = kindOf(data);
      return rows().filter(row => matches(row, data, kind)).length;
    }
    return {
      count,
      validateLock(data, value) {
        if (kindOf(data) !== "item" || data.baseItemId && Number(data.baseItemId) !== Number(data.id) || data.meta && data.meta.tkPaoDang) {
          throw new Error("独立装备和炮弹暂不支持数量锁；普通背包物品可以锁定");
        }
        if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error("这个游戏的物品锁数量必须在 0 到 1000 之间");
      },
      entries() {
        const grouped = new Map();
        for (const row of rows()) {
          const key = row.kind + ":" + row.data.id;
          if (!grouped.has(key)) grouped.set(key, { kind: row.kind, id: row.data.id,
            name: row.data.name || "", count: 0, baseItemId: row.data.baseItemId || null });
          grouped.get(key).count += 1;
        }
        const order = ["item", "weapon", "armor"];
        return Array.from(grouped.values()).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.id - b.id);
      },
      change(data, delta) {
        if (!Number.isInteger(delta) || Math.abs(delta) > 1000) throw new Error("这个游戏每次最多修改 1000 件物品");
        if (!delta) return count(data);
        if (data.meta && data.meta.tkPaoDang) throw new Error("炮弹使用独立弹仓规则，暂不支持按普通背包数量修改");
        const kind = kindOf(data), before = count(data);
        if (delta > 0 && data.baseItemId && Number(data.baseItemId) !== Number(data.id)) {
          throw new Error("这是独立装备实例；添加装备时请选择基础装备目录");
        }
        if (delta < 0 && rows().some(row => matches(row, data, kind) && row.data.id !== data.id)) {
          throw new Error("这件基础装备对应独立实例；请从当前物品中选择具体实例删除，避免丢失改造数据");
        }
        for (let step = 0; step < Math.abs(delta); step += 1) {
          const old = count(data);
          if (delta > 0) party.newGetItem(data, 1);
          else {
            const row = rows().find(row => matches(row, data, kind));
            if (!row) break;
            if (row.owner) party.gainItem(row.data, -1, false, row.owner);
            else row.list.splice(row.index, 1); // same operation as the native warehouse UI
          }
          const actual = count(data);
          if (actual !== old + (delta > 0 ? 1 : -1)) {
            throw new Error(`游戏仅应用了部分变化：当前数量 ${actual}（原数量 ${before}）；请检查背包、仓库容量或游戏物品规则`);
          }
        }
        return count(data);
      }
    };
  }

  function resolveIndependentInventory(party) {
    const manager = window.DataManager;
    if (!party || typeof party.gainIndependentItem !== "function" ||
        !manager || typeof manager.isIndependent !== "function") return null;
    const kinds = [["item", "items"], ["weapon", "weapons"], ["armor", "armors"]];
    const instance = data => data && data.baseItemId != null && String(data.baseItemId) !== String(data.id);
    function rows() {
      const result = [];
      for (const [kind, method] of kinds) {
        if (typeof party[method] !== "function") continue;
        for (const data of party[method]() || []) {
          if (!data) continue;
          const count = Number(party.numItems(data)) || 0;
          if (count > 0) result.push({ kind, data, count });
        }
      }
      return result;
    }
    function count(data) {
      if (instance(data) || !manager.isIndependent(data)) return Number(party.numItems(data)) || 0;
      const kind = manager.isWeapon(data) ? "weapon" : manager.isArmor(data) ? "armor" : "item";
      return rows().filter(row => row.kind === kind && String(row.data.baseItemId || row.data.id) === String(data.id))
        .reduce((total, row) => total + row.count, 0);
    }
    return {
      count,
      entries: () => rows().map(row => ({kind: row.kind, id: row.data.id, name: row.data.name || "",
        count: row.count, baseItemId: row.data.baseItemId || null})),
      validateLock(data, value) {
        if (manager.isIndependent(data) && data.baseItemId != null && String(data.baseItemId) !== String(data.id) && value > 1) {
          throw new Error("独立装备实例只能锁定为 0 或 1 件");
        }
        if (!Number.isInteger(value) || value < 0 || value > 1000) throw new Error("物品锁数量必须在 0 到 1000 之间");
      },
      change(data, delta) {
        if (!Number.isInteger(delta) || Math.abs(delta) > 1000) throw new Error("每次最多修改 1000 件物品");
        if (delta > 0 && instance(data)) throw new Error("这是独立装备实例；添加装备时请选择基础装备目录");
        const kind = manager.isWeapon(data) ? "weapon" : manager.isArmor(data) ? "armor" : "item";
        const before = count(data);
        if (delta < 0 && manager.isIndependent(data) && !instance(data)) {
          // A base weapon/armor has no native numeric container. Remove actual
          // owned instances one at a time so the game's own instance metadata
          // and equipment bookkeeping remain intact.
          for (let step = 0; step < -delta; step += 1) {
            const row = rows().find(candidate => candidate.kind === kind &&
              String(candidate.data.baseItemId || candidate.data.id) === String(data.id));
            if (!row) break;
            party.gainItem(row.data, -1);
          }
        } else if (delta) party.gainItem(data, delta);
        const actual = count(data);
        if (actual !== Math.max(0, before + delta)) throw new Error(`游戏仅应用了部分变化：当前数量 ${actual}（原数量 ${before}）`);
        return actual;
      }
    };
  }
