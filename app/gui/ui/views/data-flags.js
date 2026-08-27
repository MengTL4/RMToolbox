// 数据 › 开关 / 变量 — master-detail with a lock tick and an inline value column.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var data = store.data;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var watch = Vue.watch;

  // Numeric-looking text becomes a number; anything else stays a string, which
  // is what RPG Maker variables allow.
  function parseValue(raw) {
    var text = String(raw == null ? "" : raw).trim();
    if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
    return text;
  }

  RMCH.views.DataFlags = {
    name: "DataFlagsView",
    components: {
      RmIcon: RMCH.Icon,
      RmEntryList: RMCH.parts.EntryList
    },
    props: {
      kind: { type: String, required: true }         // "switch" | "variable"
    },
    setup: function (props) {
      var draft = ref(null);
      var lockDraft = ref(null);

      var isSwitch = computed(function () { return props.kind === "switch"; });
      var label = computed(function () { return isSwitch.value ? "开关" : "变量"; });
      var entries = computed(function () { return data.flags[props.kind] || []; });

      var selectedId = computed(function () { return data.selected[props.kind]; });
      var selected = computed(function () {
        var id = selectedId.value;
        if (id == null) return null;
        return entries.value.filter(function (entry) { return entry.id === id; })[0] || null;
      });
      var locked = computed(function () {
        return selected.value ? store.isLocked(props.kind, selected.value.id) : false;
      });

      watch([selected, locked], function () {
        if (!selected.value) {
          draft.value = null;
          lockDraft.value = null;
          return;
        }
        draft.value = selected.value.value;
        lockDraft.value = locked.value ? store.lockedValue(props.kind, selected.value.id) : selected.value.value;
      }, { immediate: true });

      function commitValue(value) {
        if (!selected.value) return;
        var next = isSwitch.value ? !!value : parseValue(value);
        store.setFlag(props.kind, selected.value.id, next).then(function (payload) {
          if (payload) store.ok(label.value + " #" + payload.id + " = " + JSON.stringify(payload.value));
        });
      }

      function toggleLock(row, enabled) {
        store.setLock(props.kind, row.id, enabled ? row.value : null, enabled).then(function (payload) {
          if (!payload) return;
          store.info(enabled ? "已锁定 " + label.value + " #" + row.id : "已解锁 #" + row.id);
        });
      }

      function applyLockValue(value) {
        if (!selected.value) return;
        var next = isSwitch.value ? !!value : parseValue(value);
        store.setLock(props.kind, selected.value.id, next, true).then(function (payload) {
          if (payload) store.ok("锁定值 → " + JSON.stringify(payload.value));
        });
      }

      var lockCount = computed(function () {
        return Object.keys(data.locks[props.kind] || {}).length;
      });

      var listHeight = computed(function () { return Math.max(240, store.viewport.height - 340); });

      return {
        store: store,
        data: data,
        entries: entries,
        label: label,
        isSwitch: isSwitch,
        selected: selected,
        selectedId: selectedId,
        locked: locked,
        draft: draft,
        lockDraft: lockDraft,
        lockCount: lockCount,
        listHeight: listHeight,
        commitValue: commitValue,
        toggleLock: toggleLock,
        applyLockValue: applyLockValue,
        setFlag: store.setFlag,
        select: function (row) { data.selected[props.kind] = row.id; },
        isLocked: function (row) { return store.isLocked(props.kind, row.id); },
        valueOf: function (row) {
          return props.kind === "switch" ? (row.value ? "ON" : "OFF") : String(row.value);
        },
        queryOf: computed(function () { return data.query[props.kind]; })
      };
    },
    template: [
      '<div class="rm-md">',
      '  <n-card class="rm-md-list" size="small" :title="label + \'列表\'">',
      '    <template #header-extra>',
      '      <n-flex align="center" :size="8">',
      '        <n-text depth="3" style="font-size: 12px">已锁定 {{ lockCount }}</n-text>',
      '        <n-button size="tiny" quaternary :loading="data.loading.flags" @click="store.loadFlags(kind)">',
      '          <template #icon><rm-icon name="refresh" :size="14"/></template>',
      '        </n-button>',
      '      </n-flex>',
      '    </template>',
      '    <rm-entry-list :entries="entries" :selected-id="selectedId" :query="queryOf"',
      '                   check-label="锁定" :checked="isLocked"',
      '                   :value-label="isSwitch ? \'状态\' : \'值\'" :value-of="valueOf"',
      '                   :height="listHeight" :loading="data.loading.flags" empty-text="等待游戏数据加载…"',
      '                   @update:query="v => data.query[kind] = v"',
      '                   @select="select" @toggle="toggleLock"/>',
      '  </n-card>',

      '  <n-card class="rm-md-detail" size="small"',
      '          :title="selected ? \'#\' + selected.id + \' \' + (selected.name || \'(无名)\') : \'详情\'">',
      '    <template #header-extra><rm-icon name="database"/></template>',
      '    <n-empty v-if="!selected" description="在左边点一个条目" style="padding: 40px 0"/>',
      '    <n-flex v-else vertical :size="16">',
      '      <n-descriptions :column="2" size="small" bordered label-placement="top">',
      '        <n-descriptions-item label="ID">{{ selected.id }}</n-descriptions-item>',
      '        <n-descriptions-item label="当前值">{{ String(selected.value) }}</n-descriptions-item>',
      '      </n-descriptions>',

      '      <div v-if="isSwitch">',
      '        <n-flex align="center" :size="12">',
      '          <n-switch :value="!!selected.value" @update:value="v => setFlag(kind, selected.id, v)"/>',
      '          <n-text>{{ selected.value ? "ON" : "OFF" }}</n-text>',
      '        </n-flex>',
      '      </div>',
      '      <div v-else>',
      '        <n-text depth="3" style="font-size: 12px">值（数字或文本）</n-text>',
      '        <div style="margin-top: 8px">',
      '          <n-input-group>',
      '            <n-input :value="String(draft == null ? \'\' : draft)" size="small"',
      '                     @update:value="v => draft = v" @keyup.enter="commitValue(draft)"/>',
      '            <n-button size="small" type="primary" @click="commitValue(draft)">应用</n-button>',
      '          </n-input-group>',
      '        </div>',
      '      </div>',

      '      <n-divider style="margin: 0"/>',

      '      <div>',
      '        <n-flex align="center" :size="10">',
      '          <n-checkbox :checked="locked" @update:checked="v => toggleLock(selected, v)">锁定这个值</n-checkbox>',
      '          <n-text depth="3" style="font-size: 12px">游戏每帧都会被改回锁定值</n-text>',
      '        </n-flex>',
      '        <div v-if="locked" style="margin-top: 8px">',
      '          <n-flex v-if="isSwitch" align="center" :size="12">',
      '            <n-switch :value="!!lockDraft" @update:value="v => applyLockValue(v)"/>',
      '            <n-text depth="3" style="font-size: 12px">锁定为 {{ lockDraft ? "ON" : "OFF" }}</n-text>',
      '          </n-flex>',
      '          <n-input-group v-else>',
      '            <n-input :value="String(lockDraft == null ? \'\' : lockDraft)" size="small"',
      '                     @update:value="v => lockDraft = v" @keyup.enter="applyLockValue(lockDraft)"/>',
      '            <n-button size="small" type="warning" @click="applyLockValue(lockDraft)">锁定为此值</n-button>',
      '          </n-input-group>',
      '        </div>',
      '      </div>',
      '    </n-flex>',
      '  </n-card>',
      '</div>'
    ].join("\n")
  };
})();
