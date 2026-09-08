  // Read-only event tools. Never evaluate a command or a script condition.
  const eventToolIds = new WeakMap();
  let eventToolNextId = 0;
  function etId(object) {
    if (!object || typeof object !== "object") return "none";
    if (!eventToolIds.has(object)) eventToolIds.set(object, String(++eventToolNextId));
    return eventToolIds.get(object);
  }
  function etMap() {
    const map = requireMap();
    const info = currentMapInfo();
    const token = info.mapId + ":" + etId(map) + ":" + etId(window.$dataMap || map._events);
    return { map, info, token };
  }
  function etCheck(args) {
    const ctx = etMap();
    if (!args.mapToken || args.mapToken !== ctx.token) throw new Error("地图已变化，请刷新后重试");
    return ctx;
  }
  function etEvents(map) { return (map._events || []).filter(Boolean); }
  function etEventRow(event) {
    const data = typeof event.event === "function" ? event.event() : null;
    const page = Number(event._pageIndex);
    return { eventId: event._eventId, name: data && data.name || "", x: event._x, y: event._y,
      pageIndex: Number.isFinite(page) ? page : -1, pages: data && data.pages ? data.pages.length : 0,
      erased: !!event._erased, through: !!event._through, priority: event._priorityType,
      trigger: event._trigger, eventToken: [etId(event), page, event._x, event._y, !!event._erased].join(":") };
  }
  function etBusy() {
    const map = requireMap(), player = requirePlayer(), manager = resolveSceneManager(), scene = manager && manager._scene;
    const sceneMap = resolveSceneMap();
    if (!scene || !sceneMap || !(scene instanceof sceneMap)) return "当前不是可操作的地图场景";
    if (isInBattle()) return "战斗中不能传送";
    if (window.$gameMessage && window.$gameMessage.isBusy && window.$gameMessage.isBusy()) return "对话中不能传送";
    if (map.isEventRunning && map.isEventRunning()) return "剧情事件执行中不能传送";
    if (player.isTransferring && player.isTransferring()) return "正在转场";
    if (manager.isSceneChanging && manager.isSceneChanging()) return "正在切换场景";
    if (scene.isBusy && scene.isBusy()) return "场景忙碌";
    if (player.isInVehicle && player.isInVehicle()) return "乘坐载具时暂不支持此传送";
    if (player.canMove && !player.canMove()) return "玩家当前不可移动";
    return null;
  }
  function etCell(ctx, x, y) {
    if (typeof ctx.map.isPassable !== "function") return -1;
    try { return [2, 4, 6, 8].reduce((mask, direction, i) => mask | (ctx.map.isPassable(x, y, direction) ? 1 << i : 0), 0); }
    catch (_) { return -1; }
  }
  function etValid(ctx, x, y) { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < ctx.info.width && y < ctx.info.height; }
  function etVacant(ctx, x, y) {
    return !etEvents(ctx.map).some(e => !e._erased && !e._through && (e.isNormalPriority ? e.isNormalPriority() : e._priorityType === 1) && e._x === x && e._y === y);
  }
  function etMove(args) {
    if (typeof exActive === 'function' && exActive()) throw new Error('工具事件执行中不能另外传送');
    const ctx = etCheck(args), busy = etBusy();
    if (busy) throw new Error(busy);
    let x = Number(args.x), y = Number(args.y);
    if (args.eventId != null) {
      const event = etEvents(ctx.map).find(e => e._eventId === Number(args.eventId));
      if (!event || event._erased || event._pageIndex < 0) throw new Error("事件已消失或没有生效页");
      const row = etEventRow(event);
      if (row.eventToken !== args.eventToken) throw new Error("事件位置或事件页已变化，请刷新");
      x = row.x; y = row.y;
      if (!args.force) {
        const candidates = [[x,y+1],[x-1,y],[x+1,y],[x,y-1]].map(p => [
          ctx.map.roundX ? ctx.map.roundX(p[0]) : p[0], ctx.map.roundY ? ctx.map.roundY(p[1]) : p[1]
        ]);
        const near = candidates.find(p => etValid(ctx,p[0],p[1]) && etCell(ctx,p[0],p[1]) > 0 && etVacant(ctx,p[0],p[1]));
        if (!near) throw new Error("事件旁没有已知可通行空格，可单独选择强制到事件坐标");
        x = near[0]; y = near[1];
      }
    }
    if (!etValid(ctx,x,y)) throw new Error("目标坐标超出当前地图范围");
    if (args.force && args.confirmed !== true) throw new Error("强制传送需要明确确认");
    if (!args.force && (etCell(ctx,x,y) <= 0 || !etVacant(ctx,x,y))) throw new Error("落点不可通行、被占用或通行信息未知");
    const player = requirePlayer();
    if (typeof player.locate !== "function") throw new Error("当前引擎不支持定位");
    player.locate(x,y);
    return {mapId: ctx.info.mapId, x, y};
  }
  function etRaw(value, depth) {
    if (depth > 8) return "[深层参数已省略]";
    if (typeof value === "string") return value.length > 16000 ? value.slice(0,16000) + "[截断]" : value;
    if (value == null || typeof value === "number" || typeof value === "boolean") return value;
    if (Array.isArray(value)) {
      const out = value.slice(0,1000).map(v => etRaw(v,depth+1));
      if (value.length > 1000) out.push("[数组剩余参数已截断]");
      return out;
    }
    if (typeof value === "object") {
      const out = Object.create(null), keys = Object.keys(value);
      keys.slice(0,100).forEach(key => { out[key] = etRaw(value[key],depth+1); });
      if (keys.length > 100) out.$truncated = "剩余属性已截断";
      return out;
    }
    return String(value);
  }
  function etHash(value) {
    const text = JSON.stringify(value); let hash = 2166136261;
    for (let i=0;i<text.length;i++) hash = Math.imul(hash ^ text.charCodeAt(i),16777619);
    return (hash >>> 0).toString(16);
  }
  function etRunning() {
    const map = requireMap(), rows = [], seen = new Set();
    function visit(interpreter, label, depth) {
      if (!interpreter || seen.has(interpreter) || depth > 16) return;
      seen.add(interpreter);
      if (Array.isArray(interpreter._list) && interpreter._index < interpreter._list.length) {
        rows.push({id: etId(interpreter) + ":" + etId(interpreter._list), name: label, index: interpreter._index || 0,
          eventId: interpreter._eventId || 0, interpreter});
      }
      visit(interpreter._childInterpreter, label + " / 子事件", depth + 1);
    }
    visit(map._interpreter,"地图主事件",0);
    etEvents(map).forEach(event => visit(event._interpreter,"地图事件 #" + event._eventId,0));
    (map._commonEvents || []).forEach(event => visit(event._interpreter,"公共事件 #" + event._commonEventId,0));
    return rows;
  }
  function etReadSource(args) {
    const ctx = etCheck(args), source = args.source || {kind:args.kind,id:args.id,pageIndex:args.pageIndex,runId:args.runId};
    let list, conditions = {}, pages = [], activePage = null, name = "", index = null;
    if (source.kind === "running") {
      const running = etRunning().find(row => row.id === source.runId);
      if (!running) throw new Error("事件已结束或执行身份已变化");
      list = running.interpreter._list; name = running.name; index = running.index;
    } else if (source.kind === "common") {
      const event = runtimeDataTable("commonEvent")[Number(source.id)];
      if (!event) throw new Error("公共事件不存在");
      list = event.list; name = event.name;
    } else if (source.kind === "map") {
      const event = etEvents(ctx.map).find(e => e._eventId === Number(source.id));
      if (!event) throw new Error("地图事件已不存在");
      const data = event.event(); activePage = event._pageIndex;
      pages = data.pages.map((p,i) => ({index:i, conditions:etRaw(p.conditions,0), active:i===activePage}));
      const pageIndex = source.pageIndex == null ? Math.max(0,activePage) : Number(source.pageIndex);
      const page = data.pages[pageIndex];
      if (!page) throw new Error("事件页不存在");
      list = page.list; conditions = etRaw(page.conditions,0); name = data.name;
    } else throw new Error("未知事件来源");
    if (!Array.isArray(list)) throw new Error("事件指令不可读取");
    if (list.length > 20000) throw new Error("事件超过 20000 条指令，暂不读取以避免阻塞游戏");
    const commands = list.map(c => ({code:c.code,indent:c.indent || 0,parameters:etRaw(c.parameters,0)}));
    const revision = etHash([commands,conditions,activePage]);
    const values = {};
    const switches = resolveSwitches(), variables = resolveVariables(), self = resolveSelfSwitches();
    [conditions.switch1Id,conditions.switch2Id].filter(Boolean).forEach(id => { values["switch:"+id] = switches && switches.value ? switches.value(id) : null; });
    if (conditions.variableId) values["variable:"+conditions.variableId] = variables && variables.value ? etRaw(variables.value(conditions.variableId),0) : null;
    if (conditions.selfSwitchValid) values.selfSwitch = self && self.value ? self.value([ctx.info.mapId,Number(source.id),conditions.selfSwitchCh]) : null;
    const party = resolveParty();
    if (conditions.itemValid) {
      const item = runtimeDataTable("item")[conditions.itemId];
      values.item = party && party.hasItem && item ? !!party.hasItem(item) : null;
    }
    if (conditions.actorValid) values.actor = party && party.members ? party.members().some(actor => actor && actor.actorId && actor.actorId() === conditions.actorId) : null;
    return {mapToken:ctx.token, source, name, pages, activePage, conditions, values, revision, commands, total:commands.length,index};
  }
  Object.assign(commandHandlers, {
    "map.inspect": () => {
      const ctx = etMap();
      return Object.assign({},ctx.info,{mapToken:ctx.token,busy:etBusy(),events:etEvents(ctx.map).map(event => {
        try { return etEventRow(event); } catch (_) { return {eventId:event._eventId,name:"读取失败",erased:true,error:"事件数据无法读取"}; }
      }), capabilities:{grid:typeof ctx.map.isPassable === "function",events:true,reader:true,running:true}});
    },
    "map.grid": args => {
      const ctx = etCheck(args), offset = Math.max(0,Math.floor(Number(args.offset)||0));
      const total = ctx.info.width * ctx.info.height, count = Math.min(2048,Math.max(1,Number(args.count)||1024));
      if (!Number.isFinite(total) || total > 4000000) throw new Error("地图尺寸不可读取或过大");
      const cells=[];
      for(let i=offset;i<Math.min(total,offset+count);i++) cells.push(etCell(ctx,i%ctx.info.width,Math.floor(i/ctx.info.width)));
      return {mapToken:ctx.token,offset,total,cells};
    },
    "map.move": etMove,
    "events.running": args => { const ctx=etCheck(args); return {mapToken:ctx.token,entries:etRunning().map(row => ({id:row.id,name:row.name,index:row.index,eventId:row.eventId}))}; },
    "events.read": args => {
      const result=etReadSource(args), offset=Math.max(0,Math.floor(Number(args.offset)||0));
      if (args.revision && args.revision!==result.revision) throw new Error("事件内容已变化，请重新读取");
      result.commands=result.commands.slice(offset,offset+Math.min(300,Math.max(1,Number(args.count)||200)));
      result.offset=offset; return result;
    },
    "events.status": args => { const result=etReadSource(args); return {revision:result.revision,activePage:result.activePage,index:result.index,mapToken:result.mapToken}; }
  });
