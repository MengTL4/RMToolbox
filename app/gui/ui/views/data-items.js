// 数据 › 物品 / 装备 / 武器 — MTool-style master-detail.
//
// One component, parameterised by kind: the left list is every entry the game
// defines (with the owned count and a lock tick), the right pane edits the
// selected one.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var data = store.data;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var watch = Vue.watch;

  var KIND_LABELS = { item: "物品", weapon: "武器", armor: "防具" };

  RMCH.views.DataItems = {
    name: "DataItemsView",
    components: {
      RmIcon: RMCH.Icon,
      RmEntryList: RMCH.parts.EntryList,
      RmDelta: RMCH.parts.Delta,
      RmGameIcon: RMCH.parts.GameIcon
    },
    props: {
      kind: { type: String, required: true }
    },
    setup: function (props) {
      var draft = ref(null);
      var lockDraft = ref(null);

      var entries = computed(function () { return data.catalog[props.kind] || []; });
      var selectedId = computed(function () { return data.selected[props.kind]; });

      var selected = computed(function () {
        var id = selectedId.value;
        if (id == null) return null;
        return entries.value.filter(function (entry) { return entry.id === id; })[0] || null;
      });

      var count = computed(function () {
        return selected.value ? store.countOf(props.kind, selected.value.id) : 0;
      });

      var locked = computed(function () {
        return selected.value ? store.isLocked(props.kind, selected.value.id) : false;
      });

      // Reset the editors whenever the selection (or its live count) changes.
      watch([selected, count], function () {
        draft.value = selected.value ? count.value : null;
        lockDraft.value = selected.value && locked.value
          ? Number(store.lockedValue(props.kind, selected.value.id))
          : count.value;
      }, { immediate: true });

      function select(row) {
        data.selected[props.kind] = row.id;
      }

      function commit(value) {
        if (!selected.value) return;
        store.setItemCount(props.kind, selected.value.id, Number(value) || 0).then(function (payload) {
          if (payload) store.ok(KIND_LABELS[props.kind] + " #" + payload.id + " → " + payload.count);
        });
      }

      function toggleLock(row, enabled) {
        var id = row.id;
        var value = enabled ? store.countOf(props.kind, id) : null;
        store.setLock(props.kind, id, value, enabled).then(function (payload) {
          if (!payload) return;
          store.info(enabled ? "已锁定 #" + id + " = " + payload.value : "已解锁 #" + id);
        });
      }

      function applyLockValue(value) {
        if (!selected.value) return;
        store.setLock(props.kind, selected.value.id, Number(value) || 0, true).then(function (payload) {
          if (payload) store.ok("锁定值 → " + payload.value);
        });
      }

      var lockCount = computed(function () {
        return Object.keys(data.locks[props.kind] || {}).length;
      });

      var listHeight = computed(function () {
        return Math.max(240, store.viewport.height - 340);
      });

      return {
        store: store,
        data: data,
        kindLabel: computed(function () { return KIND_LABELS[props.kind]; }),
        entries: entries,
        selected: selected,
        selectedId: selectedId,
        count: count,
        locked: locked,
        draft: draft,
        lockDraft: lockDraft,
        lockCount: lockCount,
        listHeight: listHeight,
        select: select,
        commit: commit,
        toggleLock: toggleLock,
        applyLockValue: applyLockValue,
        countOf: function (row) { return "× " + store.countOf(props.kind, row.id); },
        isLocked: function (row) { return store.isLocked(props.kind, row.id); },
        queryOf: computed(function () { return data.query[props.kind]; })
      };
    },
    template: [
      '<div class="rm-md">',
      '  <n-card class="rm-md-list" size="small" :title="kindLabel + \'列表\'">',
      '    <template #header-extra>',
      '      <n-flex align="center" :size="8">',
      '        <n-text depth="3" style="font-size: 12px">已锁定 {{ lockCount }}</n-text>',
      '        <n-button size="tiny" quaternary :loading="data.loading.catalog"',
      '                  @click="store.loadCatalog(kind); store.loadCounts()">',
      '          <template #icon><rm-icon name="refresh" :size="14"/></template>',
      '        </n-button>',
      '      </n-flex>',
      '    </template>',
      '    <rm-entry-list :entries="entries" :selected-id="selectedId" :query="queryOf"',
      '                   :game-key="store.trainer.gameKey"',
      '                   check-label="锁定" :checked="isLocked"',
      '                   value-label="持有" :value-of="countOf"',
      '                   :height="listHeight" :loading="data.loading.catalog"',
      '                   :empty-text="\'等待游戏数据加载…\'"',
      '                   @update:query="v => data.query[kind] = v"',
      '                   @select="select" @toggle="toggleLock"/>',
      '  </n-card>',

      '  <n-card class="rm-md-detail" size="small" :title="selected ? \'#\' + selected.id + \' \' + (selected.name || \'(无名)\') : \'详情\'">',
      '    <template #header-extra><rm-icon name="box"/></template>',
      '    <n-empty v-if="!selected" description="在左边点一个条目" style="padding: 40px 0"/>',
      '    <n-flex v-else vertical :size="16">',
      '      <n-descriptions :column="2" size="small" bordered label-placement="top">',
      '        <n-descriptions-item label="ID">{{ selected.id }}</n-descriptions-item>',
      '        <n-descriptions-item label="图标">',
      '          <n-flex align="center" :size="8">',
      '            <rm-game-icon v-if="selected.iconIndex != null" :game-key="store.trainer.gameKey"',
      '                          :index="selected.iconIndex" :size="24"/>',
      '            <span>{{ selected.iconIndex == null ? "-" : selected.iconIndex }}</span>',
      '          </n-flex>',
      '        </n-descriptions-item>',
      '        <n-descriptions-item label="当前持有">{{ count }}</n-descriptions-item>',
      '        <n-descriptions-item label="锁定">',
      '          <n-tag size="small" :bordered="false" :type="locked ? \'warning\' : \'default\'">',
      '            {{ locked ? "已锁定 " + store.lockedValue(kind, selected.id) : "未锁定" }}',
      '          </n-tag>',
      '        </n-descriptions-item>',
      '      </n-descriptions>',

      '      <div>',
      '        <n-text depth="3" style="font-size: 12px">数量</n-text>',
      '        <div style="margin-top: 8px">',
      '          <rm-delta v-model:value="draft" :min="0" placeholder="数量" @commit="commit"/>',
      '        </div>',
      '      </div>',

      '      <n-divider style="margin: 0"/>',

      '      <div>',
      '        <n-flex align="center" :size="10">',
      '          <n-checkbox :checked="locked" @update:checked="v => toggleLock(selected, v)">锁定这个数量</n-checkbox>',
      '          <n-text depth="3" style="font-size: 12px">游戏每帧都会被改回锁定值</n-text>',
      '        </n-flex>',
      '        <div v-if="locked" style="margin-top: 8px">',
      '          <rm-delta v-model:value="lockDraft" :min="0" placeholder="锁定值" @commit="applyLockValue"/>',
      '        </div>',
      '      </div>',
      '    </n-flex>',
      '  </n-card>',
      '</div>'
    ].join("\n")
  };
})();
