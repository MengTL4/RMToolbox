// 游戏库 — manually add/remove game roots and launch them with the bridge injected.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var ref = Vue.ref;
  var computed = Vue.computed;

  RMCH.views.Library = {
    name: "LibraryView",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var query = ref("");
      var dialog = naive.useDialog();

      var filtered = computed(function () {
        var needle = query.value.trim().toLowerCase();
        if (!needle) return store.state.games;
        return store.state.games.filter(function (game) {
          return game.title.toLowerCase().indexOf(needle) !== -1 ||
            game.root.toLowerCase().indexOf(needle) !== -1;
        });
      });

      var connectedCount = computed(function () {
        return store.state.games.filter(function (game) { return !!store.sessionFor(game.gameKey); }).length;
      });

      // nwdirectory is an NW.js-only <input> attribute, so the picker has to be
      // created imperatively rather than declared in the template.
      function pickFolder() {
        var input = document.createElement("input");
        input.type = "file";
        input.setAttribute("nwdirectory", "");
        input.addEventListener("change", function () {
          if (input.value) store.addManualRoot(input.value);
        });
        input.click();
      }

      // Removing only unpins the directory from the library — never touches the
      // game's files. Worth a confirm because it also loses the save-backup entry point.
      function removeGame(game) {
        dialog.warning({
          title: "移除游戏",
          content: "把「" + game.title + "」从游戏库移除？不会删除游戏文件，随时可以重新添加。",
          positiveText: "移除",
          negativeText: "取消",
          onPositiveClick: function () { store.removeManualRoot(game.root); }
        });
      }

      return {
        store: store,
        state: store.state,
        query: query,
        filtered: filtered,
        connectedCount: connectedCount,
        pickFolder: pickFolder,
        removeGame: removeGame,
        icon: RMCH.icon,
        sessionFor: store.sessionFor,
        protectionTag: store.protectionTag
      };
    },
    template: [
      '<n-flex vertical :size="14">',

      '  <n-card size="small">',
      '    <n-flex align="center" :size="10" :wrap="true">',
      '      <n-button type="primary" :loading="state.scanning" @click="pickFolder">',
      '        <template #icon><rm-icon name="folder"/></template>添加游戏目录…',
      '      </n-button>',
      '      <n-button quaternary @click="store.refreshSessions()">',
      '        <template #icon><rm-icon name="refresh"/></template>刷新状态',
      '      </n-button>',
      '      <n-input v-model:value="query" placeholder="过滤游戏名 / 路径" clearable style="width: 240px">',
      '        <template #prefix><rm-icon name="filter" :size="15"/></template>',
      '      </n-input>',
      '      <div style="flex: 1"></div>',
      '      <n-text depth="3" style="font-size: 12.5px">',
      '        {{ filtered.length }} / {{ state.games.length }} 个游戏 · {{ connectedCount }} 个已连接',
      '      </n-text>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-alert v-if="!state.games.length" type="default" :bordered="false">',
      '    <template #icon><rm-icon name="info"/></template>',
      '    游戏库是空的。点「添加游戏目录」选择游戏的安装目录（里面有 Game.exe 的那一层），可以添加多个。',
      '  </n-alert>',
      '  <n-empty v-else-if="!filtered.length" description="没有匹配的游戏" style="padding: 40px 0"/>',

      '  <div v-else class="rm-cards">',
      '    <n-card v-for="game in filtered" :key="game.gameKey" size="small" hoverable',
      '            :style="sessionFor(game.gameKey) ? \'border-left: 3px solid #22c55e\' : \'\'">',
      '      <n-flex vertical :size="10">',
      '        <n-flex align="center" :size="11" :wrap="false">',
      '          <n-avatar v-if="state.icons[game.gameKey]" :src="state.icons[game.gameKey]" :size="36"',
      '                    :border-radius="10" object-fit="cover" style="flex: none"/>',
      '          <n-icon-wrapper v-else :size="36" :border-radius="10" :color="sessionFor(game.gameKey) ? \'#22c55e\' : \'#5b8cff\'">',
      '            <rm-icon name="gamepad" :size="20"/>',
      '          </n-icon-wrapper>',
      '          <n-flex vertical :size="3" style="flex: 1; min-width: 0">',
      '            <n-ellipsis style="font-weight: 600; font-size: 14.5px">{{ game.title }}</n-ellipsis>',
      '            <n-ellipsis :line-clamp="1"><n-text depth="3" style="font-size: 11.5px">{{ game.root }}</n-text></n-ellipsis>',
      '          </n-flex>',
      '          <n-text v-if="state.pids[game.gameKey]" depth="3" style="font-size: 11px; flex: none">',
      '            pid {{ state.pids[game.gameKey] }}',
      '          </n-text>',
      '        </n-flex>',

      '        <n-flex align="center" :size="8" :wrap="true">',
      '          <n-tag size="small" :bordered="false" type="info">',
      '            {{ game.engine.id }}{{ game.engine.bytecode ? " · 字节码" : "" }}',
      '          </n-tag>',
      '          <n-tag size="small" :bordered="false" :type="protectionTag(game.protection.level).type">',
      '            {{ protectionTag(game.protection.level).label }}',
      '          </n-tag>',
      '          <n-tag v-if="sessionFor(game.gameKey)" size="small" :bordered="false" type="success">',
      '            <template #icon><rm-icon name="check" :size="13"/></template>',
      '            桥接 v{{ sessionFor(game.gameKey).bridgeVersion || "?" }}',
      '          </n-tag>',
      '          <div style="flex: 1"></div>',
      // paths.exe is null when the root has no Game.exe (e.g. an unpack/work
      // dir) — the launcher would throw anyway, so say so up front.
      '          <n-tooltip v-if="!sessionFor(game.gameKey) && !game.paths.exe" trigger="hover">',
      '            <template #trigger>',
      '              <n-button type="primary" size="small" disabled>',
      '                <template #icon><rm-icon name="play" :size="15"/></template>启动并注入',
      '              </n-button>',
      '            </template>',
      '            目录里没有 Game.exe，启动不了',
      '          </n-tooltip>',
      '          <n-button v-else-if="!sessionFor(game.gameKey)" type="primary" size="small"',
      '                    :loading="state.busy[game.gameKey] === \'launching\'"',
      '                    @click="store.launch(game)">',
      '            <template #icon><rm-icon name="play" :size="15"/></template>启动并注入',
      '          </n-button>',
      '          <n-button v-else type="error" size="small" secondary',
      '                    :loading="state.busy[game.gameKey] === \'stopping\'"',
      '                    @click="store.stop(game)">',
      '            <template #icon><rm-icon name="stop" :size="15"/></template>停止',
      '          </n-button>',
      // Attach to an already-running game (separate v-if so it stays out of
      // the launch/stop if-else chain above).
      '          <n-button v-if="!sessionFor(game.gameKey) && game.paths.exe" size="small" secondary',
      '                    :loading="state.busy[game.gameKey] === \'attaching\'"',
      '                    @click="store.attach(game)">',
      '            <template #icon><rm-icon name="zap" :size="15"/></template>附加到运行中',
      '          </n-button>',
      '          <n-button size="small" tertiary :disabled="!sessionFor(game.gameKey)"',
      '                    @click="$emit(\'open-trainer\', game.gameKey)">',
      '            <template #icon><rm-icon name="sliders" :size="15"/></template>修改器',
      '          </n-button>',
      '          <n-tooltip trigger="hover">',
      '            <template #trigger>',
      '              <n-button size="small" quaternary @click="removeGame(game)">',
      '                <template #icon><rm-icon name="trash" :size="15"/></template>',
      '              </n-button>',
      '            </template>',
      '            从游戏库移除（不删游戏文件）',
      '          </n-tooltip>',
      '        </n-flex>',
      '      </n-flex>',
      '    </n-card>',
      '  </div>',
      '</n-flex>'
    ].join("\n"),
    emits: ["open-trainer"]
  };
})();
