// 数据 › 公共事件 — list every common event and run one (MTool 公共事件 tab,
// minus its event decompiler).

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var data = store.data;
  var ref = Vue.ref;
  var computed = Vue.computed;

  RMCH.views.DataEvents = {
    name: "DataEventsView",
    components: { RmIcon: RMCH.Icon, RmEntryList: RMCH.parts.EntryList },
    setup: function () {
      var running = ref(false);
      var entries = computed(function () { return data.events; });

      var selectedId = computed(function () { return data.selected.event; });
      var selected = computed(function () {
        var id = selectedId.value;
        if (id == null) return null;
        return entries.value.filter(function (entry) { return entry.id === id; })[0] || null;
      });

      function run() {
        if (!selected.value) return;
        running.value = true;
        store.cmd("commonEvent.run", { id: selected.value.id })
          .then(function (payload) {
            if (payload) store.ok("已触发公共事件 #" + payload.id + " " + (payload.name || ""));
          })
          .finally(function () { running.value = false; });
      }

      var listHeight = computed(function () { return Math.max(240, store.viewport.height - 340); });

      return {
        store: store,
        data: data,
        entries: entries,
        running: running,
        selected: selected,
        selectedId: selectedId,
        listHeight: listHeight,
        run: run,
        select: function (row) { data.selected.event = row.id; },
        queryOf: computed(function () { return data.query.event; })
      };
    },
    template: [
      '<div class="rm-md">',
      '  <n-card class="rm-md-list" size="small" title="公共事件">',
      '    <template #header-extra>',
      '      <n-button size="tiny" quaternary :loading="data.loading.events" @click="store.loadCommonEvents()">',
      '        <template #icon><rm-icon name="refresh" :size="14"/></template>',
      '      </n-button>',
      '    </template>',
      '    <rm-entry-list :entries="entries" :selected-id="selectedId" :query="queryOf"',
      '                   :height="listHeight" :loading="data.loading.events" empty-text="等待游戏数据加载…"',
      '                   @update:query="v => data.query.event = v" @select="select"/>',
      '  </n-card>',

      '  <n-card class="rm-md-detail" size="small"',
      '          :title="selected ? \'#\' + selected.id + \' \' + (selected.name || \'(无名)\') : \'详情\'">',
      '    <template #header-extra><rm-icon name="zap"/></template>',
      '    <n-empty v-if="!selected" description="在左边点一个公共事件" style="padding: 40px 0"/>',
      '    <n-flex v-else vertical :size="14">',
      '      <n-alert type="warning" :bordered="false" style="font-size: 12.5px">',
      '        公共事件是游戏自己的脚本。跑一个与当前剧情无关的事件可能把存档改成异常状态 ——',
      '        先在「存档」页备份。',
      '      </n-alert>',
      '      <n-button type="primary" :loading="running" @click="run">',
      '        <template #icon><rm-icon name="play" :size="15"/></template>运行这个公共事件',
      '      </n-button>',
      '    </n-flex>',
      '  </n-card>',
      '</div>'
    ].join("\n")
  };
})();
