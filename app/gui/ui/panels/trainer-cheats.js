// 修改器 · 作弊开关 / 倍率 / 快捷操作 / 战斗

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};
  RMCH.parts = RMCH.parts || {};

  var store = RMCH.store;
  var trainer = store.trainer;
  var h = Vue.h;
  var ref = Vue.ref;
  var computed = Vue.computed;

  var NButton = naive.NButton;
  var NInputNumber = naive.NInputNumber;
  var NFlex = naive.NFlex;

  // Tuple: [optionKey, label, tooltip?]. The lock* toggles are god-mode method
  // hooks (the bridge intercepts battler HP/MP/TP changes and restores them) —
  // a different mechanism from the 数据 tab's per-frame value locks, so the
  // tooltip spells that out where the names would otherwise read the same.
  var BOOL_OPTIONS = [
    ["invincible", "无敌"],
    ["oneHitKill", "一击必杀"],
    ["noSkillCost", "免技能消耗"],
    ["throughWalls", "穿墙"],
    ["noEncounter", "无遇敌"],
    ["showFollowers", "显示跟随者"],
    ["alwaysDash", "常时奔跑"],
    ["speedHoldCtrl", "按住 Ctrl 加速"],
    ["lockHp", "锁 HP", "上帝模式钩子：角色掉血后立即补回锁定值。与「数据」页对存档数据的逐帧锁定是两套机制，互不影响"],
    ["lockHpMax", "锁 HP 上限", "上帝模式钩子：锁 HP 时以上限值为补回目标"],
    ["lockMp", "锁 MP", "上帝模式钩子：技能耗蓝后立即补回锁定值"],
    ["lockTp", "锁 TP", "上帝模式钩子：TP 变化后立即补回锁定值"]
  ];

  var NUM_OPTIONS = [
    ["expRate", "经验倍率", 0, 0.1],
    ["goldRate", "金币倍率", 0, 0.1],
    ["dropRate", "掉落倍率", 0, 0.1],
    ["moveSpeedAdd", "移速加成", 0, 1],
    ["gameSpeedMulti", "加速倍率", 1, 1],
    ["lockHpVal", "锁 HP 值", 0, 1, "「锁 HP」开启时掉血补回到这个数值"],
    ["lockMpVal", "锁 MP 值", 0, 1, "「锁 MP」开启时耗蓝补回到这个数值"],
    ["lockTpVal", "锁 TP 值", 0, 1, "「锁 TP」开启时 TP 补回到这个数值"]
  ];

  // ---------------------------------------------------------------------------

  RMCH.parts.CheatToggles = {
    name: "CheatToggles",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      // Optimistic flip so the switch never lags a round-trip; the bridge's
      // answer is authoritative and overwrites it.
      function toggle(key, value) {
        var patch = {};
        patch[key] = value;
        trainer.options[key] = value;
        store.setOptions(patch);
      }
      return { trainer: trainer, options: BOOL_OPTIONS, toggle: toggle };
    },
    template: [
      '<n-card size="small" title="作弊开关">',
      '  <template #header-extra><rm-icon name="toggle"/></template>',
      '  <div class="rm-pairs">',
      '    <label v-for="[key, label, tip] in options" :key="key" class="rm-pair">',
      '      <n-tooltip v-if="tip" trigger="hover" :delay="400">',
      '        <template #trigger><span class="rm-tip-label">{{ label }}</span></template>',
      '        {{ tip }}',
      '      </n-tooltip>',
      '      <span v-else>{{ label }}</span>',
      '      <n-switch size="small" :value="!!trainer.options[key]" @update:value="v => toggle(key, v)"/>',
      '    </label>',
      '  </div>',
      '</n-card>'
    ].join("\n")
  };

  // ---------------------------------------------------------------------------

  RMCH.parts.CheatRates = {
    name: "CheatRates",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var timers = {};
      // Typing "120" would otherwise fire three bridge commands.
      function push(key, value) {
        trainer.options[key] = value;
        clearTimeout(timers[key]);
        timers[key] = setTimeout(function () {
          var patch = {};
          patch[key] = Number(value) || 0;
          store.setOptions(patch);
        }, 300);
      }
      return { trainer: trainer, options: NUM_OPTIONS, push: push };
    },
    render: function () {
      var self = this;
      return h(naive.NCard, { size: "small", title: "倍率与数值" }, {
        "header-extra": function () { return h(RMCH.Icon, { name: "wand" }); },
        default: function () {
          return h("div", { class: "rm-pairs rm-pairs-wide" }, NUM_OPTIONS.map(function (opt) {
            var label = h("span", null, opt[1]);
            if (opt[4]) {
              label = h(naive.NTooltip, { trigger: "hover", delay: 400 }, {
                trigger: function () { return h("span", { class: "rm-tip-label" }, opt[1]); },
                default: function () { return opt[4]; }
              });
            }
            return h("label", { class: "rm-pair", key: opt[0] }, [
              label,
              h(NInputNumber, {
                size: "small",
                value: self.trainer.options[opt[0]] === undefined ? null : self.trainer.options[opt[0]],
                min: opt[2],
                step: opt[3],
                showButton: false,
                placeholder: "-",
                style: { width: "84px", flex: "none" },
                "onUpdate:value": function (value) { self.push(opt[0], value); }
              })
            ]);
          }));
        }
      });
    }
  };

  // ---------------------------------------------------------------------------

  var QUICK_ACTIONS = [
    { label: "全队恢复", type: "party.recover", icon: "heart", kind: "success" },
    { label: "刷新队伍", type: "party.info", icon: "users" },
    { label: "快速存档 (槽1)", type: "save.save", args: { id: 1 }, icon: "save" },
    { label: "读档 (槽1)", type: "save.load", args: { id: 1 }, icon: "archive" },
    { label: "新游戏", type: "game.newGame", icon: "power", confirm: "开始新游戏？未保存的进度会丢失。" },
    { label: "刷新选项", type: "trainer.options.get", icon: "refresh" }
  ];

  RMCH.parts.QuickActions = {
    name: "QuickActions",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var dialog = naive.useDialog();
      var pending = ref(null);

      function fire(action) {
        pending.value = action.type;
        store.cmd(action.type, action.args || {}).then(function (payload) {
          pending.value = null;
          if (!payload) return;
          if (action.type === "trainer.options.get") {
            trainer.options = payload.options || {};
            store.info("选项已刷新");
          } else if (action.type === "party.info") {
            trainer.party = payload.members || [];
            store.info("队伍：" + trainer.party.length + " 人");
          } else if (action.type === "party.recover") {
            trainer.party = payload.members || trainer.party;
            store.ok("全队已恢复");
          } else if (action.type === "save.save") {
            store.ok("已写入存档槽 " + payload.id);
          } else if (action.type === "save.load") {
            store.ok("已读取存档槽 " + payload.id);
            store.reloadAfterSceneChange();
          } else if (action.type === "game.newGame") {
            store.ok("已开始新游戏");
            store.reloadAfterSceneChange();
          }
        });
      }

      function run(action) {
        if (!action.confirm) return fire(action);
        dialog.warning({
          title: action.label,
          content: action.confirm,
          positiveText: "继续",
          negativeText: "取消",
          onPositiveClick: function () { fire(action); }
        });
      }

      return { actions: QUICK_ACTIONS, run: run, pending: pending };
    },
    template: [
      '<n-card size="small" title="快捷操作">',
      '  <template #header-extra><rm-icon name="zap"/></template>',
      '  <n-flex :size="8" :wrap="true">',
      '    <n-button v-for="action in actions" :key="action.type + action.label" size="small"',
      '              :type="action.kind || \'default\'" :secondary="!!action.kind" :tertiary="!action.kind"',
      '              :loading="pending === action.type" @click="run(action)">',
      '      <template #icon><rm-icon :name="action.icon" :size="15"/></template>{{ action.label }}',
      '    </n-button>',
      '  </n-flex>',
      '</n-card>'
    ].join("\n")
  };

  // ---------------------------------------------------------------------------

  RMCH.parts.BattlePanel = {
    name: "BattlePanel",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var draft = ref({});          // enemy index -> pending HP value

      function loadInfo(quiet) {
        return store.cmd("battle.info", {}).then(function (payload) {
          if (!payload) return null;
          trainer.battle = payload;
          draft.value = {};
          (payload.enemies || []).forEach(function (enemy) { draft.value[enemy.index] = enemy.hp; });
          if (!quiet) {
            if (!payload.inBattle) store.info("当前不在战斗中");
            else store.info("战斗中：" + (payload.enemies || []).length + " 个敌人");
          }
          return payload;
        });
      }

      function setHp(index, value) {
        store.cmd("battle.enemy.setHp", { index: index, value: Math.max(0, Number(value) || 0) })
          .then(function (payload) {
            if (!payload) return;
            store.ok("敌人 #" + payload.index + " HP → " + payload.hp);
            loadInfo(true);
          });
      }

      function killAll() {
        store.cmd("battle.killEnemies", {}).then(function (payload) {
          if (!payload) return;
          store.ok("消灭 " + payload.killed + " 个，剩余 " + payload.remaining);
          loadInfo(true);
        });
      }

      function escape() {
        store.cmd("battle.escape", {}).then(function (payload) {
          if (!payload) return;
          store.ok("已脱离战斗（" + payload.method + "）");
          trainer.battle = null;
        });
      }

      var enemies = computed(function () {
        return (trainer.battle && trainer.battle.inBattle && trainer.battle.enemies) || [];
      });

      var columns = [
        { title: "#", key: "index", width: 44 },
        { title: "敌人", key: "name", ellipsis: { tooltip: true } },
        {
          title: "HP",
          key: "hp",
          width: 96,
          render: function (row) {
            return h("span", { style: "font-variant-numeric: tabular-nums" },
              row.hp + " / " + (row.mhp == null ? "-" : row.mhp));
          }
        },
        {
          title: "改 HP",
          key: "edit",
          width: 168,
          render: function (row) {
            return h(NFlex, { size: 6, wrap: false, align: "center" }, {
              default: function () {
                return [
                  h(NInputNumber, {
                    size: "tiny",
                    value: draft.value[row.index],
                    min: 0,
                    showButton: false,
                    style: { width: "74px" },
                    "onUpdate:value": function (value) { draft.value[row.index] = value; }
                  }),
                  h(NButton, {
                    size: "tiny",
                    secondary: true,
                    onClick: function () { setHp(row.index, draft.value[row.index]); }
                  }, { default: function () { return "设定"; } }),
                  h(NButton, {
                    size: "tiny",
                    type: "error",
                    secondary: true,
                    onClick: function () { setHp(row.index, 0); }
                  }, { default: function () { return "秒杀"; } })
                ];
              }
            });
          }
        }
      ];

      return {
        trainer: trainer,
        enemies: enemies,
        columns: columns,
        loadInfo: loadInfo,
        killAll: killAll,
        escape: escape
      };
    },
    template: [
      '<n-card size="small" title="战斗">',
      '  <template #header-extra><rm-icon name="sword"/></template>',
      '  <n-flex vertical :size="10">',
      '    <n-flex :size="8" :wrap="true">',
      '      <n-button size="small" tertiary @click="loadInfo(false)">',
      '        <template #icon><rm-icon name="refresh" :size="15"/></template>战斗信息',
      '      </n-button>',
      '      <n-button size="small" type="error" secondary @click="killAll">',
      '        <template #icon><rm-icon name="sword" :size="15"/></template>全灭敌人',
      '      </n-button>',
      '      <n-button size="small" tertiary @click="escape">',
      '        <template #icon><rm-icon name="close" :size="15"/></template>逃离战斗',
      '      </n-button>',
      '    </n-flex>',
      '    <n-data-table v-if="enemies.length" :columns="columns" :data="enemies" size="small"',
      '                  :row-key="row => row.index" :max-height="220" :bordered="false"/>',
      '    <n-text v-else depth="3" style="font-size: 12.5px">',
      '      {{ trainer.battle ? "当前不在战斗中" : "点「战斗信息」读取当前战斗状态" }}',
      '    </n-text>',
      '  </n-flex>',
      '</n-card>'
    ].join("\n")
  };
})();
