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
  name: "CheatToggles",
  components: { RmIcon: Component_RmIcon },
  setup: function () {
    var pending = ref(false);
    function toggle(key, value) {
      if (pending.value) return;
      var patch = {};
      patch[key] = value;
      pending.value = true;
      store
        .setOptions(patch)
        .then(function (payload) {
          if (payload) store.ok("开关已更新");
        })
        .finally(function () {
          pending.value = false;
        });
    }
    return {
      trainer: trainer,
      options: BOOL_OPTIONS,
      toggle: toggle,
      pending: pending
    };
  }
};
</script>

<template>
  <n-card size="small" title="常用开关">
    <template #header-extra><rm-icon name="toggle" /></template>
    <div class="rm-pairs">
      <label v-for="[key, label, tip] in options" :key="key" class="rm-pair">
        <n-tooltip v-if="tip" trigger="hover" :delay="400">
          <template #trigger
            ><span class="rm-tip-label">{{ label }}</span></template
          >
          {{ tip }}
        </n-tooltip>
        <span v-else>{{ label }}</span>
        <n-switch
          size="small"
          :disabled="pending"
          :value="!!trainer.options[key]"
          @update:value="(v) => toggle(key, v)"
        />
      </label>
    </div>
  </n-card>
</template>
