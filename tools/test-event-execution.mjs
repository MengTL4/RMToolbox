import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import {
  requireRuby,
  rubyFixturePath,
  runRubyFixture,
  rubyFixtureCwd
} from "./lib/ruby-fixture.mjs";
const read = (path) => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const command = (code, parameters = [], indent = 0) => ({
  code,
  parameters,
  indent
});
function fixture() {
  const sandbox = {
    console,
    Game_Character: { ROUTE_CHANGE_IMAGE: 41 },
    commandHandlers: {},
    Graphics: { frameCount: 0 },
    ImageManager: new Proxy(
      { isReady: () => true },
      { get: (o, k) => o[k] || (() => {}) }
    ),
    SceneManager: { isSceneChanging: () => false }
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(
    "Array.prototype.clone=function(){return this.slice();};Array.prototype.contains=function(value){return this.indexOf(value)>=0;};",
    ctx
  );
  vm.runInContext(read("./fixtures/mv-core/Game_Interpreter.js"), ctx);
  sandbox.JsonEx = {
    makeDeepCopy: (value) => JSON.parse(JSON.stringify(value))
  };
  const main = new sandbox.Game_Interpreter(),
    player = {
      canMove: () => true,
      forcing: false,
      setCallerEventInfo() {},
      forceMoveRoute() {
        this.forcing = true;
      },
      isMoveRouteForcing() {
        return this.forcing;
      }
    };
  const map = {
    _interpreter: main,
    mapId: () => 1,
    refreshIfNeeded() {},
    _events: [],
    _commonEvents: []
  };
  const events = [
    null,
    {
      name: "金币",
      list: [command(125, [0, 0, 10]), command(125, [0, 0, 20]), command(0)]
    },
    {
      name: "循环等待",
      list: [
        command(112),
        command(125, [0, 0, 1], 1),
        command(230, [2], 1),
        command(413),
        command(0)
      ]
    },
    {
      name: "调用",
      list: [command(117, [2]), command(125, [0, 0, 900]), command(0)]
    },
    {
      name: "脚本",
      list: [
        command(355, ["$gameParty.gainGold(5);"]),
        command(655, ["$gameParty.gainGold(6);"]),
        command(0)
      ]
    },
    {
      name: "上下文",
      list: [
        command(123, ["A", 0]),
        command(9999),
        command(119, ["outside"]),
        command(0)
      ]
    },
    {
      name: "对话选项",
      list: [
        command(101, ["", 0, 0, 2]),
        command(401, ["你好"]),
        command(102, [["是", "否"], 0, 0, 2, 0]),
        command(402, [0, "是"]),
        command(125, [0, 0, 7], 1),
        command(402, [1, "否"]),
        command(125, [0, 0, 8], 1),
        command(404),
        command(0)
      ]
    }
  ];
  let gold = 0,
    busy = false;
  const party = {
    gainGold: (v) => {
      gold += v;
    },
    inBattle: () => false
  };
  const message = {
    isBusy: () => busy,
    setFaceImage() {},
    setBackground() {},
    setPositionType() {},
    add() {
      busy = true;
    },
    setChoices() {
      busy = true;
    },
    setChoiceBackground() {},
    setChoicePositionType() {},
    setChoiceCallback(fn) {
      this.callback = fn;
    }
  };
  Object.assign(sandbox, {
    $gameMap: map,
    $gamePlayer: player,
    $gameParty: party,
    $gameMessage: message,
    $dataCommonEvents: events,
    requireMap: () => map,
    requirePlayer: () => player,
    resolveTemp: () => null,
    resolveParty: () => party,
    etCheck: (args) => {
      if (args.mapToken !== "map:1") throw Error("地图已变化");
    },
    etBusy: () =>
      busy
        ? "对话中不能传送"
        : main.isRunning()
          ? "剧情事件执行中不能传送"
          : null,
    runtimeDataTable: () => events,
    etHash: (value) => {
      let h = 0;
      for (const c of JSON.stringify(value))
        h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
      return String(h);
    },
    etReadSource: () => ({ revision: "reader" })
  });
  vm.runInContext(
    read("../runtime/bridge/src/parts/65b-event-execution.js"),
    ctx
  );
  const api = sandbox.commandHandlers;
  const steps = (id) => api["events.steps"]({ mapToken: "map:1", id });
  const start = (id, index = 0, extras = {}) => {
    const plan = steps(id).steps.find((s) => s.start === index);
    return api["events.execute"]({
      mapToken: "map:1",
      id,
      start: index,
      revision: plan.revision,
      ...extras
    });
  };
  const status = () => api["events.execution"]().execution;
  const tick = () => {
    sandbox.Graphics.frameCount++;
    main.update();
  };
  return {
    api,
    steps,
    start,
    status,
    tick,
    main,
    events,
    ctx,
    sandbox,
    gold: () => gold,
    message,
    endMessage(choice = 0) {
      message.callback?.(choice);
      busy = false;
    }
  };
}
{
  const f = fixture();
  assert.deepEqual(
    Array.from(f.steps(1).steps, (s) => s.start),
    [0, 1]
  );
  const accepted = f.start(1, 1);
  assert.equal(accepted.execution.state, "accepted");
  assert.equal(f.gold(), 0);
  assert.throws(() => f.start(1, 0), /已有工具事件/);
  f.events[1].list[1].parameters[2] = 2000;
  f.tick();
  assert.equal(f.gold(), 20, "execute captured original selected step only");
  assert.equal(f.status().state, "completed");
  const plan = f.steps(1).steps[0];
  f.events[1].list[0].parameters[2] = 50;
  assert.throws(
    () =>
      f.api["events.execute"]({
        mapToken: "map:1",
        id: 1,
        start: 0,
        revision: plan.revision
      }),
    /内容已变化/
  );
  assert.ok(f.steps(5).steps.every((s) => s.reason));
  assert.equal(
    f.steps(4).steps.length,
    1,
    "script continuation is part of the step"
  );
  assert.throws(() => f.start(4), /确认/);
  f.start(4, 0, { confirmed: true });
  f.tick();
  assert.equal(f.gold(), 31);
  assert.equal(
    f.steps(6).steps.length,
    1,
    "text, choices and result branches stay together"
  );
  f.start(6);
  f.tick();
  assert.equal(f.status().state, "waiting");
  f.endMessage(1);
  f.tick();
  assert.equal(f.gold(), 39);
  assert.equal(f.status().state, "completed");
  console.log(
    "official MV interpreter PASS: selected range, snapshots, confirmation, text/choices, context and unknown guards"
  );
}
{
  const f = fixture();
  f.start(3);
  f.tick();
  assert.equal(f.gold(), 1);
  const id = f.status().id;
  f.api["events.stop"]({ executionId: id });
  assert.equal(f.status().state, "stopping");
  f.tick();
  assert.equal(
    f.status().state,
    "stopping",
    "wait must finish before stopping"
  );
  for (let i = 0; i < 4; i++) f.tick();
  assert.equal(f.status().state, "stopped");
  assert.equal(f.gold(), 1, "no next iteration or sibling executed");
  assert.throws(() => f.api["events.stop"]({ executionId: "old" }), /身份/);
  // A loop without waits yields to the game frame on our command budget.
  f.events[2].list = [
    command(112),
    command(125, [0, 0, 1], 1),
    command(413),
    command(0)
  ];
  f.start(2);
  f.tick();
  assert.ok(f.gold() > 1 && f.gold() < 150);
  f.api["events.stop"]({ executionId: f.status().id });
  f.tick();
  assert.equal(f.status().state, "stopped");
  f.events[4].list = [
    command(355, ['throw new Error("owned failure")']),
    command(0)
  ];
  f.start(4, 0, { confirmed: true });
  f.tick();
  assert.equal(f.status().state, "failed");
  f.main.setup(f.events[4].list);
  assert.throws(
    () => f.tick(),
    /owned failure/,
    "unrelated engine errors still propagate"
  );
  console.log(
    "official MV interpreter PASS: child waits, cooperative stop, loop budget, owned errors only"
  );
}
{
  const f = fixture();
  f.events[1].list = [
    command(205, [
      -1,
      { list: [{ code: 0, parameters: [] }], repeat: false, wait: false }
    ]),
    command(0)
  ];
  f.start(1);
  f.tick();
  assert.equal(
    f.status().state,
    "waiting",
    "non-waiting move still tracked until completion"
  );
  f.api["events.stop"]({ executionId: f.status().id });
  f.tick();
  assert.equal(f.status().state, "stopping");
  f.sandbox.$gamePlayer.forcing = false;
  f.tick();
  assert.equal(f.status().state, "stopped");
  f.events[1].list[0].parameters[1].list = [
    { code: 45, parameters: ["dangerousRouteScript()"] }
  ];
  assert.equal(
    f.steps(1).steps[0].script,
    true,
    "movement script also needs confirmation"
  );
  console.log(
    "official MV interpreter PASS: asynchronous movement and route script confirmation"
  );
}
{
  const f = fixture();
  // MZ invokes command methods with parameters, without populating _params.
  f.sandbox.Game_Interpreter.prototype.executeCommand = function () {
    const c = this.currentCommand();
    if (!c) {
      this.terminate();
      return true;
    }
    if (c.code === 117) {
      if (!this.command117(c.parameters)) return false;
      this._index++;
      return true;
    }
    this._params = c.parameters;
    if (c.code === 0) {
      this.terminate();
      return true;
    }
    if (!this["command" + c.code]()) return false;
    this._index++;
    return true;
  };
  f.start(3);
  f.tick();
  assert.equal(f.gold(), 1);
  f.api["events.stop"]({ executionId: f.status().id });
  for (let i = 0; i < 4; i++) f.tick();
  assert.equal(f.status().state, "stopped");
  console.log("MZ parameter dispatch contract PASS");
}
const ruby = requireRuby(
  "RGSS execution fixtures",
  rubyFixturePath("event-execution.rb")
);
if (ruby)
  runRubyFixture(
    ruby,
    ["tools/fixtures/event-execution.rb"],
    "RGSS execution fixtures",
    { cwd: rubyFixtureCwd }
  );
