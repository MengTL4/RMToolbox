// 修改器 — game picker + live status bar, then the card board assembled from
// ui/views/trainer-{cheats,actors,data}.js.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var trainer = store.trainer;
  var computed = Vue.computed;

  // Card order. Dealt round-robin into however many columns fit, so at three
  // columns this is the grouping below and it degrades sensibly at two and one.
  //   col A: 开关 · 战斗       col B: 倍率 · 场景修复      col C: 金钱 · 快捷
  //
  // The per-entry data editors (物品/装备/武器/开关/变量/角色/地图/存档数据) live
  // in the 数据 tab — this board is the always-visible cheat overview.
  var CARDS = [
    "cheat-toggles", "cheat-rates", "gold-panel",
    "battle-panel", "scene-tools", "quick-actions"
  ];

  var COLUMN_MIN = 420;   // px; below this the switch pairs stop fitting two-up
  var COLUMN_GAP = 14;
  var COLUMN_MAX = 3;

  RMCH.views.Trainer = {
    name: "TrainerView",
    components: {
      RmIcon: RMCH.Icon,
      CheatToggles: RMCH.parts.CheatToggles,
      CheatRates: RMCH.parts.CheatRates,
      QuickActions: RMCH.parts.QuickActions,
      BattlePanel: RMCH.parts.BattlePanel,
      GoldPanel: RMCH.parts.GoldPanel,
      SceneTools: RMCH.parts.SceneTools
    },
    setup: function () {
      var scene = computed(function () {
        if (!trainer.live) return null;
        return trainer.live.inBattle ? { label: "战斗中", type: "error" } : { label: "地图上", type: "success" };
      });

      var mapId = computed(function () {
        return trainer.live && trainer.live.map && trainer.live.map.mapId != null
          ? trainer.live.map.mapId : null;
      });

      var engine = computed(function () {
        return (trainer.live && trainer.live.engine && trainer.live.engine.maker) || null;
      });

      var loadingAny = computed(function () {
        return Object.keys(trainer.loading).some(function (key) { return trainer.loading[key]; });
      });

      // --- responsive column count ------------------------------------------
      var boardRef = Vue.ref(null);
      var columnCount = Vue.ref(2);
      var observer = null;

      function measure() {
        var node = boardRef.value;
        if (!node || !node.clientWidth) return;
        var fits = Math.floor((node.clientWidth + COLUMN_GAP) / (COLUMN_MIN + COLUMN_GAP));
        columnCount.value = Math.max(1, Math.min(COLUMN_MAX, fits));
      }

      Vue.onMounted(function () {
        measure();
        if (window.ResizeObserver && boardRef.value) {
          observer = new window.ResizeObserver(measure);
          observer.observe(boardRef.value);
        } else {
          window.addEventListener("resize", measure);
        }
      });
      // keep-alive: the board is detached while other tabs are open, so its
      // width is only meaningful again on re-activation.
      Vue.onActivated(function () { Vue.nextTick(measure); });
      Vue.onUnmounted(function () {
        if (observer) observer.disconnect();
        else window.removeEventListener("resize", measure);
      });

      var columns = computed(function () {
        var count = columnCount.value;
        var buckets = [];
        for (var i = 0; i < count; i += 1) buckets.push([]);
        CARDS.forEach(function (name, index) { buckets[index % count].push(name); });
        return buckets;
      });

      return {
        store: store,
        trainer: trainer,
        gameOptions: store.liveGameOptions,
        scene: scene,
        mapId: mapId,
        engine: engine,
        loadingAny: loadingAny,
        boardRef: boardRef,
        columns: columns
      };
    },
    template: [
      '<n-flex vertical :size="14">',

      '  <n-card size="small">',
      '    <n-flex align="center" :size="10" :wrap="true">',
      '      <n-select :value="trainer.gameKey" :options="gameOptions" placeholder="选择运行中的游戏"',
      '                clearable style="width: 260px" @update:value="store.selectGame"/>',
      '      <n-tag v-if="engine" size="small" :bordered="false" type="info">{{ engine }}</n-tag>',
      '      <n-tag v-if="scene" size="small" :bordered="false" :type="scene.type">{{ scene.label }}</n-tag>',
      '      <n-tag v-if="mapId !== null" size="small" :bordered="false">map {{ mapId }}</n-tag>',
      '      <n-tag v-if="trainer.gold !== null" size="small" :bordered="false" type="warning">',
      '        <template #icon><rm-icon name="coins" :size="13"/></template>{{ trainer.gold }}',
      '      </n-tag>',
      '      <n-spin v-if="loadingAny" :size="14"/>',
      '      <div style="flex: 1"></div>',
      '      <n-button size="small" tertiary :disabled="!trainer.gameKey" @click="$emit(\'open-data\')">',
      '        <template #icon><rm-icon name="layers" :size="15"/></template>物品 / 角色 / 存档数据 →',
      '      </n-button>',
      '      <n-text v-if="trainer.gameKey && !trainer.live" depth="3" style="font-size: 12px">',
      '        等待游戏推送状态…（游戏还在标题画面时也会这样）',
      '      </n-text>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-result v-if="!trainer.gameKey" status="info" size="small" title="还没有选中游戏"',
      '            description="在「游戏库」启动一个游戏（会自动注入桥接），然后在上面的下拉框里选它。"',
      '            style="padding: 40px 0">',
      '    <template #footer>',
      '      <n-button type="primary" @click="$emit(\'open-library\')">',
      '        <template #icon><rm-icon name="gamepad" :size="15"/></template>去游戏库',
      '      </n-button>',
      '    </template>',
      '  </n-result>',

      '  <div v-else ref="boardRef" class="rm-board">',
      '    <div v-for="(bucket, index) in columns" :key="index" class="rm-board-col">',
      '      <component v-for="name in bucket" :key="name" :is="name"/>',
      '    </div>',
      '  </div>',

      '</n-flex>'
    ].join("\n"),
    emits: ["open-library", "open-data"]
  };
})();
