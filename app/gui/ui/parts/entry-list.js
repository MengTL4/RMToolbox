// Searchable master list for the 数据 tab.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  var h = Vue.h;
  var computed = Vue.computed;

  var NCheckbox = naive.NCheckbox;
  var NText = naive.NText;

  RMCH.parts.EntryList = {
    name: "RmEntryList",
    components: { RmIcon: RMCH.Icon, RmGameIcon: RMCH.parts.GameIcon },
    props: {
      entries: { type: Array, required: true },
      selectedId: { type: [Number, String], default: null },
      query: { type: String, default: "" },
      // When set, rows carrying iconIndex get their in-game icon before the name.
      // The icon slot appears only once the game's IconSet sheet is confirmed
      // loadable — unavailable sheets (encrypted, missing, no live bridge)
      // leave no empty column behind.
      gameKey: { type: String, default: "" },
      // Leading checkbox: omit checkLabel to hide the column entirely.
      checkLabel: { type: String, default: "" },
      checked: { type: Function, default: null },     // entry -> boolean
      // Trailing value column (MTool shows "* 0" for counts, "开"/"值" for flags).
      valueLabel: { type: String, default: "" },
      valueOf: { type: Function, default: null },      // entry -> string
      height: { type: Number, default: 420 },
      loading: { type: Boolean, default: false },
      placeholder: { type: String, default: "搜索名称或 ID" },
      emptyText: { type: String, default: "没有条目" }
    },
    emits: ["update:query", "select", "toggle"],
    setup: function (props, ctx) {
      // Kick the sheet load for this game and flip iconsReady when it lands;
      // iconset.version is the shared "any sheet changed state" signal.
      Vue.watch(function () { return props.gameKey; }, function (key) {
        if (key) RMCH.iconset.ensure(key);
      }, { immediate: true });
      var iconsReady = computed(function () {
        if (!props.gameKey) return false;
        RMCH.iconset.version.value;            // depend
        return RMCH.iconset.state(props.gameKey) === "ready";
      });

      var filtered = computed(function () {
        var needle = String(props.query || "").trim().toLowerCase();
        if (!needle) return props.entries;
        return props.entries.filter(function (entry) {
          return String(entry.name || "").toLowerCase().indexOf(needle) !== -1 ||
            String(entry.id) === needle;
        });
      });

      var columns = computed(function () {
        var list = [];
        if (props.checkLabel) {
          list.push({
            title: props.checkLabel,
            key: "__check",
            width: props.checkLabel.length > 2 ? 84 : 52,
            render: function (row) {
              return h(NCheckbox, {
                checked: props.checked ? !!props.checked(row) : false,
                // Stop the row's select handler: ticking is its own action.
                onClick: function (event) { event.stopPropagation(); },
                "onUpdate:checked": function (value) { ctx.emit("toggle", row, value); }
              });
            }
          });
        }
        list.push({
          title: "名称",
          key: "name",
          ellipsis: { tooltip: true },
          render: function (row) {
            var label = h("span", { class: "rm-entry-label" }, [
              h(NText, { depth: 3, style: "font-variant-numeric: tabular-nums" },
                { default: function () { return String(row.id) + ": "; } }),
              row.name || h(NText, { depth: 3 }, { default: function () { return "(无名)"; } })
            ]);
            if (!iconsReady.value || row.iconIndex == null) return label;
            return h("span", { class: "rm-entry-name" }, [
              h(RMCH.parts.GameIcon, { gameKey: props.gameKey, index: row.iconIndex, size: 20 }),
              label
            ]);
          }
        });
        if (props.valueOf) {
          list.push({
            title: props.valueLabel || "值",
            key: "__value",
            width: 92,
            align: "right",
            render: function (row) {
              return h("span", { style: "font-variant-numeric: tabular-nums" }, props.valueOf(row));
            }
          });
        }
        return list;
      });

      return { filtered: filtered, columns: columns };
    },
    template: [
      '<n-flex vertical :size="8">',
      '  <n-input :value="query" size="small" :placeholder="placeholder" clearable',
      '           @update:value="v => $emit(\'update:query\', v)">',
      '    <template #prefix><rm-icon name="search" :size="14"/></template>',
      '  </n-input>',
      '  <n-text depth="3" style="font-size: 12px">{{ filtered.length }} / {{ entries.length }} 条</n-text>',
      '  <n-data-table :columns="columns" :data="filtered" size="small" :bordered="false"',
      '                :row-key="row => row.id" :max-height="height" virtual-scroll :min-row-height="32"',
      '                :loading="loading"',
      '                :row-class-name="row => row.id === selectedId ? \'rm-row-selected\' : \'\'"',
      '                :row-props="row => ({ style: \'cursor: pointer\', onClick: () => $emit(\'select\', row) })"/>',
      '  <n-empty v-if="!entries.length && !loading" :description="emptyText" size="small" style="padding: 20px 0"/>',
      '</n-flex>'
    ].join("\n")
  };
})();
