// 数据 › 地图 — map list on the left, transfer controls plus the current map's
// events on the right (MTool's 地图 tab, minus the event decompiler).

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var data = store.data;
  var trainer = store.trainer;
  var h = Vue.h;
  var computed = Vue.computed;

  var NButton = naive.NButton;
  var NFlex = naive.NFlex;
  var NSwitch = naive.NSwitch;

  RMCH.views.DataMap = {
    name: "DataMapView",
    components: {
      RmIcon: RMCH.Icon,
      RmEntryList: RMCH.parts.EntryList
    },
    setup: function () {
      var listHeight = computed(function () { return Math.max(240, store.viewport.height - 340); });

      var currentMapId = computed(function () {
        return trainer.live && trainer.live.map && trainer.live.map.mapId != null
          ? trainer.live.map.mapId : null;
      });

      function transfer() {
        store.cmd("map.transfer", {
          mapId: Number(trainer.transfer.mapId),
          x: Number(trainer.transfer.x) || 0,
          y: Number(trainer.transfer.y) || 0
        }).then(function (payload) {
          if (payload) store.ok("已传送到 map " + payload.mapId + " (" + payload.x + ", " + payload.y + ")");
        });
      }

      function here() {
        store.cmd("player.location", {}).then(function (payload) {
          if (!payload) return;
          trainer.transfer.mapId = payload.mapId;
          trainer.transfer.x = payload.x;
          trainer.transfer.y = payload.y;
          store.info("当前位置 map " + payload.mapId + " (" + payload.x + ", " + payload.y + ")");
        });
      }

      function toEvent(row) {
        store.cmd("map.transferToEvent", { eventId: row.eventId }).then(function (payload) {
          if (payload) store.ok("已移动到事件 #" + payload.eventId + " (" + payload.x + ", " + payload.y + ")");
        });
      }

      var eventColumns = [
        { title: "ID", key: "eventId", width: 58 },
        { title: "名称", key: "name", ellipsis: { tooltip: true } },
        {
          title: "位置",
          key: "pos",
          width: 82,
          render: function (row) {
            return h("span", { style: "font-variant-numeric: tabular-nums" }, row.x + ", " + row.y);
          }
        },
        {
          title: "页 / 指令",
          key: "pages",
          width: 88,
          render: function (row) {
            return h("span", { style: "font-variant-numeric: tabular-nums" },
              (row.pageIndex == null ? "-" : row.pageIndex) + " / " + row.commands);
          }
        },
        {
          title: "",
          key: "actions",
          width: 78,
          render: function (row) {
            return h(NFlex, { size: 6, wrap: false, justify: "end" }, {
              default: function () {
                return [h(NButton, {
                  size: "tiny", secondary: true,
                  onClick: function () { toEvent(row); }
                }, { default: function () { return "走过去"; } })];
              }
            });
          }
        }
      ];

      var selfSwitchColumns = [
        { title: "事件", key: "eventId", width: 64 },
        { title: "开关", key: "letter", width: 60 },
        {
          title: "状态",
          key: "value",
          width: 72,
          render: function (row) {
            return h(NSwitch, {
              size: "small",
              value: !!row.value,
              "onUpdate:value": function (value) { store.setSelfSwitch(row, value); }
            });
          }
        }
      ];

      return {
        store: store,
        data: data,
        trainer: trainer,
        listHeight: listHeight,
        currentMapId: currentMapId,
        eventColumns: eventColumns,
        selfSwitchColumns: selfSwitchColumns,
        transfer: transfer,
        here: here,
        select: function (row) {
          trainer.transfer.mapId = row.id;
          store.info("已填入地图 #" + row.id + "「" + (row.name || "") + "」");
        },
        mapMark: function (row) { return row.id === currentMapId.value ? "当前" : ""; },
        queryOf: computed(function () { return trainer.mapQuery; })
      };
    },
    template: [
      '<div class="rm-md">',
      '  <n-card class="rm-md-list" size="small" title="地图列表">',
      '    <template #header-extra>',
      '      <n-button size="tiny" quaternary :loading="trainer.loading.maps" @click="store.loadMaps()">',
      '        <template #icon><rm-icon name="refresh" :size="14"/></template>',
      '      </n-button>',
      '    </template>',
      '    <rm-entry-list :entries="trainer.maps" :selected-id="trainer.transfer.mapId" :query="queryOf"',
      '                   value-label="" :value-of="mapMark"',
      '                   :height="listHeight" :loading="trainer.loading.maps"',
      '                   empty-text="等待游戏数据加载…" placeholder="搜索地图名称或 ID"',
      '                   @update:query="v => trainer.mapQuery = v" @select="select"/>',
      '  </n-card>',

      '  <div class="rm-md-detail">',
      '    <n-flex vertical :size="14">',
      '      <n-card size="small" title="传送">',
      '        <template #header-extra><rm-icon name="pin"/></template>',
      '        <n-flex vertical :size="10">',
      '          <n-flex :size="6" :wrap="false">',
      '            <n-input-number v-model:value="trainer.transfer.mapId" size="small" placeholder="地图 ID"',
      '                            :min="1" :show-button="false" style="flex: 1.2"/>',
      '            <n-input-number v-model:value="trainer.transfer.x" size="small" placeholder="X"',
      '                            :min="0" :show-button="false" style="flex: 1"/>',
      '            <n-input-number v-model:value="trainer.transfer.y" size="small" placeholder="Y"',
      '                            :min="0" :show-button="false" style="flex: 1"/>',
      '          </n-flex>',
      '          <n-flex :size="8" :wrap="true">',
      '            <n-button size="small" type="primary" @click="transfer">',
      '              <template #icon><rm-icon name="pin" :size="15"/></template>传送',
      '            </n-button>',
      '            <n-button size="small" tertiary @click="here">读取当前坐标</n-button>',
      '            <n-button size="small" tertiary',
      '                      @click="trainer.transfer.x = 0; trainer.transfer.y = 0; transfer()">传送至 0,0</n-button>',
      '            <n-text depth="3" style="font-size: 12px">当前 map {{ currentMapId == null ? "-" : currentMapId }}</n-text>',
      '          </n-flex>',
      '        </n-flex>',
      '      </n-card>',

      '      <n-card size="small" title="当前地图事件">',
      '        <template #header-extra>',
      '          <n-button size="tiny" quaternary :loading="data.loading.mapEvents" @click="store.loadMapEvents()">',
      '            <template #icon><rm-icon name="refresh" :size="14"/></template>读取',
      '          </n-button>',
      '        </template>',
      '        <n-flex vertical :size="10">',
      '          <n-text depth="3" style="font-size: 12px">',
      '            {{ data.mapEvents.length ? data.mapEvents.length + " 个事件（页 / 指令 = 当前生效页 / 该页指令数）"',
      '                                  : "点「读取」列出玩家所在地图上的事件" }}',
      '          </n-text>',
      '          <n-data-table v-if="data.mapEvents.length" :columns="eventColumns" :data="data.mapEvents" size="small"',
      '                        :bordered="false" :row-key="row => row.eventId" :max-height="300"',
      '                        :loading="data.loading.mapEvents"/>',
      '        </n-flex>',
      '      </n-card>',

      '      <n-card size="small" title="独立开关">',
      '        <template #header-extra><rm-icon name="toggle"/></template>',
      '        <n-flex vertical :size="10">',
      '          <n-input-group>',
      '            <n-input-number v-model:value="data.selfSwitches.mapId" size="small" placeholder="地图 ID"',
      '                            :min="1" :show-button="false" style="flex: 1"',
      '                            @keyup.enter="store.loadSelfSwitches()"/>',
      '            <n-button size="small" type="primary" :loading="data.loading.selfSwitches"',
      '                      @click="store.loadSelfSwitches()">',
      '              <template #icon><rm-icon name="search" :size="15"/></template>列出',
      '            </n-button>',
      '            <n-button size="small" tertiary :disabled="currentMapId == null"',
      '                      @click="store.loadSelfSwitches(currentMapId)">当前地图</n-button>',
      '          </n-input-group>',
      '          <n-text depth="3" style="font-size: 12px">',
      '            只有被事件设置过的独立开关才存在（RPG Maker 是稀疏存储），点开关直接切换。',
      '            {{ data.selfSwitches.entries.length ? "共 " + data.selfSwitches.entries.length + " 个" : "" }}',
      '          </n-text>',
      '          <n-data-table v-if="data.selfSwitches.entries.length" :columns="selfSwitchColumns"',
      '                        :data="data.selfSwitches.entries" size="small" :bordered="false"',
      '                        :row-key="row => row.eventId + row.letter" :max-height="260"',
      '                        :loading="data.loading.selfSwitches"/>',
      '        </n-flex>',
      '      </n-card>',
      '    </n-flex>',
      '  </div>',
      '</div>'
    ].join("\n")
  };
})();
