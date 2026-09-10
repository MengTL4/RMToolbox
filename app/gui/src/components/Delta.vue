<script lang="ts">
import { defineComponent, type PropType } from "vue";

export default defineComponent({
  name: "RmDelta",
  props: {
    value: { type: Number as PropType<number | null>, default: null },
    min: { type: Number as PropType<number | null>, default: 0 },
    steps: {
      type: Array as PropType<number[]>,
      default: () => [-100, -1, 1, 100]
    },
    disabled: { type: Boolean, default: false },
    placeholder: { type: String, default: "" }
  },
  emits: {
    "update:value": (value: number | null) =>
      value === null || Number.isFinite(value),
    commit: (value: number | null) => value === null || Number.isFinite(value)
  },
  setup(props, { emit }) {
    function bump(step: number) {
      let next = (Number(props.value) || 0) + step;
      if (props.min != null) next = Math.max(props.min, next);
      emit("update:value", next);
    }
    return { bump };
  }
});
</script>

<template>
  <n-flex :size="6" wrap align="center">
    <n-input-number
      :value="value"
      :min="min"
      :show-button="false"
      :precision="0"
      size="small"
      :disabled="disabled"
      :placeholder="placeholder"
      style="flex: 1 1 96px; min-width: 88px"
      @update:value="(next: number | null) => $emit('update:value', next)"
      @keyup.enter="$emit('commit', value)"
    />
    <n-button-group size="small">
      <n-button
        v-for="step in steps"
        :key="step"
        :disabled="disabled"
        @click="bump(step)"
      >
        {{ step > 0 ? "+" + step : step }}
      </n-button>
    </n-button-group>
    <n-button
      size="small"
      type="primary"
      :disabled="disabled"
      @click="$emit('commit', value)"
      >应用</n-button
    >
  </n-flex>
</template>
