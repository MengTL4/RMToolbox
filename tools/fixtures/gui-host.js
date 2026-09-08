// Controlled UI-only data. Never reads a game directory or sends game commands.
(function () {
  var games = [
    { gameKey: "a", title: "星河旅人", root: "D:/Games/星河旅人", engine: { id: "MZ" }, paths: { exe: "Game.exe" }, protection: { level: 0 } },
    { gameKey: "b", title: "迷雾森林 · 冒险之书", root: "D:/Games/迷雾森林", engine: { id: "MV" }, paths: { exe: "Game.exe" }, protection: { level: 1 } },
    { gameKey: "c", title: "遗忘之城", root: "D:/Games/遗忘之城", engine: { id: "RGSS3" }, paths: { exe: "Game.exe" }, protection: { level: 2 } },
    { gameKey: "d", title: "未完成的旅途", root: "D:/Games/未完成的旅途", engine: { id: "MV" }, paths: { exe: null }, protection: { level: 0 } }
  ];
  var host = {
    games: games, calls: [], mapVersion: 1, eventRevision: 'one', executions: {},
    sessions: [{ gameKey: "a", alive: true, connectedAt: 1 }, { gameKey: "b", alive: true, connectedAt: 1 }],
    options: { a: { expRate: 1, goldRate: 1, dropRate: 1, gameSpeedMulti: 1, showFollowers: true }, b: { expRate: 2 } },
    setHandlers: function (handlers) { host.handlers = handlers; },
    getLog: function () { return ""; }, init: function () { return Promise.resolve(); },
    describe: function () { return { port: 47412, about: { appVersion: "UI preview" } }; },
    listLibrary: function () { return games; }, listSessions: function () { return host.sessions; },
    gameIcon: function () { return null; }, iconSetImage: function () { return null; }, iconFileImage: function () { return null; },
    hasLocks: function () { return false; }, listBackups: function () { return []; },
    readBridgeLog: function () { return "预览数据，不连接真实游戏。"; },
    launch: function (root) { host.calls.push({ type: "launch", root: root }); return Promise.resolve({ gameKey: "c", pid: 123 }); },
    attach: function (root) { host.calls.push({ type: "attach", root: root }); return Promise.resolve({ gameKey: "c", pid: 123 }); },
    stop: function (pid) { host.calls.push({ type: "stop", pid: pid }); return Promise.resolve(); },
    send: function (key, type, args) {
      host.calls.push({ key: key, type: type, args: args });
      var actor = { id: 1, name: key === "a" ? "艾琳" : "旅行者", level: 12, hp: 640, mp: 120, tp: 0, mhp: 800, mmp: 160, params: [800, 160, 45, 32, 40, 28, 36, 20] };
      var result = {};
      if (type === "trainer.options.get") result = { options: Object.assign({}, host.options[key]) };
      else if (type === "trainer.options.set") { Object.assign(host.options[key], args.options); result = { options: Object.assign({}, host.options[key]) }; }
      else if (type === "party.info") result = { members: [actor] };
      else if (type === "actor.info") result = { actor: actor };
      else if (type === "catalog.query") result = { total: 24, entries: Array.from({ length: 24 }, function (_, i) { return { id: i + 1, name: (args.kind === "actor" ? "旅人" : "恢复药剂") + " " + (i + 1) }; }) };
      else if (type === "item.list") result = { entries: [{ id: 1, kind: "item", count: key === "a" ? 12 : 3 }] };
      else if (type === "item.set") result = { kind: args.kind, id: args.id, count: args.count };
      else if (type === "switch.list" || type === "variable.list") result = { entries: [{ id: 1, name: "剧情进度", value: type === "switch.list" ? true : 10 }] };
      else if (type === "map.list") result = { entries: [{ id: 1, name: "星港小镇" }] };
      else if (type === 'map.inspect') result = {mapToken:key+':map:'+host.mapVersion,mapId:host.mapVersion,mapName:'星港小镇',width:32,height:24,x:8,y:9,busy:null,capabilities:{grid:true,reader:true,running:true},events:[{eventId:1,name:'港口守卫',x:12,y:9,pageIndex:0,pages:2,eventToken:'guard:1'},{eventId:2,name:'隐藏宝箱',x:16,y:10,pageIndex:-1,pages:1,eventToken:'chest:1'}]};
      else if (type === 'map.grid') result = {mapToken:args.mapToken,offset:args.offset,total:768,cells:Array.from({length:Math.min(args.count,768-args.offset)},function(_,i){return (i+args.offset)%32<3?0:15;})};
      else if (type === 'map.move') result = {mapId:host.mapVersion,x:12,y:10};
      else if (type === 'events.running') result = {mapToken:args.mapToken,entries:[{id:'run:1',name:'公共事件 #2',index:3,eventId:0}]};
      else if (type === 'events.status') result = {mapToken:args.mapToken,revision:host.eventRevision,activePage:0,index:args.kind==='running'?3:null};
      else if (type === 'events.steps') result = {mapToken:args.mapToken,id:args.id,readerRevision:host.eventRevision,steps:[{start:0,end:1,code:125,revision:host.eventRevision},{start:1,end:3,code:355,revision:host.eventRevision,script:true}],whole:{revision:host.eventRevision,script:true}};
      else if (type === 'events.preview') result = {preview:'$gameParty.gainGold(5);\n$gameParty.gainGold(6);'};
      else if (type === 'events.execute') {host.executions[key]={id:'fixture:'+key,eventId:args.id,name:'测试公共事件',state:'waiting',index:args.start||0,commandEventId:args.id,stopRequested:false};result={execution:host.executions[key]};}
      else if (type === 'events.execution') result = {execution:host.executions[key]||null};
      else if (type === 'events.stop') {host.executions[key].stopRequested=true;host.executions[key].state='stopping';result={execution:host.executions[key]};}
      else if (type === 'events.read') result = {mapToken:args.mapToken,name:'港口守卫',revision:host.eventRevision,activePage:0,index:args.kind==='running'?3:null,
        pages:args.kind==='map'?[{index:0,active:true},{index:1,active:false}]:[],conditions:{switch1Valid:true,switch1Id:5,variableValid:true,variableId:3,variableValue:10},values:{'switch:5':true,'variable:3':12},total:6,offset:0,
        commands:[{code:111,indent:0,parameters:[0,5,0]},{code:101,indent:1,parameters:['',0,0,2]},{code:401,indent:1,parameters:['欢迎来到星港。准备好再次出发了吗？']},{code:355,indent:1,parameters:['$gameVariables.setValue(1, 99);']},{code:9876,indent:1,parameters:[{custom:'保留原始参数'}]},{code:412,indent:0,parameters:[]}]};
      else if (type === "save.list") result = host.webStorage
        ? { dir: null, storage: "webstorage", entries: [{ name: "RPG File1", slot: 1, size: 4096, mtime: "2026-09-07T08:00:00Z" }] }
        : { dir: "D:/Games/" + key + "/save", entries: [{ name: "file1.rmmzsave", slot: 1, size: 4096, mtime: "2026-09-07T08:00:00Z" }] };
      else if (type === "console.eval") result = { result: key + ": " + args.code };
      else if (type === "assets.iconset") return Promise.reject(new Error("fixture has no icon sheet"));
      else if (type === "gold.set" || type === "gold.add") result = { gold: args.value || args.amount };
      else if (type === "battle.info") result = { inBattle: false, enemies: [] };
      else if (type === 'save.contents.get') { var json = JSON.stringify({party: {gold: 24860}, system: {title: '预览存档'}, switches: [null, true]}); result = {json: json, bytes: json.length}; }
      if(type==='events.read' && args.kind==='common') {result.name='测试公共事件';result.total=4;result.commands=[{code:125,indent:0,parameters:[0,0,100]},{code:355,indent:0,parameters:['$gameParty.gainGold(5);']},{code:655,indent:0,parameters:['$gameParty.gainGold(6);']},{code:0,indent:0,parameters:[]}];}
      return Promise.resolve(result);
    }
  };
  window.__guiFixture = host;
  window.require = function () { return host; };
})();
