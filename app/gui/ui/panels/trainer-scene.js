// 修改器 · 场景跳转 + 修复错误（MTool 场景管理器.push / 修复错误）

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  var store = RMCH.store;
  var data = store.data;
  var computed = Vue.computed;

  // Scene → label. The bridge only reports the ones the game actually defines.
  var SCENE_LABELS = {
    Scene_Item: "物品",
    Scene_Skill: "技能",
    Scene_Equip: "装备",
    Scene_Status: "状态",
    Scene_Menu: "菜单",
    Scene_Save: "保存",
    Scene_Load: "读取",
    Scene_Options: "设置",
    Scene_Debug: "调试",
    Scene_Shop: "商店",
    Scene_Name: "改名",
    Scene_GameEnd: "结束"
  };

  // These expect prepare(...) arguments from a game event (shop goods list,
  // name-entry actor id) — pushed bare they crash the game with a TypeError
  // (实测：大千世界2 点「商店」→ Window_ShopBuy.makeItemList forEach of
  // undefined). Never offer them.
  var SCENE_SKIP = { Scene_Shop: true, Scene_Name: true };

  // Each of these unsticks a specific way RPG Maker games wedge themselves.
  var REPAIRS = [
    { action: "clearCurrentEvent", label: "清除当前事件", icon: "close", hint: "事件卡住不动时清空解释器" },
    { action: "clearPictures", label: "清除所有图片", icon: "trash", hint: "残留立绘 / 黑幕挡住画面" },
    { action: "fadeIn", label: "淡入屏幕", icon: "sun", hint: "淡出后没淡回来" },
    { action: "clearMoveRoute", label: "清除移动路由", icon: "pin", hint: "被强制移动锁住" },
    { action: "gotoMap", label: "转至地图", icon: "pin", hint: "从卡住的场景回到地图" },
    { action: "gotoTitle", label: "转至标题", icon: "power", hint: "彻底回标题画面" }
  ];

  RMCH.parts.SceneTools = {
    name: "SceneTools",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var dialog = naive.useDialog();

      var scenes = computed(function () {
        return data.scenes.filter(function (name) { return !SCENE_SKIP[name]; })
          .map(function (name) {
            return { name: name, label: SCENE_LABELS[name] || name.replace(/^Scene_/, "") };
          });
      });

      function repair(entry) {
        if (entry.action !== "gotoTitle") return store.repair(entry.action, entry.label);
        dialog.warning({
          title: "转至标题",
          content: "会直接回到标题画面，未保存的进度会丢失。",
          positiveText: "回标题",
          negativeText: "取消",
          onPositiveClick: function () { store.repair(entry.action, entry.label); }
        });
      }

      return { store: store, data: data, scenes: scenes, repairs: REPAIRS, repair: repair };
    },
    template: [
      '<n-card size="small" title="场景与修复">',
      '  <template #header-extra><rm-icon name="wand"/></template>',
      '  <n-flex vertical :size="12">',
      '    <div>',
      '      <n-flex align="center" :size="8" style="margin-bottom: 8px">',
      '        <n-text depth="3" style="font-size: 12px">打开游戏自己的界面</n-text>',
      '        <n-button size="tiny" quaternary @click="store.loadScenes()">',
      '          <template #icon><rm-icon name="refresh" :size="13"/></template>',
      '        </n-button>',
      '      </n-flex>',
      '      <n-flex :size="6" :wrap="true">',
      '        <n-button v-for="scene in scenes" :key="scene.name" size="small" tertiary',
      '                  @click="store.pushScene(scene.name)">{{ scene.label }}</n-button>',
      '        <n-button size="small" secondary @click="store.popScene()">',
      '          <template #icon><rm-icon name="close" :size="14"/></template>弹出场景',
      '        </n-button>',
      '        <n-text v-if="!scenes.length" depth="3" style="font-size: 12px">等待游戏数据…</n-text>',
      '      </n-flex>',
      '    </div>',

      '    <n-divider style="margin: 0"/>',

      '    <div>',
      '      <n-text depth="3" style="font-size: 12px">卡死 / 黑屏时的急救</n-text>',
      '      <n-flex :size="6" :wrap="true" style="margin-top: 8px">',
      '        <n-tooltip v-for="entry in repairs" :key="entry.action" trigger="hover">',
      '          <template #trigger>',
      '            <n-button size="small" :type="entry.action === \'gotoTitle\' ? \'error\' : \'default\'"',
      '                      :secondary="entry.action === \'gotoTitle\'" :tertiary="entry.action !== \'gotoTitle\'"',
      '                      @click="repair(entry)">',
      '              <template #icon><rm-icon :name="entry.icon" :size="14"/></template>{{ entry.label }}',
      '            </n-button>',
      '          </template>',
      '          {{ entry.hint }}',
      '        </n-tooltip>',
      '      </n-flex>',
      '    </div>',
      '  </n-flex>',
      '</n-card>'
    ].join("\n")
  };
})();
