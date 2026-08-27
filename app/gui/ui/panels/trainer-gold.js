// 修改器 · 金钱
//
// 角色花名册与角色编辑器搬到了 数据 › 角色（ui/views/data-actors.js）——
// MTool 式左列表右详情，比原来的抽屉更好用。

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  var store = RMCH.store;
  var trainer = store.trainer;
  var h = Vue.h;
  var ref = Vue.ref;
  var computed = Vue.computed;

  var NButton = naive.NButton;
  var NTag = naive.NTag;
  var NFlex = naive.NFlex;
  var NText = naive.NText;

  // ---------------------------------------------------------------------------

  RMCH.parts.GoldPanel = {
    name: "GoldPanel",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var amount = ref(null);

      function apply(type) {
        var value = Number(amount.value) || 0;
        var args = type === "gold.set" ? { value: value } : { amount: value };
        store.cmd(type, args).then(function (payload) {
          if (!payload) return;
          trainer.gold = payload.gold;
          store.ok("金钱 → " + payload.gold);
        });
      }

      var display = computed(function () {
        return trainer.gold == null ? "—" : Number(trainer.gold).toLocaleString("zh-CN");
      });

      return { trainer: trainer, amount: amount, apply: apply, display: display };
    },
    template: [
      '<n-card size="small" title="金钱">',
      '  <template #header-extra><rm-icon name="coins"/></template>',
      '  <n-flex vertical :size="12">',
      '    <n-flex align="baseline" :size="8">',
      '      <span style="font-size: 26px; font-weight: 650; font-variant-numeric: tabular-nums; line-height: 1">',
      '        {{ display }}',
      '      </span>',
      '      <n-text depth="3" style="font-size: 12px">当前持有</n-text>',
      '    </n-flex>',
      '    <n-input-group>',
      '      <n-input-number v-model:value="amount" placeholder="金额" :min="0" :show-button="false" style="flex: 1"/>',
      '      <n-button type="primary" @click="apply(\'gold.set\')">设置</n-button>',
      '      <n-button secondary type="primary" @click="apply(\'gold.add\')">增加</n-button>',
      '    </n-input-group>',
      '  </n-flex>',
      '</n-card>'
    ].join("\n")
  };

  // ---------------------------------------------------------------------------
})();
