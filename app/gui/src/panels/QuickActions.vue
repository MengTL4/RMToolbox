<script>
import Component_RmIcon from '../shell/RmIcon.vue';

import { RMCH, store, trainer, h, ref, computed, NButton, NInputNumber, NFlex, BOOL_OPTIONS, NUM_OPTIONS, QUICK_ACTIONS } from './trainer-cheats-context.js';

export default {
    name: "QuickActions",
    components: { RmIcon: Component_RmIcon },
    setup: function () {
      var dialog = store.gameDialog(naive.useDialog());
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

  };
</script>

<template>
<n-card size="small" title="快捷操作">
  <template #header-extra><rm-icon name="zap"/></template>
  <n-flex :size="8" :wrap="true">
    <n-button v-for="action in actions" :key="action.type + action.label" size="small"
              :type="action.kind || 'default'" :secondary="!!action.kind" :tertiary="!action.kind"
              :loading="pending === action.type" @click="run(action)">
      <template #icon><rm-icon :name="action.icon" :size="15"/></template>{{ action.label }}
    </n-button>
  </n-flex>
</n-card>
</template>
