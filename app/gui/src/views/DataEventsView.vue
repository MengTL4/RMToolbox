<script>
import Component_RmIcon from '../shell/RmIcon.vue';
import Component_RmEntryList from '../parts/RmEntryList.vue';
import DataInterpreterView from './DataInterpreterView.vue';
import { useEventTools } from '../state/event-tools';
import { confirmExecution, executionActive, executionLabels } from '../state/event-execution-ui';

var RMCH = (window.RMCH = window.RMCH || {});

var store = RMCH.store;

var data = store.data;

var ref = Vue.ref;

var computed = Vue.computed;

export default {
    name: "DataEventsView",
    components: { RmIcon: Component_RmIcon, RmEntryList: Component_RmEntryList, DataInterpreterView },
    setup: function () {
      var running = ref(false);
      const tools=useEventTools('event'), showReader=ref(false), dialog=store.gameDialog(naive.useDialog());
      const source=computed(()=>selected.value?{kind:'common',id:selected.value.id}:null);
      var entries = computed(function () { return data.events; });

      var selectedId = computed(function () { return data.selected.event; });
      var selected = computed(function () {
        var id = selectedId.value;
        if (id == null) return null;
        return entries.value.filter(function (entry) { return entry.id === id; })[0] || null;
      });

      async function run() {
        if (!selected.value) return;
        const id=selected.value.id, epoch=store.state.selectionEpoch;
        running.value = true;
        try {
          await tools.read({kind:'common',id});
          if(epoch!==store.state.selectionEpoch || selected.value?.id!==id) return;
          if(!tools.state.reader?.execution?.whole) {store.warn(tools.state.readError || tools.state.reader?.executionError || '执行接口不可用');return;}
          await confirmExecution(tools,tools.state.reader.execution.whole,true,dialog,store);
        } finally {running.value=false;}
      }

      var listHeight = computed(function () { return Math.max(240, store.viewport.height - 340); });
      function toggleReader() {
        showReader.value=!showReader.value;
        if(showReader.value)Vue.nextTick(()=>document.getElementById('rm-common-event-detail')?.scrollIntoView({block:'start',behavior:'smooth'}));
      }

      return {
        store: store,
        data: data,
        entries: entries,
        running: running,
        selected: selected,
        selectedId: selectedId,
        listHeight: listHeight,
        run: run,
        tools, showReader, source, execution:tools.currentExecution, executionActive, executionLabels, toggleReader,
        select: function (row) { data.selected.event = row.id; },
        queryOf: computed(function () { return data.query.event; })
      };
    },

  };
</script>

<template>
<div class="rm-md">
  <n-card class="rm-md-list" size="small" title="公共事件">
    <template #header-extra>
      <n-button size="tiny" quaternary :loading="data.loading.events" @click="store.loadCommonEvents()">
        <template #icon><rm-icon name="refresh" :size="14"/></template>
      </n-button>
    </template>
    <rm-entry-list :entries="entries" :selected-id="selectedId" :query="queryOf"
                   :height="listHeight" :loading="data.loading.events" empty-text="等待游戏数据加载…"
                   @update:query="v => data.query.event = v" @select="select"/>
  </n-card>
  <n-card id="rm-common-event-detail" class="rm-md-detail" size="small"
          :title="selected ? '#' + selected.id + ' ' + (selected.name || '(无名)') : '详情'">
    <template #header-extra><rm-icon name="zap"/></template>
    <n-empty v-if="!selected" description="在左边点一个公共事件" style="padding: 40px 0"/>
    <n-flex v-else vertical :size="14">
      <n-alert type="warning" :bordered="false" style="font-size: 12.5px">
        公共事件是游戏自己的脚本。跑一个与当前剧情无关的事件可能把存档改成异常状态 ——
        先在「存档」页备份。
      </n-alert>
      <n-flex :size="8">
      <n-button type="primary" :loading="running" :disabled="!tools.connected() || executionActive(execution) || !!execution?.pending" @click="run">
        <template #icon><rm-icon name="play" :size="15"/></template>运行这个公共事件
      </n-button>
      <n-button @click="toggleReader">{{ showReader?'收起事件解释器':'事件解释器' }}</n-button>
      </n-flex>
      <p v-if="execution?.id" class="rm-event-hint">公共事件 #{{ execution.eventId }}：{{ !tools.connected() || execution.unknown?'执行状态待核实':executionLabels[execution.state] }}</p>
      <data-interpreter-view v-if="showReader" :source="source" visible-key="event" :executable="true"/>
    </n-flex>
  </n-card>
</div>
</template>
