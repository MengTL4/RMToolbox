// Supplementary native checks missing from the original 105-check pass.
import assert from "node:assert/strict";
export async function extra({ send, ev, test, blocked, sleep }) {
  const native = (code) =>
    ev(
      `(function(){var t=window.TK&&TK.$;var p=t&&t.gameParty?t.gameParty():window.$gameParty,c=t&&t.dataClasses?t.dataClasses():window.$dataClasses,ce=t&&t.dataCommonEvents?t.dataCommonEvents():window.$dataCommonEvents,sw=t&&t.gameSwitches?t.gameSwitches():window.$gameSwitches,sys=t&&t.dataSystem?t.dataSystem():window.$dataSystem;return eval(${JSON.stringify(code)});})()`
    );
  const original = (await send("party.info")).members.map((a) => a.id);
  const catalog = (await send("catalog.query", { kind: "actor", limit: 20000 }))
    .entries;
  // This native game's first database actors are vehicles; Jack is its normal
  // second walking companion. Vehicle ownership is not ordinary party membership.
  const vehicleParty = await native(
    "!!(p&&Array.isArray(p._pats)&&c&&c.length)"
  );
  const spare =
    vehicleParty && catalog.some((a) => a.id === 32 && a.name === "杰克")
      ? catalog.find((a) => a.id === 32)
      : catalog.find((a) => a.name && !original.includes(a.id));
  if (spare)
    await test("extra party add/remove native membership", async () => {
      try {
        await send("party.addActor", { id: spare.id });
        assert.ok(
          (await send("party.info")).members.some((a) => a.id === spare.id)
        );
      } finally {
        await send("party.removeActor", { id: spare.id });
      }
      assert.deepEqual(
        (await send("party.info")).members.map((a) => a.id),
        original
      );
    });
  else blocked("extra party add/remove native membership", "no unowned actor");
  {
    const id = original[0],
      before = (await send("actor.info", { id })).actor;
    const target = await native(
      `(function(){var entry=c&&c.filter(function(x){return x&&x.name&&x.id!==${before.classId}})[0];return entry&&entry.id})()`
    );
    if (!target)
      blocked(
        "extra actor class change and restore",
        "no alternate native class"
      );
    else
      await test("extra actor class change and restore", async () => {
        try {
          await send("actor.class.set", { id, classId: target, keepExp: true });
          assert.equal(
            (await send("actor.info", { id })).actor.classId,
            target
          );
        } finally {
          await send("actor.class.set", {
            id,
            classId: before.classId,
            keepExp: true
          });
        }
        assert.equal(
          (await send("actor.info", { id })).actor.classId,
          before.classId
        );
      });
  }
  await test("extra self switch set/list/restore", async () => {
    const map = await send("map.inspect"),
      event = map.events?.find((e) => e.eventId > 0);
    assert.ok(event, "map has no event");
    const args = { mapId: map.mapId, eventId: event.eventId, letter: "D" };
    const before =
      (await send("selfSwitch.list", { mapId: map.mapId })).entries.find(
        (e) => e.eventId === args.eventId && e.letter === "D"
      )?.value || false;
    try {
      await send("selfSwitch.set", { ...args, value: !before });
      const row = (
        await send("selfSwitch.list", { mapId: map.mapId })
      ).entries.find((e) => e.eventId === args.eventId && e.letter === "D");
      assert.equal(row?.value || false, !before);
    } finally {
      await send("selfSwitch.set", { ...args, value: before });
    }
  });
  await test("extra lock replace native enforcement", async () => {
    const old = (await send("lock.list")).locks,
      gold = (await send("party.info")).gold;
    try {
      await send("lock.replace", { locks: { ...old, gold: 731 } });
      await send("gold.set", { value: 123 });
      await sleep(1100);
      assert.equal((await send("party.info")).gold, 731);
    } finally {
      await send("lock.replace", { locks: old });
      await send("gold.set", { value: gold });
    }
  });
  for (const kind of ["item", "weapon", "armor"]) {
    const entries = (await send("catalog.query", { kind, limit: 20000 }))
      .entries;
    const preferred =
      kind === "item"
        ? null
        : await native(
            `(function(){var table=t&&t.data${kind === "weapon" ? "Weapons" : "Armors"}?t.data${kind === "weapon" ? "Weapons" : "Armors"}():window.$data${kind === "weapon" ? "Weapons" : "Armors"};var e=table&&table.find(function(x){return x&&x.name&&Number(x.${kind === "weapon" ? "wtypeId" : "atypeId"})>0&&!(x.meta&&x.meta['Affix Item Set']);});return e&&e.id})()`
          ).catch(() => null);
    const entry =
      entries.find((x) => x.id === preferred) ||
      entries.find((x) => x.name && x.id > 1);
    if (!entry) {
      blocked(
        "extra " + kind + " quantity lock enforcement",
        "no catalog entry"
      );
      continue;
    }
    // A quantity lock can only constrain an inventory record that already
    // exists.  Seed one through the normal toolbox path when the copied save
    // has no instance, then remove that disposable seed after the probe.
    const matches = (x) =>
      x.kind === kind && (x.id === entry.id || x.baseItemId === entry.id);
    const count = () =>
      send("item.list").then((r) =>
        r.entries.filter(matches).reduce((n, x) => n + x.count, 0)
      );
    const originalCount = await count();
    let seeded = false;
    if (originalCount === 0) {
      try {
        await send("item.set", { kind, id: entry.id, count: 1 });
      } catch {}
      if ((await count()) === 0) {
        blocked(
          "extra " + kind + " quantity lock enforcement",
          "no owned inventory record for selected catalog entry"
        );
        continue;
      }
      seeded = true;
    }
    try {
      await test("extra " + kind + " quantity lock enforcement", async () => {
        const old = (await send("lock.list")).locks;
        let accepted = false;
        const before = await count();
        try {
          await send("lock.set", { kind, id: entry.id, value: 3 });
          accepted = true;
          await send("item.set", { kind, id: entry.id, count: 1 });
          await sleep(1100);
          assert.equal(await count(), 3);
        } finally {
          await send("lock.replace", { locks: old });
          if (accepted)
            await send("item.set", { kind, id: entry.id, count: before });
        }
      });
    } finally {
      if (seeded)
        await send("item.set", {
          kind,
          id: entry.id,
          count: originalCount
        }).catch(() => {});
    }
  }
  await test("extra native transfer and return", async () => {
    const loc = await send("player.location"),
      map = await send("map.inspect");
    await send("map.transfer", {
      mapToken: map.mapToken,
      mapId: loc.mapId,
      x: loc.x,
      y: loc.y,
      direction: loc.direction,
      fade: 2
    });
    await sleep(1500);
    const after = await send("player.location");
    assert.equal(after.mapId, loc.mapId);
    assert.equal(after.x, loc.x);
    assert.equal(after.y, loc.y);
  });
  await test("extra transfer to event and restore position", async () => {
    const loc = await send("player.location"),
      events = (await send("map.events.list")).entries,
      event = events.find((e) => e.eventId > 0);
    assert.ok(event);
    try {
      await send("map.transferToEvent", { eventId: event.eventId });
      const now = await send("player.location");
      assert.equal(now.x, event.x);
      assert.equal(now.y, event.y);
    } finally {
      const map = await send("map.inspect");
      await send("map.move", {
        mapToken: map.mapToken,
        x: loc.x,
        y: loc.y,
        force: true,
        confirmed: true
      });
    }
  });
  await test("extra common event reserve executes natively", async () => {
    const spec = await native(
      "({id:ce.length,sw:sys.switches.length-1,value:sw.value(sys.switches.length-1)})"
    );
    try {
      await native(
        `ce.push({id:${spec.id},name:'RMCH native reservation probe',trigger:0,switchId:1,list:[{code:121,indent:0,parameters:[${spec.sw},${spec.sw},${spec.value ? 1 : 0}]},{code:0,indent:0,parameters:[]}]});true`
      );
      const map = await send("map.inspect"),
        plan = await send("events.steps", {
          mapToken: map.mapToken,
          id: spec.id
        });
      await send("events.preview", {
        mapToken: map.mapToken,
        id: spec.id,
        start: 0,
        whole: true,
        revision: plan.whole.revision
      });
      await send("commonEvent.run", {
        mapToken: map.mapToken,
        id: spec.id,
        start: 0,
        revision: plan.whole.revision
      });
      let actual;
      for (let n = 0; n < 40; n++) {
        await sleep(100);
        actual = await native(`sw.value(${spec.sw})`);
        if (actual !== spec.value) break;
      }
      assert.equal(actual, !spec.value);
    } finally {
      await native(
        `ce.length=${spec.id};sw.setValue(${spec.sw},${JSON.stringify(spec.value)});true`
      );
    }
  });
  const scenes = await send("scene.info");
  if (scenes.available.includes("Scene_GameEnd"))
    await test("extra game end menu opens and returns", async () => {
      await send("scene.push", { name: "Scene_GameEnd" });
      // Some sealed MZ releases keep Scene_Base#isReady false while their custom
      // command window is already rendered. Scene manager state is the observable
      // readiness signal for this menu.
      const ready = () =>
        native(
          "(function(){var sm=window.TK&&TK.$&&TK.$.SceneMrg||window.SceneManager,s=sm._scene;return !!(s&&!sm._stopped&&!sm._nextScene);})()"
        );
      try {
        let ok = false;
        for (let n = 0; n < 150; n++) {
          await sleep(200);
          if (
            (await send("scene.info")).current === "Scene_GameEnd" &&
            (await ready())
          ) {
            ok = true;
            break;
          }
        }
        assert.equal(ok, true, "native end menu must finish creating");
      } finally {
        await send("scene.pop");
      }
      let returned = false;
      for (let n = 0; n < 150; n++) {
        await sleep(200);
        if (
          (await send("scene.info")).current === scenes.current &&
          (await ready())
        ) {
          returned = true;
          break;
        }
      }
      assert.equal(returned, true, "return to original scene");
    });
  else
    blocked(
      "extra game end menu opens and returns",
      "native scene is unavailable"
    );
}
