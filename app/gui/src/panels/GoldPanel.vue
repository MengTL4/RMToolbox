<script>
import Component_RmIcon from "../shell/RmIcon.vue";

var RMCH = (window.RMCH = window.RMCH || {});

var store = RMCH.store;

var trainer = store.trainer;

var h = Vue.h;

var ref = Vue.ref;

var computed = Vue.computed;

var NButton = naive.NButton;

var NTag = naive.NTag;

var NFlex = naive.NFlex;

var NText = naive.NText;

export default {
  name: "GoldPanel",
  components: { RmIcon: Component_RmIcon },
  setup: function () {
    var amount = store.useDraft("gold.amount", null);
    var pending = ref(false);

    function apply(type) {
      if (pending.value || amount.value == null) return;
      pending.value = true;
      var value = Number(amount.value) || 0;
      var args = type === "gold.set" ? { value: value } : { amount: value };
      store
        .cmdWarn(type, args)
        .then(function (payload) {
          if (!payload) return;
          trainer.gold = payload.gold;
          store.ok("金钱 → " + payload.gold);
        })
        .finally(function () {
          pending.value = false;
        });
    }

    var display = computed(function () {
      return trainer.gold == null
        ? "—"
        : Number(trainer.gold).toLocaleString("zh-CN");
    });

    return {
      trainer: trainer,
      amount: amount,
      apply: apply,
      display: display,
      pending: pending
    };
  }
};
</script>

<template>
  <n-card size="small" title="金钱">
    <template #header-extra><rm-icon name="coins" /></template>
    <n-flex vertical :size="12">
      <n-flex align="baseline" :size="8">
        <span
          style="
            font-size: 26px;
            font-weight: 650;
            font-variant-numeric: tabular-nums;
            line-height: 1;
          "
        >
          {{ display }}
        </span>
        <n-text depth="3" style="font-size: 12px">当前持有</n-text>
      </n-flex>
      <n-input-group>
        <n-input-number
          v-model:value="amount"
          placeholder="输入金额"
          :min="0"
          :show-button="false"
          style="flex: 1"
          @keyup.enter="apply('gold.set')"
        />
        <n-button
          type="primary"
          :loading="pending"
          :disabled="amount == null"
          @click="apply('gold.set')"
          >设为此值</n-button
        >
        <n-button
          secondary
          :disabled="pending || amount == null"
          @click="apply('gold.add')"
          >增加此值</n-button
        >
      </n-input-group>
      <n-text depth="3" style="font-size: 12px"
        >输入不会立即生效 · Enter 设为此值</n-text
      >
    </n-flex>
  </n-card>
</template>
