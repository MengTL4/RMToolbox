// 控制台 — evaluate JavaScript inside the game process via the bridge.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var ref = Vue.ref;

  var SNIPPETS = [
    { label: "加钱", code: "$gameParty.gainGold(100000)" },
    { label: "全队满血", code: "$gameParty.members().forEach(a => a.recoverAll())" },
    { label: "队伍信息", code: "$gameParty.members().map(a => [a.actorId(), a.name(), a.level])" },
    { label: "当前地图", code: "[$gameMap.mapId(), $gamePlayer.x, $gamePlayer.y]" },
    { label: "物品总数", code: "$dataItems.filter(i => i && i.name).length" }
  ];

  RMCH.views.Console = {
    name: "ConsoleView",
    components: { RmIcon: RMCH.Icon },
    setup: function () {
      var gameKey = ref(null);
      var code = ref("");
      var output = ref([]);          // { kind: "in" | "out" | "err", text }
      var running = ref(false);
      var outputRef = ref(null);
      var history = ref([]);         // executed commands, oldest first
      var historyIndex = ref(null);  // null = editing fresh input
      var historyDraft = ref("");    // stashed input while browsing history

      function scrollDown() {
        Vue.nextTick(function () {
          var node = outputRef.value;
          if (node) node.scrollTop = node.scrollHeight;
        });
      }

      function push(kind, text) {
        output.value.push({ kind: kind, text: text });
        if (output.value.length > 400) output.value.splice(0, output.value.length - 400);
        scrollDown();
      }

      function run() {
        if (!gameKey.value) return store.warn("先选择一个已连接的游戏");
        if (!code.value.trim()) return;
        running.value = true;
        push("in", code.value);
        var cmd = code.value;
        if (history.value[history.value.length - 1] !== cmd) {
          history.value.push(cmd);
          if (history.value.length > 100) history.value.splice(0, history.value.length - 100);
        }
        historyIndex.value = null;
        store.send(gameKey.value, "console.eval", { code: code.value })
          .then(function (payload) {
            push("out", JSON.stringify(payload.result, null, 2));
          })
          .catch(function (error) {
            push("err", error.message);
          })
          .finally(function () { running.value = false; });
      }

      // ↑/↓ history recall, like a real console. The textarea stays editable:
      // ↑ only hijacks when the caret sits on the first line, ↓ on the last.
      function caretOnFirstLine(event) {
        var el = event.target;
        if (!el || typeof el.selectionStart !== "number") return true;
        return el.value.slice(0, el.selectionStart).indexOf("\n") === -1;
      }
      function caretOnLastLine(event) {
        var el = event.target;
        if (!el || typeof el.selectionEnd !== "number") return true;
        return el.value.slice(el.selectionEnd).indexOf("\n") === -1;
      }
      function historyPrev(event) {
        if (!history.value.length || !caretOnFirstLine(event)) return;
        event.preventDefault();
        if (historyIndex.value === null) {
          historyDraft.value = code.value;
          historyIndex.value = history.value.length - 1;
        } else if (historyIndex.value > 0) {
          historyIndex.value -= 1;
        }
        code.value = history.value[historyIndex.value];
      }
      function historyNext(event) {
        if (historyIndex.value === null || !caretOnLastLine(event)) return;
        event.preventDefault();
        if (historyIndex.value < history.value.length - 1) {
          historyIndex.value += 1;
          code.value = history.value[historyIndex.value];
        } else {
          historyIndex.value = null;
          code.value = historyDraft.value;
        }
      }

      function useSnippet(snippet) {
        code.value = snippet.code;
      }

      // The single live session is almost always the one the user means.
      Vue.watchEffect(function () {
        var options = store.liveGameOptions.value;
        if (!gameKey.value && options.length === 1) gameKey.value = options[0].value;
        if (gameKey.value && !options.some(function (o) { return o.value === gameKey.value; })) {
          gameKey.value = null;
        }
      });

      return {
        store: store,
        gameOptions: store.liveGameOptions,
        gameKey: gameKey,
        code: code,
        output: output,
        running: running,
        outputRef: outputRef,
        snippets: SNIPPETS,
        run: run,
        historyPrev: historyPrev,
        historyNext: historyNext,
        useSnippet: useSnippet,
        prefix: function (entry) {
          return entry.kind === "in" ? "› " : (entry.kind === "err" ? "✕ " : "");
        },
        clear: function () { output.value = []; }
      };
    },
    template: [
      '<n-flex vertical :size="14">',
      '  <n-card size="small" title="在游戏进程内执行 JavaScript">',
      '    <template #header-extra><rm-icon name="terminal"/></template>',
      '    <n-flex vertical :size="12">',
      '      <n-flex align="center" :size="10" :wrap="true">',
      '        <n-select v-model:value="gameKey" :options="gameOptions" placeholder="选择运行中的游戏"',
      '                  clearable size="small" style="width: 260px"/>',
      '        <n-text depth="3" style="font-size: 12px">',
      '          可访问 $gameParty / $gameActors / $gameVariables / $dataItems 等全局对象',
      '        </n-text>',
      '      </n-flex>',

      '      <n-flex :size="6" :wrap="true">',
      '        <n-button v-for="s in snippets" :key="s.label" size="tiny" tertiary @click="useSnippet(s)">',
      '          {{ s.label }}',
      '        </n-button>',
      '      </n-flex>',

      // Native listener on a wrapper element: reliable regardless of which
      // events n-input chooses to re-emit.
      '      <div @keydown.ctrl.enter="run" @keydown.up="historyPrev" @keydown.down="historyNext">',
      '        <n-input v-model:value="code" type="textarea" class="rm-code-input" spellcheck="false"',
      '                 placeholder="// 例：$gameParty.gainGold(10000)，↑↓ 翻历史命令"',
      '                 :autosize="{ minRows: 4, maxRows: 14 }"/>',
      '      </div>',

      '      <n-flex :size="8" align="center">',
      '        <n-button type="primary" :loading="running" :disabled="!gameKey" @click="run">',
      '          <template #icon><rm-icon name="play" :size="15"/></template>执行 (Ctrl+Enter)',
      '        </n-button>',
      '        <n-button quaternary :disabled="!output.length" @click="clear">',
      '          <template #icon><rm-icon name="trash" :size="15"/></template>清空输出',
      '        </n-button>',
      '      </n-flex>',
      '    </n-flex>',
      '  </n-card>',

      '  <n-card size="small" title="输出" :content-style="\'padding: 0\'">',
      '    <div ref="outputRef" style="max-height: 46vh; min-height: 160px; overflow: auto; padding: 12px 14px">',
      '      <n-text v-if="!output.length" depth="3" style="font-size: 12.5px">尚无输出。</n-text>',
      '      <div v-for="(entry, index) in output" :key="index" class="rm-mono"',
      '           :style="entry.kind === \'err\' ? \'color:#f87171;margin-bottom:10px\' : (entry.kind === \'in\' ? \'opacity:.6;margin-bottom:4px\' : \'margin-bottom:12px\')">{{ prefix(entry) + entry.text }}</div>',
      '    </div>',
      '  </n-card>',
      '</n-flex>'
    ].join("\n")
  };
})();
