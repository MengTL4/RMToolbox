// Searchable checkbox overlay (MTool 技能 / 状态).

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  var ref = Vue.ref;
  var computed = Vue.computed;

  RMCH.parts.Picker = {
    name: "RmPicker",
    components: { RmIcon: RMCH.Icon, RmVirtual: RMCH.parts.Virtual, RmGameIcon: RMCH.parts.GameIcon },
    props: {
      show: { type: Boolean, required: true },
      title: { type: String, default: "选择" },
      entries: { type: Array, required: true },        // [{ id, name, note, iconIndex, iconName }]
      ownedIds: { type: Array, required: true },
      busy: { type: Boolean, default: false },
      // When set, entries with iconIndex show their in-game icon — only once
      // the sheet is confirmed ready, so unavailable sheets leave no gap.
      gameKey: { type: String, default: "" }
    },
    emits: ["update:show", "toggle", "select-owned"],
    setup: function (props) {
      var query = ref("");

      // Same sheet gating as EntryList: no icon slot until the sheet is ready.
      Vue.watch(function () { return props.gameKey; }, function (key) {
        if (key) RMCH.iconset.ensure(key);
      }, { immediate: true });
      var iconsReady = computed(function () {
        if (!props.gameKey) return false;
        RMCH.iconset.version.value;            // depend
        return RMCH.iconset.state(props.gameKey) === "ready";
      });

      var owned = computed(function () {
        var set = Object.create(null);
        props.ownedIds.forEach(function (id) { set[id] = true; });
        return set;
      });

      var filtered = computed(function () {
        var needle = query.value.trim().toLowerCase();
        if (!needle) return props.entries;
        return props.entries.filter(function (entry) {
          return String(entry.name || "").toLowerCase().indexOf(needle) !== -1 ||
            String(entry.id) === needle;
        });
      });

      var ownedCount = computed(function () { return props.ownedIds.length; });

      return { query: query, owned: owned, filtered: filtered, ownedCount: ownedCount, iconsReady: iconsReady };
    },
    template: [
      '<n-modal :show="show" preset="card" :title="title" style="width: min(720px, 92vw)"',
      '         :bordered="false" @update:show="v => $emit(\'update:show\', v)">',
      '  <n-flex vertical :size="10">',
      '    <n-flex align="center" :size="10" :wrap="false">',
      '      <n-input v-model:value="query" size="small" placeholder="搜索名称或 ID" clearable style="flex: 1">',
      '        <template #prefix><rm-icon name="search" :size="14"/></template>',
      '      </n-input>',
      '      <n-button size="small" tertiary @click="query = \'\'; $emit(\'select-owned\')">',
      '        <template #icon><rm-icon name="check" :size="15"/></template>只看已拥有 ({{ ownedCount }})',
      '      </n-button>',
      '    </n-flex>',
      '    <n-text depth="3" style="font-size: 12px">勾选 = 拥有，取消勾选 = 移除。{{ filtered.length }} 条</n-text>',
      // Windowed: a game can define thousands of skills, and rendering them all
      // as checkboxes locks the window up for seconds.
      '    <rm-virtual :items="filtered" :item-size="38" :height="420" key-field="id">',
      '      <template #default="{ item }">',
      '        <div class="rm-picker-row">',
      '          <n-checkbox :checked="!!owned[item.id]" :disabled="busy"',
      '                      @update:checked="v => $emit(\'toggle\', item, v)">',
      '            <span class="rm-picker-item">',
      '              <span class="rm-picker-name">',
      '                <rm-game-icon v-if="item.iconIndex != null ? iconsReady : !!item.iconName" :game-key="gameKey"',
      '                              :index="item.iconIndex" :icon-name="item.iconName" :size="20"/>',
      '                <n-text depth="3" style="font-variant-numeric: tabular-nums; flex: none">{{ item.id }}:</n-text>',
      '                <span class="rm-picker-label">{{ item.name || "(无名)" }}</span>',
      '              </span>',
      '              <n-text v-if="item.note" depth="3" class="rm-picker-note">{{ item.note }}</n-text>',
      '            </span>',
      '          </n-checkbox>',
      '        </div>',
      '      </template>',
      '    </rm-virtual>',
      '  </n-flex>',
      '</n-modal>'
    ].join("\n")
  };
})();
