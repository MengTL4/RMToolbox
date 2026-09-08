<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue';
const props = defineProps({ tools: { type: Object, required: true } });
const canvas = ref(null), zoom = ref(22), follow = ref(true), pan = ref({ x: 0, y: 0 });
let resize, drag = null;
const s = props.tools.state;
function center() {
  const map = s.map; if (!map || !canvas.value) return;
  const player = map.player || map;
  pan.value = { x: canvas.value.clientWidth / 2 - ((player.x ?? 0) + .5) * zoom.value,
    y: canvas.value.clientHeight / 2 - ((player.y ?? 0) + .5) * zoom.value };
}
function locatePoint() {
  if(!s.selected || !canvas.value) return;
  follow.value=false;
  pan.value={x:canvas.value.clientWidth/2-(s.selected.x+.5)*zoom.value,y:canvas.value.clientHeight/2-(s.selected.y+.5)*zoom.value};
}
function draw() {
  const el = canvas.value, map = s.map; if (!el || !map) return;
  const w = el.clientWidth, h = el.clientHeight, ratio = window.devicePixelRatio || 1;
  el.width = w * ratio; el.height = h * ratio;
  const ctx = el.getContext('2d'); ctx.scale(ratio, ratio); ctx.fillStyle = '#111b29'; ctx.fillRect(0,0,w,h);
  const size = zoom.value, ox = pan.value.x, oy = pan.value.y;
  const x0 = Math.max(0,Math.floor(-ox/size)), x1 = Math.min(map.width,Math.ceil((w-ox)/size));
  const y0 = Math.max(0,Math.floor(-oy/size)), y1 = Math.min(map.height,Math.ceil((h-oy)/size));
  for (let y=y0;y<y1;y++) for (let x=x0;x<x1;x++) {
    const mask = s.grid[y*map.width+x];
    ctx.fillStyle = mask == null || mask < 0 ? '#394255' : mask === 0 ? '#182231' : '#426454';
    ctx.fillRect(ox+x*size,oy+y*size,Math.max(1,size-1),Math.max(1,size-1));
    if (size >= 16 && mask > 0 && mask < 15) {
      ctx.strokeStyle = '#a6c4af'; ctx.lineWidth = 2;
      const cx=ox+(x+.5)*size, cy=oy+(y+.5)*size;
      [[0,1],[-1,0],[1,0],[0,-1]].forEach(([dx,dy],i) => { if (mask & (1<<i)) { ctx.beginPath(); ctx.moveTo(cx,cy); ctx.lineTo(cx+dx*size*.34,cy+dy*size*.34); ctx.stroke(); } });
    }
  }
  for (const event of map.events) {
    if (event.x < x0 || event.x >= x1 || event.y < y0 || event.y >= y1) continue;
    const cx=ox+(event.x+.5)*size,cy=oy+(event.y+.5)*size;
    ctx.fillStyle = event.erased || event.pageIndex < 0 ? '#8091a5' : '#f2bd62';
    ctx.beginPath(); ctx.arc(cx,cy,Math.max(2,size*.24),0,Math.PI*2); ctx.fill();
    if (size >= 30) { ctx.fillStyle='#101722'; ctx.font='10px sans-serif'; ctx.textAlign='center'; ctx.fillText(event.eventId,cx,cy+3); }
  }
  const player=map.player || map;
  ctx.fillStyle='#69c7ff'; ctx.beginPath(); ctx.arc(ox+((player.x??0)+.5)*size,oy+((player.y??0)+.5)*size,Math.max(3,size*.3),0,Math.PI*2); ctx.fill();
  const point=s.selected;
  if (point) { ctx.strokeStyle='#fff'; ctx.lineWidth=2; ctx.strokeRect(ox+point.x*size+1,oy+point.y*size+1,size-2,size-2); }
}
function down(e) { drag={x:e.clientX,y:e.clientY,pan:{...pan.value},moved:false}; e.currentTarget.setPointerCapture(e.pointerId); }
function move(e) { if (!drag) return; const dx=e.clientX-drag.x,dy=e.clientY-drag.y; if (Math.abs(dx)+Math.abs(dy)>4) drag.moved=true; if (drag.moved) { follow.value=false; pan.value={x:drag.pan.x+dx,y:drag.pan.y+dy}; } }
function up(e) {
  if (!drag) return;
  if (!drag.moved) {
    const rect=canvas.value.getBoundingClientRect(),x=Math.floor((e.clientX-rect.left-pan.value.x)/zoom.value),y=Math.floor((e.clientY-rect.top-pan.value.y)/zoom.value);
    if (s.map && x>=0 && y>=0 && x<s.map.width && y<s.map.height) props.tools.select(s.map.events.find(row=>row.x===x && row.y===y) || {x,y});
  }
  drag=null;
}
function scale(next) { const old=zoom.value; zoom.value=Math.max(5,Math.min(64,next)); const el=canvas.value; if (el) pan.value={x:el.clientWidth/2-(el.clientWidth/2-pan.value.x)*zoom.value/old,y:el.clientHeight/2-(el.clientHeight/2-pan.value.y)*zoom.value/old}; }
watch(() => [s.map, s.grid, s.selected, zoom.value, pan.value], draw, { deep: false, flush:'post' });
watch(() => s.map, () => { if(follow.value && !drag) center(); }, { flush:'post' });
watch(follow, value => { if(value) center(); });
onMounted(async () => { await nextTick(); resize=new ResizeObserver(()=>{ if(follow.value) center(); draw(); }); resize.observe(canvas.value); center(); draw(); props.tools.loadGrid(); });
onUnmounted(()=>resize?.disconnect());
</script>
<template>
  <div class="rm-event-map">
    <n-flex align="center" :size="8">
      <n-button size="small" @click="scale(zoom-4)" aria-label="缩小地图">−</n-button>
      <span>{{ zoom }} px / 格</span><n-button size="small" @click="scale(zoom+4)" aria-label="放大地图">＋</n-button>
      <n-checkbox v-model:checked="follow">跟随玩家</n-checkbox>
      <n-button size="small" @click="center">定位玩家</n-button>
      <n-button size="small" :disabled="!s.selected" @click="locatePoint">定位选点</n-button>
      <n-button size="small" :loading="s.gridLoading" @click="tools.loadGrid(true)">重读通行</n-button>
    </n-flex>
    <p class="rm-event-hint">拖动平移，滚轮缩放；点击只选中。蓝：玩家 · 黄：事件 · 灰：无生效页 / 已消除 · 绿：可通行 · 深色：阻挡 · 灰蓝：未知。通行数据为缓存快照。</p>
    <n-alert v-if="s.gridError" type="warning" :show-icon="false">{{ s.gridError }}</n-alert>
    <canvas ref="canvas" class="rm-event-canvas" aria-label="事件迷你地图，操作也可通过下方事件列表完成"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="drag=null" @wheel.prevent="scale(zoom + ($event.deltaY<0 ? 2 : -2))"/>
    <p v-if="s.gridLoading" class="rm-event-hint">正在分块读取地形通行信息…</p>
  </div>
</template>
