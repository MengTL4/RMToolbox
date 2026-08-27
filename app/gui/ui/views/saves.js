// 存档 — slot-aware view of the game's save directory, plus zip-free backups.
//
// MV/MZ write fileN.rpgsave / fileN.rmmzsave (slot N) alongside system files
// (global/config). Slots get row actions (load / overwrite / delete — the
// bridge owns save+load, the Node side unlinks); system files are listed
// read-only so nobody deletes global.rpgsave by accident.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var h = Vue.h;
  var ref = Vue.ref;
  var computed = Vue.computed;

  var NButton = naive.NButton;
  var NFlex = naive.NFlex;
  var NTag = naive.NTag;

  function formatSize(bytes) {
    if (bytes == null) return "-";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(2) + " MB";
  }

  function formatTime(value) {
    try {
      return new Date(value).toLocaleString("zh-CN");
    } catch (_) {
      return String(value);
    }
  }

  function slotOf(name) {
    var match = /^file(\d+)\.(rpgsave|rmmzsave)$/i.exec(name || "");
    return match ? Number(match[1]) : null;
  }

  RMCH.views.Saves = {
    name: "SavesView",
    components: { RmIcon: RMCH.Icon },
    emits: ["open-library"],
    setup: function () {
      var dialog = naive.useDialog();

      var gameKey = ref(null);
      var saveDir = ref("");
      var files = ref([]);
      var backups = ref([]);
      var loading = ref(false);
      var slotDraft = ref(1);
      var busySlot = ref(0);           // slot id mid-command, for row spinners

      function refreshFiles() {
        if (!gameKey.value) return;
        loading.value = true;
        store.send(gameKey.value, "save.list", {})
          .then(function (payload) {
            files.value = payload.entries || [];
            saveDir.value = payload.dir || "";
          })
          .catch(function (error) { store.fail("读取存档列表失败：" + error.message); })
          .finally(function () { loading.value = false; });
      }

      function refreshBackups() {
        backups.value = store.listBackups(gameKey.value);
      }

      function onGameChange(value) {
        gameKey.value = value;
        files.value = [];
        saveDir.value = "";
        refreshBackups();
        if (value) refreshFiles();
      }

      function backup() {
        if (store.backupSaves(gameKey.value)) refreshBackups();
      }

      function restore(row) {
        dialog.warning({
          title: "恢复备份",
          content: "把这份备份覆盖回游戏的存档目录？现有同名文件会被替换。",
          positiveText: "覆盖恢复",
          negativeText: "取消",
          onPositiveClick: function () {
            if (store.restoreBackup(gameKey.value, row.name)) refreshFiles();
          }
        });
      }

      function removeBackup(row) {
        dialog.warning({
          title: "删除备份",
          content: "删除备份「" + row.name + "」（" + row.files + " 个文件）？不可恢复。",
          positiveText: "删除",
          negativeText: "取消",
          onPositiveClick: function () {
            if (store.deleteBackup(gameKey.value, row.name)) refreshBackups();
          }
        });
      }

      // --- slots ---------------------------------------------------------------

      var slots = computed(function () {
        return files.value
          .map(function (entry) { return { slot: slotOf(entry.name), entry: entry }; })
          .filter(function (row) { return row.slot !== null; })
          .sort(function (a, b) { return a.slot - b.slot; });
      });

      var others = computed(function () {
        return files.value.filter(function (entry) { return slotOf(entry.name) === null; });
      });

      var occupied = computed(function () {
        var set = Object.create(null);
        slots.value.forEach(function (row) { set[row.slot] = true; });
        return set;
      });

      // Smallest free slot — the sensible default for 存到槽.
      Vue.watch(slots, function () {
        var next = 1;
        while (occupied.value[next]) next += 1;
        slotDraft.value = next;
      });

      function saveTo(id) {
        busySlot.value = id;
        store.send(gameKey.value, "save.save", { id: id })
          .then(function (payload) {
            store.ok("已写入存档槽 " + payload.id);
            refreshFiles();
          })
          .catch(function (error) { store.fail("存档失败：" + error.message); })
          .finally(function () { busySlot.value = 0; });
      }

      function saveToDraft() {
        var id = Math.max(1, Math.floor(Number(slotDraft.value) || 1));
        if (occupied.value[id]) {
          dialog.warning({
            title: "覆盖槽 " + id + "？",
            content: "槽 " + id + " 已经有存档了，会用当前进度覆盖它。",
            positiveText: "覆盖",
            negativeText: "取消",
            onPositiveClick: function () { saveTo(id); }
          });
          return;
        }
        saveTo(id);
      }

      function loadSlot(row) {
        dialog.warning({
          title: "读取槽 " + row.slot + "？",
          content: "游戏里未保存的进度会丢失，建议先备份或另存。",
          positiveText: "读档",
          negativeText: "取消",
          onPositiveClick: function () {
            busySlot.value = row.slot;
            store.send(gameKey.value, "save.load", { id: row.slot })
              .then(function (payload) {
                store.ok("已读取存档槽 " + payload.id);
                // A load swaps the whole data layer — point the trainer at this
                // game and re-pull once the game settles.
                if (store.trainer.gameKey !== gameKey.value) store.selectGame(gameKey.value);
                store.reloadAfterSceneChange();
              })
              .catch(function (error) { store.fail("读档失败：" + error.message); })
              .finally(function () { busySlot.value = 0; });
          }
        });
      }

      function overwriteSlot(row) {
        dialog.warning({
          title: "覆盖槽 " + row.slot + "？",
          content: "用当前进度覆盖槽 " + row.slot + " 的存档。",
          positiveText: "覆盖",
          negativeText: "取消",
          onPositiveClick: function () { saveTo(row.slot); }
        });
      }

      function deleteSlot(row) {
        dialog.warning({
          title: "删除槽 " + row.slot + "？",
          content: "会删除文件 " + row.entry.name + "，不可恢复（备份目录里的备份不受影响）。",
          positiveText: "删除",
          negativeText: "取消",
          onPositiveClick: function () {
            if (store.deleteSaveFile(gameKey.value, row.entry.name)) refreshFiles();
          }
        });
      }

      // Track the live sessions: auto-pick when there is exactly one, and drop
      // the selection when the game it pointed at disconnects.
      Vue.watchEffect(function () {
        var options = store.liveGameOptions.value;
        var stillAlive = options.some(function (option) { return option.value === gameKey.value; });
        if (!gameKey.value && options.length === 1) onGameChange(options[0].value);
        else if (gameKey.value && !stillAlive) onGameChange(null);
      });

      function actionButton(label, icon, opts) {
        return h(NButton, Object.assign({
          size: "tiny", tertiary: true,
          onClick: opts.onClick
        }, opts.props || {}), {
          icon: RMCH.icon(icon, 13),
          default: function () { return label; }
        });
      }

      var slotColumns = [
        {
          title: "槽", key: "slot", width: 64,
          render: function (row) {
            return h(NTag, { size: "small", bordered: false }, { default: function () { return "#" + row.slot; } });
          }
        },
        {
          title: "文件", key: "name", ellipsis: { tooltip: true },
          render: function (row) { return row.entry.name; }
        },
        { title: "大小", key: "size", width: 90, render: function (row) { return formatSize(row.entry.size); } },
        { title: "修改时间", key: "mtime", width: 172, render: function (row) { return formatTime(row.entry.mtime); } },
        {
          title: "", key: "actions", width: 176,
          render: function (row) {
            return h(NFlex, { size: 4, wrap: false, justify: "end" }, {
              default: function () {
                return [
                  actionButton("读档", "archive", {
                    onClick: function () { loadSlot(row); },
                    props: { loading: busySlot.value === row.slot }
                  }),
                  actionButton("覆盖", "save", { onClick: function () { overwriteSlot(row); } }),
                  actionButton("删除", "trash", { onClick: function () { deleteSlot(row); } })
                ];
              }
            });
          }
        }
      ];

      var otherColumns = [
        { title: "文件", key: "name", ellipsis: { tooltip: true } },
        { title: "大小", key: "size", width: 90, render: function (row) { return formatSize(row.size); } },
        { title: "修改时间", key: "mtime", width: 172, render: function (row) { return formatTime(row.mtime); } }
      ];

      var backupColumns = [
        { title: "备份", key: "name", ellipsis: { tooltip: true } },
        { title: "内容", key: "files", width: 88, render: function (row) { return row.files + " 个文件"; } },
        { title: "大小", key: "bytes", width: 90, render: function (row) { return formatSize(row.bytes); } },
        { title: "时间", key: "ts", width: 172, render: function (row) { return formatTime(row.ts); } },
        {
          title: "", key: "actions", width: 130,
          render: function (row) {
            return h(NFlex, { size: 4, wrap: false, justify: "end" }, {
              default: function () {
                return [
                  actionButton("恢复", "undo", { onClick: function () { restore(row); } }),
                  actionButton("删除", "trash", { onClick: function () { removeBackup(row); } })
                ];
              }
            });
          }
        }
      ];

      var slotHeight = computed(function () { return Math.max(200, store.viewport.height - 520); });

      return {
        store: store,
        gameOptions: store.liveGameOptions,
        gameKey: gameKey,
        saveDir: saveDir,
        loading: loading,
        slots: slots,
        others: others,
        backups: backups,
        slotDraft: slotDraft,
        slotColumns: slotColumns,
        otherColumns: otherColumns,
        backupColumns: backupColumns,
        slotHeight: slotHeight,
        onGameChange: onGameChange,
        refreshFiles: refreshFiles,
        backup: backup,
        saveToDraft: saveToDraft,
        openSaveDir: function () { store.openPath(saveDir.value); },
        openBackupDir: function () { store.openPath(store.backupsDir(gameKey.value)); }
      };
    },
    template: [
      '<n-flex vertical :size="14">',
      '  <n-card size="small">',
      '    <n-flex align="center" :size="10" :wrap="true">',
      '      <n-select :value="gameKey" :options="gameOptions" placeholder="选择运行中的游戏" clearable',
      '                size="small" style="width: 260px" @update:value="onGameChange"/>',
      '      <n-button size="small" tertiary :disabled="!gameKey" :loading="loading" @click="refreshFiles">',
      '        <template #icon><rm-icon name="refresh" :size="15"/></template>刷新列表',
      '      </n-button>',
      '      <n-button size="small" secondary type="primary" :disabled="!gameKey" @click="backup">',
      '        <template #icon><rm-icon name="archive" :size="15"/></template>备份存档目录',
      '      </n-button>',
      '      <n-button size="small" tertiary :disabled="!saveDir" @click="openSaveDir">',
      '        <template #icon><rm-icon name="folder" :size="15"/></template>打开存档目录',
      '      </n-button>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-result v-if="!gameKey" status="info" size="small" title="还没有选中游戏"',
      '            description="在「游戏库」启动一个游戏，然后在上面的下拉框里选它。" style="padding: 40px 0">',
      '    <template #footer>',
      '      <n-button type="primary" @click="$emit(\'open-library\')">',
      '        <template #icon><rm-icon name="gamepad" :size="15"/></template>去游戏库',
      '      </n-button>',
      '    </template>',
      '  </n-result>',

      '  <template v-else>',
      '  <n-card size="small" title="存档槽">',
      '    <template #header-extra>',
      '      <n-flex align="center" :size="8">',
      '        <n-text depth="3" style="font-size: 12px">存到槽</n-text>',
      '        <n-input-number v-model:value="slotDraft" size="small" :min="1" :show-button="false"',
      '                        style="width: 64px"/>',
      '        <n-button size="small" type="primary" secondary @click="saveToDraft">',
      '          <template #icon><rm-icon name="save" :size="15"/></template>保存',
      '        </n-button>',
      '        <rm-icon name="save"/>',
      '      </n-flex>',
      '    </template>',
      '    <n-flex vertical :size="10">',
      '      <n-text v-if="saveDir" depth="3" style="font-size: 12px">{{ saveDir }}</n-text>',
      '      <n-data-table v-if="slots.length || loading" :columns="slotColumns" :data="slots" size="small" :bordered="false"',
      '                    :row-key="row => row.entry.name" :max-height="slotHeight" :loading="loading"/>',
      '      <n-empty v-if="!slots.length && !loading" size="small" style="padding: 20px 0"',
      '               description="还没有存档槽 —— 在游戏里存一次，或用右上「保存」写入"/>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-card v-if="others.length" size="small" title="系统文件">',
      '    <n-flex vertical :size="10">',
      '      <n-text depth="3" style="font-size: 12px">global / config 等游戏自己的文件，只读展示，别手动删。</n-text>',
      '      <n-data-table :columns="otherColumns" :data="others" size="small" :bordered="false"',
      '                    :row-key="row => row.name" :max-height="180"/>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-card size="small" title="历史备份">',
      '    <template #header-extra>',
      '      <n-flex align="center" :size="8">',
      '        <n-button size="tiny" tertiary :disabled="!backups.length" @click="openBackupDir">',
      '          <template #icon><rm-icon name="folder" :size="14"/></template>打开备份目录',
      '        </n-button>',
      '        <rm-icon name="archive"/>',
      '      </n-flex>',
      '    </template>',
      '    <n-flex vertical :size="10">',
      '      <n-text depth="3" style="font-size: 12px">备份存放在 RMCH/backups/&lt;游戏名&gt;/&lt;时间戳&gt;/</n-text>',
      '      <n-data-table v-if="backups.length" :columns="backupColumns" :data="backups" size="small" :bordered="false"',
      '                    :row-key="row => row.name" :max-height="260"/>',
      '      <n-empty v-if="!backups.length" size="small" style="padding: 20px 0"',
      '               description="还没有备份 —— 改存档前点一下「备份存档目录」"/>',
      '    </n-flex>',
      '  </n-card>',
      '  </template>',
      '</n-flex>'
    ].join("\n")
  };
})();
