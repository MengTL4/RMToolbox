<script setup>
import { computed, h, watch, ref, onDeactivated } from 'vue';
import EventMiniMap from '../parts/EventMiniMap.vue';
import DataInterpreterView from '../views/DataInterpreterView.vue';
import { useEventTools } from '../state/event-tools';
const tools = useEventTools('map'), s = tools.state, host = window.RMCH.store;
const dialog = host.gameDialog(naive.useDialog());
const rows = computed(() => (s.map?.events || []).filter(row => (row.eventId+' '+row.name).toLowerCase().includes(s.query.toLowerCase())));
const selected = computed(() => s.map?.events.find(row => row.eventId === s.selected?.eventId));
const disabled = computed(() => !tools.connected() || !!s.error || !!s.map?.busy || s.moving || !s.selected || !!selected.value?.erased || selected.value?.pageIndex<0);
const readerSource=ref(null), showReader=ref(false);
function inspect(row = selected.value) { if(!row) return; readerSource.value={kind:'map',id:row.eventId,mapToken:s.map?.mapToken}; showReader.value=true; s.mini=false; }
watch(()=>host.trainer.gameKey,()=>{showReader.value=false;readerSource.value=null;});
watch(()=>host.data.tab,tab=>{if(tab!=='map')showReader.value=false;});
onDeactivated(()=>{showReader.value=false;});
function force() {
  if (!selected.value || disabled.value) return;
  const point = {...s.selected, eventToken:selected.value.eventToken};
  dialog.warning({ title:'强制到事件坐标', content:'将与事件重叠，并忽略落点通行限制。剧情忙碌、地图变化或事件移动时仍会拒绝。', positiveText:'确认强制传送',negativeText:'取消',onPositiveClick:()=>tools.move(true,point) });
}
const columns = [
  {title:'ID',key:'eventId',width:56}, {title:'事件',key:'name',ellipsis:{tooltip:true}},
  {title:'坐标',key:'pos',width:76,render:r=>r.x+', '+r.y},
  {title:'生效页',key:'pageIndex',width:84,render:r=>r.erased?'已消除':r.pageIndex<0?'无':(r.pageIndex+1)+' / '+r.pages},
  {title:'操作',key:'actions',width:116,render:r=>h('div',{style:'display:flex;gap:6px'},[
    h(naive.NButton,{size:'tiny',onClick:()=>tools.select(r)},{default:()=>s.selected?.eventId===r.eventId?'已选':'定位'}),
    h(naive.NButton,{size:'tiny',disabled:!tools.connected() || !r.pages,onClick:()=>inspect(r)},{default:()=> '指令'})])}
];
const rowProps = row => ({ onClick:()=>tools.select(row), style:s.selected?.eventId===row.eventId?'background:var(--n-th-color);cursor:pointer':'cursor:pointer' });
watch(() => s.map?.mapToken, () => { if(s.mini) tools.loadGrid(); });
</script>
<template>
  <n-card size="small" title="当前地图事件">
    <template #header-extra><n-flex :size="6"><n-button size="small" :disabled="!s.map || !tools.connected()" @click="s.mini=true">事件迷你地图</n-button><n-button size="small" :loading="s.loading" :disabled="!tools.connected()" @click="tools.refresh">刷新</n-button></n-flex></template>
    <n-alert v-if="s.error || !tools.connected()" type="warning" :show-icon="false">{{ !tools.connected() ? '当前游戏已断开，刷新与传送已停止' : s.error }}</n-alert>
    <p class="rm-event-hint" v-if="s.map">#{{ s.map.mapId }} {{ s.map.mapName }} · {{ s.map.width }} × {{ s.map.height }} · 玩家 ({{ s.map.x }}, {{ s.map.y }}) · {{ s.map.events.length }} 个事件 · 可见时每秒刷新</p>
    <n-input v-model:value="s.query" size="small" clearable placeholder="搜索当前地图事件名称或 ID"/>
    <n-data-table :columns="columns" :data="rows" :row-props="rowProps" :row-key="r=>r.eventId" :max-height="300" :virtual-scroll="true" size="small" :bordered="false"/>
    <n-flex align="center" :size="8" style="margin-top:10px">
      <span v-if="s.selected">{{ selected ? '#'+selected.eventId+' '+selected.name : '格子' }} ({{ selected?.x ?? s.selected.x }}, {{ selected?.y ?? s.selected.y }})</span>
      <n-button size="small" type="primary" :disabled="disabled" :loading="s.moving" @click="tools.move()">{{ selected ? '传送到事件旁' : '传送到选中格' }}</n-button>
      <n-button v-if="selected" size="small" :disabled="disabled" @click="force">强制到事件坐标…</n-button>
    </n-flex>
    <p v-if="s.map?.busy" class="rm-event-hint">暂不可传送：{{ s.map.busy }}</p>
  </n-card>
  <n-modal v-model:show="s.mini" preset="card" title="事件迷你地图" style="width:min(1100px,94vw);max-height:94vh;overflow:auto" :mask-closable="false">
    <event-mini-map v-if="s.mini" :tools="tools"/>
    <n-flex align="center" :size="8" style="margin-top:12px">
      <span>{{ s.selected ? '('+s.selected.x+', '+s.selected.y+')' : '点击地图选择事件或格子' }}</span>
      <n-select v-if="s.selected" size="small" style="width:230px" placeholder="此格事件" :value="s.selected.eventId ?? null"
        :options="(s.map?.events || []).filter(e=>e.x===s.selected.x && e.y===s.selected.y).map(e=>({label:'#'+e.eventId+' '+e.name,value:e.eventId}))"
        @update:value="id=>tools.select(s.map.events.find(e=>e.eventId===id))"/>
      <n-button size="small" type="primary" :disabled="disabled" :loading="s.moving" @click="tools.move()">{{ selected ? '传送到事件旁' : '传送到选中格' }}</n-button>
      <n-button size="small" :disabled="!selected || disabled" @click="force">强制到事件坐标…</n-button>
      <n-button size="small" :disabled="!selected || !tools.connected()" @click="inspect()">查看事件指令</n-button>
    </n-flex>
    <p v-if="s.error || s.map?.busy || !tools.connected()" class="rm-event-hint">{{ !tools.connected() ? '游戏已断开' : s.error || s.map.busy }}</p>
  </n-modal>
  <n-modal v-model:show="showReader" preset="card" title="地图事件指令" style="width:min(1100px,94vw);max-height:94vh;overflow:auto">
    <data-interpreter-view v-if="showReader" :source="readerSource" visible-key="map"/>
  </n-modal>
</template>
