// 数据 › 存档数据 — the runtime save-contents tree (MTool 数据修改).
//
// 更新数据 pulls DataManager.makeSaveContents() from the running game;
// 应用至游戏 hands the edited tree back to extractSaveContents. Both buttons live
// inside the jsoneditor menu bar (see ui/parts/json-editor.js #menu slot), which
// is where MTool puts them.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var data = store.data;
  var ref = Vue.ref;
  var computed = Vue.computed;

  RMCH.views.DataTree = {
    name: "DataTreeView",
    components: { RmIcon: RMCH.Icon, RmJsonEditor: RMCH.parts.JsonEditor },
    setup: function () {
      var dialog = naive.useDialog();
      var editor = ref(null);          // RmJsonEditor instance (getText/setPristine)
      var dirty = ref(false);
      var reloadMap = ref(true);

      var source = computed(function () { return data.tree.json; });

      // The editor reloads itself off the `json` prop, but 「重新拉取」 also has to
      // win when the game hands back the exact same bytes — hence reload().
      function refetch() {
        return store.loadSaveTree().then(function (payload) {
          if (payload && editor.value) editor.value.reload(payload.json);
          return payload;
        });
      }

      function pull() {
        if (dirty.value) {
          dialog.warning({
            title: "放弃未应用的修改？",
            content: "重新拉取会覆盖你在树里改过但还没「应用至游戏」的内容。",
            positiveText: "重新拉取",
            negativeText: "取消",
            onPositiveClick: refetch
          });
          return;
        }
        refetch();
      }

      function apply() {
        // Serialise once, here — not on every keystroke.
        var json = (editor.value && editor.value.getText()) || data.tree.json;
        if (!json) return store.warn("先点「更新数据」拉取存档数据");
        dialog.warning({
          title: "应用至游戏",
          content: reloadMap.value
            ? "会用编辑后的数据替换游戏里的全部存档对象，并像读档一样重载当前地图。建议先在「存档」页备份。"
            : "会用编辑后的数据替换游戏里的全部存档对象，但不重载地图 —— 画面上的旧对象可能与新数据不一致。",
          positiveText: "应用",
          negativeText: "取消",
          onPositiveClick: function () {
            store.applySaveTree(json, reloadMap.value).then(function (payload) {
              if (payload && editor.value) editor.value.setPristine();
            });
          }
        });
      }

      var treeHeight = computed(function () { return Math.max(280, store.viewport.height - 250); });

      return {
        store: store,
        data: data,
        editor: editor,
        source: source,
        dirty: dirty,
        reloadMap: reloadMap,
        treeHeight: treeHeight,
        pull: pull,
        apply: apply,
        onDirty: function (value) { dirty.value = value; },
        sizeText: computed(function () {
          if (!data.tree.bytes) return "";
          return (data.tree.bytes / 1024).toFixed(1) + " KB";
        })
      };
    },
    template: [
      '<n-card size="small" title="存档数据（运行时）">',
      '  <template #header-extra>',
      '    <n-flex align="center" :size="10">',
      '      <n-checkbox v-model:checked="reloadMap">应用后重载地图</n-checkbox>',
      '      <n-tag v-if="dirty" size="small" :bordered="false" type="warning">有未应用的修改</n-tag>',
      '      <n-text v-if="sizeText" depth="3" style="font-size: 12px">{{ sizeText }}</n-text>',
      '      <rm-icon name="database"/>',
      '    </n-flex>',
      '  </template>',

      '  <n-flex vertical :size="10">',
      '    <n-alert v-if="data.tree.error" type="error" :bordered="false">{{ data.tree.error }}</n-alert>',

      '    <rm-json-editor ref="editor" :json="source" :height="treeHeight" @dirty="onDirty">',
      '      <template #menu>',
      '        <button class="rm-je-btn rm-je-btn-primary" :disabled="data.tree.loading" @click="pull">',
      '          {{ data.tree.loading ? "拉取中…" : "更新数据" }}',
      '        </button>',
      '        <button class="rm-je-btn" :disabled="!source || data.tree.applying" @click="apply">',
      '          {{ data.tree.applying ? "应用中…" : "应用至游戏" }}',
      '        </button>',
      '      </template>',
      '    </rm-json-editor>',

      '    <n-collapse>',
      '      <n-collapse-item title="操作说明" name="help">',
      '        <n-text depth="3" style="font-size: 12px">',
      '          右键任意行（或点行首 ▾）= 追加 / 插入 / 复制 / 移除 / 改类型；拖手柄可移动节点；',
      '          Ctrl+Z 撤销。增删键会改变存档结构，与游戏的类不匹配时可能读档才报错 —— 建议先在「存档」页备份。',
      '        </n-text>',
      '      </n-collapse-item>',
      '    </n-collapse>',
      '  </n-flex>',
      '</n-card>'
    ].join("\n")
  };
})();
