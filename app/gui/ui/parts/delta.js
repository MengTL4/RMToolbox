// Number field plus -100 / -1 / +1 / +100.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  RMCH.parts.Delta = {
    name: "RmDelta",
    props: {
      value: { type: Number, default: null },
      min: { type: Number, default: 0 },
      steps: { type: Array, default: function () { return [-100, -1, 1, 100]; } },
      disabled: { type: Boolean, default: false },
      placeholder: { type: String, default: "" }
    },
    emits: ["update:value", "commit"],
    setup: function (props, ctx) {
      function bump(step) {
        var next = (Number(props.value) || 0) + step;
        if (props.min != null) next = Math.max(props.min, next);
        ctx.emit("update:value", next);
        ctx.emit("commit", next);
      }
      return { bump: bump };
    },
    template: [
      '<n-flex :size="6" :wrap="true" align="center">',
      '  <n-input-number :value="value" :min="min" :show-button="false" size="small"',
      '                  :disabled="disabled" :placeholder="placeholder" style="flex: 1 1 96px; min-width: 88px"',
      '                  @update:value="v => $emit(\'update:value\', v)"',
      '                  @keyup.enter="$emit(\'commit\', value)"/>',
      '  <n-button-group size="small">',
      '    <n-button v-for="step in steps" :key="step" :disabled="disabled" @click="bump(step)">',
      '      {{ step > 0 ? "+" + step : step }}',
      '    </n-button>',
      '  </n-button-group>',
      '  <n-button size="small" type="primary" :disabled="disabled" @click="$emit(\'commit\', value)">应用</n-button>',
      '</n-flex>'
    ].join("\n")
  };
})();
