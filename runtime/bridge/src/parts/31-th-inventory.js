  // TH_ItemCore replaces the party's numeric containers with per-actor bags
  // and a warehouse. Keep the game's own grant/removal methods and its unique
  // equipment instances; the old _items/numItems API no longer describes it.
  function resolveCustomInventory(party) {
    if (!party || typeof party.newGetItem !== "function" || typeof party.thTyZhNumGain !== "function" ||
        typeof party.thTyZhNumGet !== "function" || !Array.isArray(party._tkCkItem) ||
        typeof party.members !== "function") return null;

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
