import { reactive, computed, ref, watch, onMounted, onActivated, onDeactivated, onUnmounted } from 'vue';

// One controller owns map identity, request lifetimes and the retained reader.
// Consumers only declare visibility; they never start their own polling loops.
export function createEventTools(host, visibleDocument = () => true) {
  const state = reactive({ map: null, error: '', loading: false, moving: false, selected: null,
    query: '', mini: false, grid: [], gridLoading: false, gridError: '', reader: null,
    readLoading: false, readError: '', stale: '', running: [], runningError: '', common: [], executions: {} });
  let context = '', contextKey = null, generation = 0, readGeneration = 0, gridGeneration = 0, timer = null;
  let polling = false;
  const consumers = new Map(), cache = new Map();
  const key = () => host.trainer.gameKey;
  const connected = () => !!key() && !!host.sessionFor(key());
  const identity = () => key() + ':' + host.state.selectionEpoch;
  function sync() {
    if (context === identity()) return;
    const retained = contextKey === key() ? state.reader : null;
    context = identity(); contextKey = key(); generation++; readGeneration++; gridGeneration++; cache.clear();
    if(state.executions[key()]) state.executions[key()]={...state.executions[key()],pending:false,unknown:true};
    Object.assign(state, { map: null, selected: null, grid: [], gridLoading: false, reader: retained,
      stale: retained ? '连接已变化，请重读快照' : '', readError: '', error: '', mini: false, running: [], common: [], readLoading: false });
  }
  function valid(stamp) { return stamp === generation && connected() && context === identity(); }
  async function request(type, args = {}) {
    sync(); const stamp = generation, game = key();
    if (!connected()) throw new Error('当前游戏已断开');
    const result = await host.send(game, type, args);
    if (!valid(stamp)) throw new Error('已忽略旧游戏的响应');
    return result;
  }
  async function refresh() {
    sync(); const stamp = generation;
    if (!connected() || state.loading) return;
    state.loading = true;
    try {
      const map = await request('map.inspect');
      if (!map || !map.mapToken || !Array.isArray(map.events)) throw new Error('当前连接不支持地图工具，请重新注入新版桥接');
      if (map.mapToken !== state.map?.mapToken) {
        gridGeneration++; state.gridLoading = false; state.gridError = '';
        state.selected = null; state.grid = cache.get(map.mapToken) || [];
        if (state.reader) state.stale = '来源地图已变化';
      }
      if (state.selected?.eventId != null) {
        const event = map.events.find(row => row.eventId === state.selected.eventId);
        state.selected = event ? { eventId:event.eventId, x:event.x, y:event.y, mapToken:map.mapToken } : null;
      }
      state.map = map; state.error = '';
    } catch (error) { if (valid(stamp)) { state.error = error.message; if (state.reader) state.stale = '无法核实来源：' + error.message; } }
    finally { state.loading = false; }
  }
  async function loadGrid(force = false) {
    sync(); if (!state.map || !connected() || state.gridLoading) return;
    if (state.map.capabilities?.grid === false) { state.gridError = '当前游戏未提供可识别的通行接口；仍可查看玩家和事件位置'; return; }
    const map = state.map, stamp = generation, ticket = ++gridGeneration;
    if (!force && cache.has(map.mapToken)) { state.grid = cache.get(map.mapToken); return; }
    state.gridLoading = true; state.gridError = ''; state.grid = [];
    const cells = [];
    try {
      const total = map.width * map.height;
      if (!Number.isSafeInteger(total) || total <= 0 || total > 4000000) throw new Error('地图尺寸不可读取或过大');
      while (cells.length < total) {
        if (!consumers.size || !visibleDocument() || ticket !== gridGeneration) return;
        const chunk = await request('map.grid', { mapToken: map.mapToken, offset: cells.length, count: 2048 });
        if (ticket !== gridGeneration || state.map?.mapToken !== map.mapToken) return;
        if (chunk.mapToken !== map.mapToken || chunk.offset !== cells.length || !chunk.cells?.length || chunk.total !== total) throw new Error('通行数据分块不完整');
        cells.push(...chunk.cells);
      }
      if (cache.size >= 3) cache.delete(cache.keys().next().value);
      cache.set(map.mapToken, cells); state.grid = cells;
    } catch (error) { if (valid(stamp) && ticket === gridGeneration) state.gridError = error.message; }
    finally { if (ticket === gridGeneration) state.gridLoading = false; }
  }
  function select(row) { state.selected = row ? { eventId: row.eventId, x: row.x, y: row.y, mapToken: state.map?.mapToken } : null; }
  async function move(force = false, expected = null) {
    if (state.moving || !state.selected || !state.map || state.error) return;
    const point = expected || { ...state.selected };
    const row = state.map.events.find(e => e.eventId === point.eventId);
    const args = { mapToken: point.mapToken, x: point.x, y: point.y, force, confirmed: force };
    if (point.eventId != null) Object.assign(args, { eventId: point.eventId, eventToken: expected?.eventToken || row?.eventToken });
    const stamp = generation; state.moving = true;
    try { const result = await request('map.move', args); if (valid(stamp)) host.ok('已传送至 (' + result.x + ', ' + result.y + ')'); await refresh(); }
    catch (error) { if (valid(stamp)) host.warn(error.message); }
    finally { state.moving = false; }
  }
  async function read(source, append = false) {
    sync(); if (!connected()) return;
    const originalContext=identity();
    if (!state.map) await refresh();
    if (!state.map || originalContext!==identity()) return;
    const ticket = ++readGeneration, stamp = generation, map = state.map;
    const previous = state.reader;
    if (append && (!previous || state.stale)) return;
    const origin = append ? previous.source : { ...source };
    // Resolve an omitted page once; future status checks must follow that page.
    if (origin.kind === 'map' && origin.pageIndex == null) origin.pageIndex = Math.max(0, map.events.find(e => e.eventId === origin.id)?.pageIndex ?? 0);
    state.readLoading = true; state.readError = '';
    try {
      const result = await request('events.read', { ...origin, mapToken: map.mapToken,
        offset: append ? previous.commands.length : 0, count: 300, ...(append ? { revision: previous.revision } : {}) });
      if (ticket !== readGeneration) return;
      if (state.map?.mapToken !== map.mapToken) throw new Error('读取期间地图已变化，请重新选择事件');
      if (!Array.isArray(result.commands) || result.mapToken !== map.mapToken) throw new Error('事件读取接口不可用');
      let execution = append ? previous.execution : null, executionError = '';
      if(origin.kind==='common' && !append) {
        try {
          execution=await request('events.steps',{mapToken:map.mapToken,id:origin.id});
          if(!execution || !Array.isArray(execution.steps)) throw Error('当前连接不支持步骤执行，请重新注入新版桥接');
          if(execution.readerRevision!==result.revision) throw Error('读取期间事件内容已变化，请重读');
        } catch(error) { execution=null; executionError=error.message; }
      }
      if(ticket!==readGeneration || !valid(stamp)) return;
      if(state.map?.mapToken!==map.mapToken) throw Error('读取期间地图已变化，请重读');
      state.reader = { ...result, execution, executionError, source: origin, mapId: map.mapId, mapName: map.displayName || map.name || '',
        game: host.titleFor ? host.titleFor(key()) : key(), captured: append ? previous.captured : new Date().toLocaleTimeString(), commands: append ? previous.commands.concat(result.commands) : result.commands };
      state.stale = '';
    } catch (error) { if (valid(stamp) && ticket === readGeneration) state.readError = error.message; }
    finally { if (ticket === readGeneration) state.readLoading = false; }
  }
  async function readerStatus() {
    const snapshot = state.reader, stamp = generation;
    if (!snapshot || state.stale || state.readLoading) return;
    try {
      const result = await request('events.status', { ...snapshot.source, mapToken: snapshot.mapToken });
      if (snapshot !== state.reader) return;
      if (result.revision !== snapshot.revision || result.activePage !== snapshot.activePage) state.stale = '事件内容或生效页已变化';
      else snapshot.index = result.index;
    } catch (error) { if (valid(stamp) && snapshot === state.reader) state.stale = error.message; }
  }
  async function lists() {
    const stamp = generation, token = state.map?.mapToken;
    if (!token) return;
    try {
      const result = await request('events.running', { mapToken: token });
      if (state.map?.mapToken !== token) return;
      if (!Array.isArray(result.entries)) throw new Error('当前连接无法识别执行中事件');
      state.running = result.entries; state.runningError = '';
    } catch (error) { if (valid(stamp)) { state.running = []; state.runningError = error.message; } }
  }
  async function common() {
    const stamp = generation;
    try { const result = await request('catalog.query', { kind: 'commonEvent', offset: 0, limit: 20000 }); state.common = result.entries || []; }
    catch (error) { if (valid(stamp)) state.readError = error.message; }
  }
  const currentExecution = computed(() => state.executions[key()] || null);
  function executionArgs(plan, whole=false) {
    if(!state.reader || state.reader.source.kind!=='common' || state.stale || !plan || plan.reason) throw Error(plan?.reason || '请重读并选择可执行步骤');
    return {id:state.reader.source.id,mapToken:state.reader.mapToken,revision:plan.revision,start:plan.start,whole};
  }
  async function executionStatus() {
    const game=key(), stamp=generation;
    try {
      const result=await request('events.execution');
      if(!result || !('execution' in result)) return;
      const previous=state.executions[game];
      state.executions[game]=!result.execution && previous?.id ? {...previous,state:'unknown',unknown:true,pending:false,reason:'当前连接没有这次执行记录，无法确认最终结果；不会自动重放。'} : {...result.execution,pending:previous?.pending || false,unknown:false};
    } catch(error) { if(valid(stamp) && state.executions[game]) state.executions[game].unknown=true; }
  }
  async function execute(args) {
    const game=key(),stamp=generation;
    const record=state.executions[game] || (state.executions[game]={});
    if(record.pending) return;
    record.pending=true;
    try {
      const result=await request('events.execute',args);
      state.executions[game]={...result.execution,unknown:false};
      host.ok('已接受公共事件执行请求');
    } catch(error) { if(valid(stamp)) {
      if(state.executions[game])state.executions[game].unknown=true;
      if(/内容已变化|Event changed/.test(error.message) && state.reader?.source.id===args.id)state.stale=error.message;
      host.warn(error.message);
    } }
    finally { record.pending=false; if(valid(stamp) && state.executions[game]) state.executions[game].pending=false; }
  }
  async function stopExecution() {
    const record=currentExecution.value,stamp=generation,game=key();
    if(!record?.id || record.pending) return;
    record.pending=true;
    try {const result=await request('events.stop',{executionId:record.id});state.executions[key()]={...result.execution,unknown:false};}
    catch(error){if(valid(stamp)){record.unknown=true;host.warn(error.message);}}
    finally {record.pending=false;if(valid(stamp) && state.executions[game])state.executions[game].pending=false;}
  }
  function preview(args) { return request('events.preview',args); }
  async function tick() {
    if (polling) return;
    clearTimeout(timer); polling = true; sync();
    try {
      if (consumers.size && visibleDocument() && connected()) {
        await refresh();
        if (visibleDocument() && connected()) { await executionStatus(); await lists(); await readerStatus(); }
      }
    } finally { polling = false; if (consumers.size) timer = setTimeout(tick, 1000); }
  }
  function visible(name, value, owner=name) { sync(); value ? consumers.set(owner,name) : consumers.delete(owner); clearTimeout(timer); if (consumers.size) void tick(); }
  function stop() { consumers.clear(); clearTimeout(timer); gridGeneration++; }
  return { state, connected, sync, refresh, loadGrid, select, move, read, common, visible, stop, currentExecution, executionArgs, execute, preview, stopExecution };
}

let shared;
export function useEventTools(name) {
  const host = window.RMCH.store;
  if (!shared) shared = createEventTools(host, () => document.visibilityState !== 'hidden');
  const active = ref(true), foreground = ref(document.visibilityState !== 'hidden');
  const owner=Symbol(name);
  const visible = computed(() => active.value && foreground.value && host.data.tab === name);
  const change = () => { foreground.value = document.visibilityState !== 'hidden'; };
  onMounted(() => document.addEventListener('visibilitychange', change));
  onActivated(() => { active.value = true; });
  onDeactivated(() => { active.value = false; shared.state.mini = false; });
  watch([visible, () => host.trainer.gameKey, () => host.state.selectionEpoch, () => !!host.sessionFor(host.trainer.gameKey)], () => shared.visible(name, visible.value, owner), { immediate: true });
  onUnmounted(() => { shared.visible(name, false, owner); document.removeEventListener('visibilitychange', change); });
  return shared;
}
