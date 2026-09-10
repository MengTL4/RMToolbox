<script>
import Component_RmIcon from "../shell/RmIcon.vue";

import {
  RMCH,
  store,
  trainer,
  h,
  ref,
  computed,
  NButton,
  NInputNumber,
  NFlex,
  BOOL_OPTIONS,
  NUM_OPTIONS,
  QUICK_ACTIONS
} from "./trainer-cheats-context.js";

export default {
  name: "BattlePanel",
  components: { RmIcon: Component_RmIcon },
  setup: function () {
    var draft = store.useDraft(function () {
      return "battle." + trainer.battleToken + ".hp";
    }, {});

    function loadInfo(quiet) {
      return store.cmd("battle.info", {}).then(function (payload) {
        if (!payload) return null;
        store.noteBattle(payload.inBattle);
        trainer.battle = payload;
        if (!quiet) {
          if (!payload.inBattle) store.info("当前不在战斗中");
          else
            store.info("战斗中：" + (payload.enemies || []).length + " 个敌人");
        }
        return payload;
      });
    }

    function setHp(index, value) {
      store
        .cmd("battle.enemy.setHp", {
          index: index,
          value: Math.max(0, Number(value) || 0)
        })
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
      return (
        (trainer.battle && trainer.battle.inBattle && trainer.battle.enemies) ||
        []
      );
    });

    var columns = [
      { title: "#", key: "index", width: 44 },
      { title: "敌人", key: "name", ellipsis: { tooltip: true } },
      {
        title: "HP",
        key: "hp",
        width: 96,
        render: function (row) {
          return h(
            "span",
            { style: "font-variant-numeric: tabular-nums" },
            row.hp + " / " + (row.mhp == null ? "-" : row.mhp)
          );
        }
      },
      {
        title: "改 HP",
        key: "edit",
        width: 168,
        render: function (row) {
          return h(
            NFlex,
            { size: 6, wrap: false, align: "center" },
            {
              default: function () {
                return [
                  h(NInputNumber, {
                    size: "tiny",
                    value:
                      draft.value[row.index] == null
                        ? row.hp
                        : draft.value[row.index],
                    min: 0,
                    showButton: false,
                    style: { width: "74px" },
                    "onUpdate:value": function (value) {
                      draft.value[row.index] = value;
                    }
                  }),
                  h(
                    NButton,
                    {
                      size: "tiny",
                      secondary: true,
                      onClick: function () {
                        setHp(
                          row.index,
                          draft.value[row.index] == null
                            ? row.hp
                            : draft.value[row.index]
                        );
                      }
                    },
                    {
                      default: function () {
                        return "设定";
                      }
                    }
                  ),
                  h(
                    NButton,
                    {
                      size: "tiny",
                      type: "error",
                      secondary: true,
                      onClick: function () {
                        setHp(row.index, 0);
                      }
                    },
                    {
                      default: function () {
                        return "秒杀";
                      }
                    }
                  )
                ];
              }
            }
          );
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
  }
};
</script>

<template>
  <n-card size="small" title="战斗">
    <template #header-extra><rm-icon name="sword" /></template>
    <n-flex vertical :size="10">
      <n-flex :size="8" :wrap="true">
        <n-button size="small" tertiary @click="loadInfo(false)">
          <template #icon><rm-icon name="refresh" :size="15" /></template
          >战斗信息
        </n-button>
        <n-button size="small" type="error" secondary @click="killAll">
          <template #icon><rm-icon name="sword" :size="15" /></template>全灭敌人
        </n-button>
        <n-button size="small" tertiary @click="escape">
          <template #icon><rm-icon name="close" :size="15" /></template>逃离战斗
        </n-button>
      </n-flex>
      <n-data-table
        v-if="enemies.length"
        :columns="columns"
        :data="enemies"
        size="small"
        :row-key="(row) => row.index"
        :max-height="220"
        :bordered="false"
      />
      <n-text v-else depth="3" style="font-size: 12.5px">
        {{
          trainer.battle ? "当前不在战斗中" : "点「战斗信息」读取当前战斗状态"
        }}
      </n-text>
    </n-flex>
  </n-card>
</template>
