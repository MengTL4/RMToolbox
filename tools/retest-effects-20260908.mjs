// Native game objects and interpreters; no simulated engine fixtures here.
import assert from "node:assert/strict";
export async function effects({ send, ev, test, blocked, sleep }) {
  const rawEv = ev;
  ev = (code) =>
    rawEv(
      `(function(){var t=window.TK&&TK.$;var $gameParty=t&&t.gameParty?t.gameParty():window.$gameParty,$gamePlayer=t&&t.gamePlayer?t.gamePlayer():window.$gamePlayer,$gameTroop=t&&t.gameTroop?t.gameTroop():window.$gameTroop,$gameSwitches=t&&t.gameSwitches?t.gameSwitches():window.$gameSwitches;var $dataSkills=t&&t.dataSkills?t.dataSkills():window.$dataSkills,$dataSystem=t&&t.dataSystem?t.dataSystem():window.$dataSystem,$dataCommonEvents=t&&t.dataCommonEvents?t.dataCommonEvents():window.$dataCommonEvents,$dataTroops=t&&t.dataTroops?t.dataTroops():window.$dataTroops;var BattleManager=t&&t.BattleMrg||window.BattleManager,SceneManager=t&&t.SceneMrg||window.SceneManager,ConfigManager=t&&t.ConfigMrg||window.ConfigManager;return eval(${JSON.stringify(code)});})()`
    );
  const available = await ev(
    'typeof $gameParty !== "undefined" && typeof $gamePlayer !== "undefined" && typeof BattleManager !== "undefined"'
  ).catch(() => false);
  if (!available) {
    blocked(
      "native effect probes",
      "JS engine aliases unavailable; requires engine-specific probe"
    );
    return;
  }
  const old = (await send("trainer.options.get")).options;
  async function optionTest(name, options, fn) {
    await test(name, async () => {
      try {
        await send("trainer.options.set", options);
        return await fn();
      } finally {
        await send("trainer.options.set", old);
      }
    });
  }
  await optionTest("effect through walls", { throughWalls: true }, async () =>
    assert.equal(await ev("$gamePlayer.isThrough()"), true)
  );
  await optionTest("effect no encounter", { noEncounter: true }, async () =>
    assert.equal(await ev("$gamePlayer.encounterProgressValue()"), 0)
  );
  await test("effect movement speed", async () => {
    try {
      await send("trainer.options.set", { moveSpeedAdd: 0 });
      const base = await ev("$gamePlayer.realMoveSpeed()");
      await send("trainer.options.set", { moveSpeedAdd: 1 });
      assert.equal(
        await ev("$gamePlayer.realMoveSpeed()"),
        Math.max(1, Math.min(6, base + 1))
      );
    } finally {
      await send("trainer.options.set", old);
    }
  });
  await optionTest("effect always dash", { alwaysDash: true }, async () =>
    assert.equal(await ev("ConfigManager.alwaysDash"), true)
  );
  await optionTest(
    "effect followers hidden",
    { showFollowers: false },
    async () =>
      assert.equal(await ev("$gamePlayer.followers().isVisible()"), false)
  );
  await optionTest(
    "effect HP maximum lock",
    { lockHp: true, lockHpMax: true },
    async () => {
      const x = await ev(
        "(()=>{var a=$gameParty.members()[0];a.setHp(1);return {hp:a.hp,max:a.mhp}})()"
      );
      assert.equal(x.hp, x.max);
    }
  );
  await optionTest(
    "effect MP TP locks",
    { lockMp: true, lockMpVal: 5, lockTp: true, lockTpVal: 30 },
    async () => {
      const x = await ev(
        "(()=>{var a=$gameParty.members()[0];a.setMp(1);a.setTp(1);return {mp:a.mp,tp:a.tp,max:a.mmp}})()"
      );
      assert.equal(x.mp, Math.min(5, x.max));
      assert.equal(x.tp, 30);
    }
  );
  const mpSkill = await ev("$dataSkills.some(s=>s&&s.mpCost>0)");
  if (mpSkill)
    await optionTest(
      "effect zero skill cost",
      { noSkillCost: true },
      async () => {
        const x = await ev(
          "(()=>{var a=$gameParty.members()[0],s=$dataSkills.filter(s=>s&&s.mpCost>0)[0];return {cost:a.skillMpCost(s),pay:a.canPaySkillCost(s)}})()"
        );
        assert.equal(x.cost, 0);
        assert.equal(x.pay, true);
      }
    );
  else
    blocked("effect zero skill cost", "no MP skill sample in native database");
  await test("effect Ctrl speed native map ticks", async () => {
    try {
      await send("trainer.options.set", {
        speedHoldCtrl: false,
        gameSpeedMulti: 3
      });
      await rawEv(
        `(function(){var t=window.TK&&TK.$,m=t&&t.gameMap?t.gameMap():window.$gameMap;if(!m||typeof m.update!=='function')throw Error('map update unavailable');window.__rmchTickProbe={map:m,original:m.update,count:0};m.update=function(){window.__rmchTickProbe.count++;return window.__rmchTickProbe.original.apply(this,arguments)};window.dispatchEvent(new KeyboardEvent('keydown',{key:'Control',keyCode:17,bubbles:true}));return true})()`
      );
      await sleep(1500);
      const baseline = await rawEv("window.__rmchTickProbe.count");
      assert.ok(baseline > 10, "native map is paused");
      await send("trainer.options.set", {
        speedHoldCtrl: true,
        gameSpeedMulti: 3
      });
      await rawEv("window.__rmchTickProbe.count=0");
      await sleep(1500);
      const accelerated = await rawEv("window.__rmchTickProbe.count");
      assert.ok(
        accelerated > baseline * 1.5,
        `baseline=${baseline}, accelerated=${accelerated}`
      );
      return { baseline, accelerated };
    } finally {
      await rawEv(
        `(function(){var p=window.__rmchTickProbe;if(p){p.map.update=p.original;delete window.__rmchTickProbe;}window.dispatchEvent(new KeyboardEvent('keyup',{key:'Control',keyCode:17,bubbles:true}));return true})()`
      ).catch(() => {});
      await send("trainer.options.set", old);
    }
  });
  await test("native common event selected step and stop", async () => {
    const index = await ev("$dataCommonEvents.length");
    const sw = await ev("$dataSystem.switches.length-1");
    const prev = await ev(`$gameSwitches.value(${sw})`);
    let execution;
    try {
      await ev(
        `$dataCommonEvents.push({id:${index},name:'RMCH temporary native test',trigger:0,switchId:1,list:[{code:121,indent:0,parameters:[${sw},${sw},${prev ? 1 : 0}]},{code:230,indent:0,parameters:[600]},{code:0,indent:0,parameters:[]}]});true`
      );
      const map = await send("map.inspect");
      const plan = await send("events.steps", {
        mapToken: map.mapToken,
        id: index
      });
      const first = plan.steps.find((s) => s.start === 0);
      assert.ok(first);
      execution = (
        await send("events.execute", {
          mapToken: map.mapToken,
          id: index,
          start: 0,
          revision: first.revision
        })
      ).execution;
      for (let n = 0; n < 30; n++) {
        await sleep(100);
        execution = (await send("events.execution")).execution;
        if (["completed", "stopped", "failed"].includes(execution?.state))
          break;
      }
      assert.equal(execution.state, "completed");
      assert.equal(await ev(`$gameSwitches.value(${sw})`), !prev);
      const next = await send("events.steps", {
        mapToken: map.mapToken,
        id: index
      });
      const wait = next.steps.find((s) => s.start === 1);
      execution = (
        await send("events.execute", {
          mapToken: map.mapToken,
          id: index,
          start: 1,
          revision: wait.revision
        })
      ).execution;
      await sleep(150);
      await send("events.stop", { executionId: execution.id });
      let stopped;
      for (let n = 0; n < 180; n++) {
        await sleep(100);
        stopped = (await send("events.execution")).execution;
        if (stopped.state === "stopped") break;
      }
      assert.equal(stopped.state, "stopped");
    } finally {
      if (execution)
        await send("events.stop", { executionId: execution.id }).catch(
          () => {}
        );
      await ev(
        `$dataCommonEvents.length=${index};$gameSwitches.setValue(${sw},${JSON.stringify(prev)});true`
      );
    }
  });
  // End-of-run battle: failures cannot invalidate earlier save/map checks.
  const ready =
    await test("native battle fixture (engine event 301)", async () => {
      const id = await ev(
        `$dataTroops.filter(function(t){if(!t||!t.members||!t.members.length)return false;if($gameTroop&&typeof $gameTroop.dataTroopsmembers==='function'){var probe=Object.create($gameTroop);probe._troopId=t.id;var members=probe.dataTroopsmembers();return Array.isArray(members)&&members.length>0;}return true;})[0].id`
      );
      await rawEv(
        `(function(){var t=window.TK&&TK.$,m=t&&t.gameMap?t.gameMap():window.$gameMap;m._interpreter.setup([{code:301,indent:0,parameters:[0,${id},true,true]},{code:0,indent:0,parameters:[]}],0);return true})()`
      );
      for (let n = 0; n < 300; n++) {
        await sleep(100);
        const b = await send("battle.info");
        const scene = await send("scene.info");
        if (
          b.inBattle &&
          b.enemies.length &&
          (/Battle/.test(scene.current) ||
            (await ev(
              '!!(SceneManager._scene && typeof SceneManager._scene.createPartyCommandWindow === "function" && typeof SceneManager._scene.startActorCommandSelection === "function")'
            )))
        ) {
          await sleep(1000);
          return true;
        }
      }
      throw Error("native battle scene did not start from event 301");
    });
  if (!ready) {
    blocked("combat effects", "could not enter native battle");
    return;
  }
  await optionTest(
    "effect invincible damage",
    { invincible: true },
    async () => {
      const x = await ev(
        "(()=>{var a=$gameParty.battleMembers()[0],e=$gameTroop.members()[0],before=a.hp,act=new Game_Action(e);act.setAttack();act.executeHpDamage(a,10);return {before,after:a.hp}})()"
      );
      assert.equal(x.after, x.before);
    }
  );
  await test("effect battle reward multipliers", async () => {
    try {
      const sample = () =>
        ev(
          '(()=>{var a=$gameParty.battleMembers()[0],g=$gameParty.gold(),v=a.currentExp(),e=$gameTroop.members()[0];$gameParty.gainGold(10,true);var consumed=0,up=a.levelNewUp,own=Object.getOwnPropertyDescriptor(a,"levelNewUp"),ft=typeof a.thTyChangeExp==="function"&&typeof up==="function"&&a._thTyLevel!=null;if(ft)a.levelNewUp=function(){consumed+=this.nextLevelExp();return up.apply(this,arguments);};try{a.gainExp(10,true);}finally{if(ft){if(own)Object.defineProperty(a,"levelNewUp",own);else delete a.levelNewUp;}}return {gold:$gameParty.gold()-g,exp:a.currentExp()-v+consumed,drop:e.dropItemRate()}})()'
        );
      await send("trainer.options.set", {
        goldRate: 1,
        expRate: 1,
        dropRate: 1
      });
      const base = await sample();
      await send("trainer.options.set", {
        goldRate: 2,
        expRate: 2,
        dropRate: 2
      });
      const doubled = await sample();
      assert.ok(
        base.gold > 0 && base.exp > 0,
        "native base rewards are zero: " + JSON.stringify({ base, doubled })
      );
      assert.equal(doubled.gold, base.gold * 2);
      assert.ok(
        Math.abs(doubled.exp - base.exp * 2) <= 1,
        JSON.stringify({ base, doubled })
      );
      assert.equal(doubled.drop, base.drop * 2);
      return { base, doubled };
    } finally {
      await send("trainer.options.set", old);
    }
  });
  await test("native enemy HP write", async () => {
    await send("battle.enemy.setHp", { index: 0, value: 1 });
    assert.equal((await send("battle.info")).enemies[0].hp, 1);
  });
  await optionTest("effect one hit kill", { oneHitKill: true }, async () => {
    const x = await ev(
      "(()=>{var a=$gameParty.battleMembers()[0],e=$gameTroop.members()[0],act=new Game_Action(a);e.setHp(20);act.setAttack();act.apply(e);return {hp:e.hp,dead:e.isDead()}})()"
    );
    assert.equal(x.hp, 0);
    assert.equal(x.dead, true);
  });
  await test("native kill all enemies", async () => {
    const r = await send("battle.killEnemies");
    assert.equal(r.remaining, 0);
  });
  await test("native escape battle", async () => {
    const b = await send("battle.info");
    if (!b.inBattle)
      throw Error(
        "battle already ended after defeating all enemies; escape requires another native battle"
      );
    const r = await send("battle.escape");
    assert.equal(r.escaped, true);
  });
}
