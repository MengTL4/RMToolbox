// 数据 tab — game picker + lock toolbar + MTool-style sub-tabs.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var data = store.data;
  var trainer = store.trainer;
  var computed = Vue.computed;

  var SUB_TABS = [
    { key: "item", label: "物品" },
    { key: "armor", label: "装备" },
    { key: "weapon", label: "武器" },
    { key: "switch", label: "开关" },
    { key: "variable", label: "变量" },
    { key: "actor", label: "角色" },
    { key: "map", label: "地图" },
    { key: "event", label: "公共事件" },
    { key: "tree", label: "存档数据" }
  ];

  RMCH.views.Data = {
    name: "DataView",
    components: {
      RmIcon: RMCH.Icon,
      DataItems: RMCH.views.DataItems,
      DataFlags: RMCH.views.DataFlags,
      DataActors: RMCH.views.DataActors,
      DataMap: RMCH.views.DataMap,
      DataEvents: RMCH.views.DataEvents,
      DataTree: RMCH.views.DataTree
    },
    emits: ["open-library"],
    setup: function () {
      var dialog = naive.useDialog();

      var totalLocks = computed(function () {
        var count = data.locks.gold == null ? 0 : 1;
        ["item", "weapon", "armor", "switch", "variable"].forEach(function (kind) {
          count += Object.keys(data.locks[kind] || {}).length;
        });
        return count;
      });

      function confirmClear() {
        dialog.warning({
          title: "清空全部锁定",
          content: "会解除所有物品 / 开关 / 变量 / 金钱的锁定（不影响游戏当前数值）。",
          positiveText: "清空",
          negativeText: "取消",
          onPositiveClick: function () { store.clearLocks(null); }
        });
      }

      return {
        store: store,
        data: data,
        trainer: trainer,
        subTabs: SUB_TABS,
        gameOptions: store.liveGameOptions,
        totalLocks: totalLocks,
        confirmClear: confirmClear
      };
    },
    template: [
      '<n-flex vertical :size="14">',
      '  <n-card size="small">',
      '    <n-flex align="center" :size="10" :wrap="true">',
      '      <n-select :value="trainer.gameKey" :options="gameOptions" placeholder="选择运行中的游戏"',
      '                clearable size="small" style="width: 240px" @update:value="store.selectGame"/>',
      '      <n-tag size="small" :bordered="false" :type="totalLocks ? \'warning\' : \'default\'">',
      '        <template #icon><rm-icon name="toggle" :size="13"/></template>已锁定 {{ totalLocks }} 项',
      '      </n-tag>',
      '      <n-button-group size="small">',
      '        <n-button :disabled="!trainer.gameKey" @click="store.saveLockFile()">',
      '          <template #icon><rm-icon name="save" :size="15"/></template>保存锁定状态',
      '        </n-button>',
      '        <n-button :disabled="!trainer.gameKey || !data.lockFileExists" @click="store.loadLockFile()">',
      '          <template #icon><rm-icon name="archive" :size="15"/></template>读取锁定状态',
      '        </n-button>',
      '        <n-button :disabled="!totalLocks" @click="confirmClear">',
      '          <template #icon><rm-icon name="trash" :size="15"/></template>清空',
      '        </n-button>',
      '      </n-button-group>',
      '      <div style="flex: 1"></div>',
      '      <n-text v-if="data.lockStats" depth="3" style="font-size: 11.5px">',
      '        回写 {{ data.lockStats.applied }} 帧{{ data.lockStats.errors ? " · 错误 " + data.lockStats.errors : "" }}',
      '      </n-text>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-result v-if="!trainer.gameKey" status="info" size="small" title="还没有选中游戏"',
      '            description="在「游戏库」启动一个游戏，然后在上面的下拉框里选它。" style="padding: 40px 0">',
      '    <template #footer>',
      '      <n-button type="primary" @click="$emit(\'open-library\')">',
      '        <template #icon><rm-icon name="gamepad" :size="15"/></template>去游戏库',
      '      </n-button>',
      '    </template>',
      '  </n-result>',

      '  <n-tabs v-else v-model:value="data.tab" type="segment" size="small" animated>',
      '    <n-tab-pane v-for="tab in subTabs" :key="tab.key" :name="tab.key" :tab="tab.label"',
      '                display-directive="show:lazy">',
      '      <data-items v-if="tab.key === \'item\' || tab.key === \'weapon\' || tab.key === \'armor\'" :kind="tab.key"/>',
      '      <data-flags v-else-if="tab.key === \'switch\' || tab.key === \'variable\'" :kind="tab.key"/>',
      '      <data-actors v-else-if="tab.key === \'actor\'"/>',
      '      <data-map v-else-if="tab.key === \'map\'"/>',
      '      <data-events v-else-if="tab.key === \'event\'"/>',
      '      <data-tree v-else-if="tab.key === \'tree\'"/>',
      '    </n-tab-pane>',
      '  </n-tabs>',
      '</n-flex>'
    ].join("\n")
  };
})();
