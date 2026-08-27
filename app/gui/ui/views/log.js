// 日志 — the GUI/bridge event stream, plus the per-game bridge.log on disk.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var ref = Vue.ref;
  var computed = Vue.computed;

  RMCH.views.Log = {
    name: "LogView",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var logRef = ref(null);
      var follow = ref(true);
      var filter = ref("");
      var bridgeGame = ref(null);
      var bridgeLog = ref("");

      var lines = computed(function () {
        var needle = filter.value.trim().toLowerCase();
        if (!needle) return store.state.log;
        return store.state.log.filter(function (line) {
          return line.toLowerCase().indexOf(needle) !== -1;
        });
      });

      // n-log keeps its own scroll container; nudge it whenever new lines land.
      Vue.watch(function () { return store.state.logSeq; }, function () {
        if (!follow.value) return;
        Vue.nextTick(function () {
          if (logRef.value) logRef.value.scrollTo({ position: "bottom" });
        });
      });

      function loadBridgeLog() {
        if (!bridgeGame.value) return;
        bridgeLog.value = store.readBridgeLog(bridgeGame.value) || "(no bridge log yet)";
      }

      return {
        store: store,
        state: store.state,
        gameOptions: store.liveGameOptions,
        logRef: logRef,
        follow: follow,
        filter: filter,
        lines: lines,
        bridgeGame: bridgeGame,
        bridgeLog: bridgeLog,
        loadBridgeLog: loadBridgeLog,
        clear: function () { store.state.log = []; }
      };
    },
    template: [
      '<n-flex vertical :size="14">',
      '  <n-card size="small" title="桥接事件 / 错误（实时）" :content-style="\'padding-top: 4px\'">',
      '    <template #header-extra>',
      '      <n-flex align="center" :size="10">',
      '        <n-input v-model:value="filter" size="small" placeholder="过滤" clearable style="width: 160px">',
      '          <template #prefix><rm-icon name="filter" :size="14"/></template>',
      '        </n-input>',
      '        <n-checkbox v-model:checked="follow">自动滚动</n-checkbox>',
      '        <n-button size="small" quaternary @click="clear">',
      '          <template #icon><rm-icon name="trash" :size="15"/></template>清空',
      '        </n-button>',
      '      </n-flex>',
      '    </template>',
      '    <n-flex vertical :size="8">',
      '      <n-text depth="3" style="font-size: 12px">{{ lines.length }} 行</n-text>',
      '      <n-log ref="logRef" :lines="lines" :rows="22" :font-size="12.5" trim/>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-card size="small" title="游戏内桥接日志（runtime/bridge-state/…/bridge.log）">',
      '    <template #header-extra><rm-icon name="log"/></template>',
      '    <n-flex vertical :size="10">',
      '      <n-flex align="center" :size="10" :wrap="true">',
      '        <n-select v-model:value="bridgeGame" :options="gameOptions" placeholder="选择运行中的游戏"',
      '                  clearable size="small" style="width: 260px"/>',
      '        <n-button size="small" tertiary :disabled="!bridgeGame" @click="loadBridgeLog">',
      '          <template #icon><rm-icon name="refresh" :size="15"/></template>读取最后 200 行',
      '        </n-button>',
      '      </n-flex>',
      '      <div v-if="bridgeLog" class="rm-mono" style="max-height: 30vh; overflow: auto">{{ bridgeLog }}</div>',
      '    </n-flex>',
      '  </n-card>',
      '</n-flex>'
    ].join("\n")
  };
})();
