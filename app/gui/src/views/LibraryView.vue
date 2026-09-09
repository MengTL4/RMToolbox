<script>
import Component_RmIcon from '../shell/RmIcon.vue';
import Component_InjectionGuide from '../components/InjectionGuide.vue';

var RMCH = (window.RMCH = window.RMCH || {});

var store = RMCH.store;
var state = store.state;

var ref = Vue.ref;

var computed = Vue.computed;

var ROUTE_LABELS = {
  auto: "自动",
  shadow: "影子目录",
  dll: "DLL 注入",
  extension: "扩展启动",
  "evb-unpack-rgss-script": "EVB/RGSS 专用",
  "rgss-script": "RGSS 专用",
  "tauri-cdp": "Tauri/CDP 专用",
  "extension-cdp-seed": "封闭 MZ/CDP 专用",
  "shadow-engine-publish": "合体引擎专用"
};

function routeLabel(id) { return ROUTE_LABELS[id] || id || "不可用"; }

export default {
    name: "LibraryView",
    components: { RmIcon: Component_RmIcon, InjectionGuide: Component_InjectionGuide },
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
      function unavailable(game) {
        if (!game.paths.exe) return "未找到游戏启动程序";
        if (game.engine.id === "RM2K" || game.container === "nb-shell") return "当前版本暂不支持连接此游戏";
        return "";
      }
      function takeover(game) { return game.container === "nwjs-sealed" || game.container === "nwjs-bundled"; }
      function attach(game) {
        if (!takeover(game)) return store.attach(game);
        dialog.warning({
          title: "重启并连接「" + game.title + "」",
          content: "此游戏需要结束现有实例，再由工具箱重新启动。请先在游戏中保存进度。",
          positiveText: "重启并连接", negativeText: "取消",
          onPositiveClick: function () { return store.attach(game); }
        });
      }
      function stop(game) {
        dialog.warning({ title: "结束「" + game.title + "」", content: "游戏将关闭，请确认已保存进度。",
          positiveText: "结束游戏", negativeText: "取消", onPositiveClick: function () { return store.stop(game); } });
      }
      function retry(game) {
        var operation = store.state.operations[game.gameKey];
        if (operation && operation.kind === "attaching") return attach(game);
        if (operation && operation.kind === "stopping") return stop(game);
        return store.launch(game);
      }

      function routePlan(game) {
        return state.routePlans[game.gameKey] || { selected: null, candidates: [] };
      }
      function routeChoice(game) {
        var plan = routePlan(game);
        var value = state.routeChoices[game.gameKey] || "auto";
        var allowed = (plan.candidates || []).map(function (entry) { return entry.id; });
        return value === "auto" || allowed.indexOf(value) !== -1 ? value : "auto";
      }
      function routeOptions(game) {
        var plan = routePlan(game);
        var entries = plan.candidates || [];
        if (!entries.length) return [];
        return [{
          label: plan.preferred ? "自动（" + routeLabel(plan.preferred) + "）" : "自动",
          value: "auto"
        }].concat(entries.map(function (entry) {
          return { label: routeLabel(entry.id), value: entry.id };
        }));
      }
      function routeTitle(game) {
        var plan = routePlan(game);
        if (!plan.selected) return plan.error || "没有可用路线";
        return routeLabel(plan.preferred || plan.selected);
      }
      function chooseRoute(game, value) {
        state.routeChoices[game.gameKey] = value;
      }

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
        unavailable: unavailable, takeover: takeover, attach: attach, stop: stop, retry: retry,
        routePlan: routePlan, routeChoice: routeChoice, routeOptions: routeOptions,
        routeTitle: routeTitle, chooseRoute: chooseRoute, routeLabel: routeLabel,
        pickFolder: pickFolder,
        removeGame: removeGame,
        icon: RMCH.icon,
        sessionFor: store.sessionFor,
        protectionTag: store.protectionTag
      };
    },

    emits: ["open-trainer"]
  };
</script>

<template>
<n-flex vertical :size="14">
  <div class="rm-page-heading">
    <div><h1>你的游戏</h1><n-text depth="3">连接游戏，调整数值，继续冒险。</n-text></div>
    <n-text depth="3">{{ state.games.length }} 个游戏 · {{ connectedCount }} 个已连接</n-text>
  </div>
  <n-card size="small">
    <n-flex align="center" :size="10" :wrap="true">
      <n-button type="primary" :loading="state.scanning" @click="pickFolder">
        <template #icon><rm-icon name="folder"/></template>添加游戏目录…
      </n-button>
      <n-button quaternary @click="store.refreshSessions()">
        <template #icon><rm-icon name="refresh"/></template>刷新状态
      </n-button>
      <n-input v-model:value="query" placeholder="搜索游戏名或路径" clearable style="flex: 1; min-width: 180px; max-width: 320px">
        <template #prefix><rm-icon name="filter" :size="15"/></template>
      </n-input>
      <div style="flex: 1"></div>
      <n-text depth="3" style="font-size: 12.5px">
        {{ query ? filtered.length + " 个匹配结果" : "选择游戏，开始连接" }}
      </n-text>
    </n-flex>
  </n-card>
  <injection-guide/>
  <n-alert v-if="!state.games.length" type="default" :bordered="false">
    <template #icon><rm-icon name="info"/></template>
    游戏库是空的。点「添加游戏目录」选择游戏的安装目录（里面有 Game.exe 的那一层），可以添加多个。
  </n-alert>
  <n-empty v-else-if="!filtered.length" description="没有匹配的游戏" style="padding: 40px 0"/>
  <div v-else class="rm-cards">
    <n-card v-for="game in filtered" :key="game.gameKey" size="small" hoverable class="rm-game-card"
            :class="{ 'rm-game-connected': !!sessionFor(game.gameKey) }">
      <n-flex vertical :size="10">
        <n-flex align="center" :size="11" :wrap="false">
          <n-avatar v-if="state.icons[game.gameKey]" :src="state.icons[game.gameKey]" :size="36"
                    :border-radius="10" object-fit="cover" style="flex: none"/>
          <n-icon-wrapper v-else :size="36" :border-radius="10" :color="sessionFor(game.gameKey) ? '#22c55e' : '#5b8cff'">
            <rm-icon name="gamepad" :size="20"/>
          </n-icon-wrapper>
          <n-flex vertical :size="3" style="flex: 1; min-width: 0">
            <n-ellipsis style="font-weight: 600; font-size: 14.5px">{{ game.title }}</n-ellipsis>
            <n-ellipsis :line-clamp="1"><n-text depth="3" style="font-size: 11.5px">{{ game.root }}</n-text></n-ellipsis>
          </n-flex>
        </n-flex>
        <n-flex align="center" :size="8" :wrap="true">
          <n-tag size="small" :bordered="false" :type="sessionFor(game.gameKey) ? 'success' : 'default'">
            {{ state.busy[game.gameKey] ? "处理中" : sessionFor(game.gameKey) ? "已连接" : "未连接" }}
          </n-tag>
          <n-tooltip><template #trigger><n-text depth="3" style="font-size:12px">{{ game.engine.id }}</n-text></template>
            {{ protectionTag(game.protection.level).label }} · {{ game.container || "标准游戏" }}
          </n-tooltip>
          <div style="flex: 1"></div>
          <n-select v-if="(routePlan(game).candidates || []).length > 1" size="small" style="width: 150px"
                    :value="routeChoice(game)" :options="routeOptions(game)"
                    :disabled="!!state.busy[game.gameKey]" @update:value="value => chooseRoute(game, value)"/>
          <n-tooltip v-else-if="(routePlan(game).candidates || []).length === 1" trigger="hover">
            <template #trigger><n-tag size="small" :bordered="false" type="info">{{ routeTitle(game) }}</n-tag></template>
            当前游戏只有这一条安全启动路线
          </n-tooltip>
          <n-tooltip v-if="!sessionFor(game.gameKey) && unavailable(game)" trigger="hover">
            <template #trigger>
              <n-button type="primary" size="small" disabled>
                <template #icon><rm-icon name="play" :size="15"/></template>暂不可连接
              </n-button>
            </template>
            {{ unavailable(game) }}
          </n-tooltip>
          <n-button v-else-if="!sessionFor(game.gameKey)" type="primary" size="small"
                    :loading="state.busy[game.gameKey] === 'launching'"
                    :disabled="!!state.busy[game.gameKey]"
                    @click="store.launch(game)">
            <template #icon><rm-icon name="play" :size="15"/></template>{{ state.busy[game.gameKey] ? "连接中…" : "启动并注入" }}
          </n-button>
          <n-button v-else type="primary" size="small" :disabled="!!state.busy[game.gameKey]"
                    @click="$emit('open-trainer', game.gameKey)">
            <template #icon><rm-icon name="sliders" :size="15"/></template>打开修改器
          </n-button>
        </n-flex>
        <n-flex align="center" :size="6" :wrap="true">
          <n-button v-if="!sessionFor(game.gameKey) && !unavailable(game) && game.container !== 'tauri'" size="small" secondary
                    :loading="state.busy[game.gameKey] === 'attaching'"
                    :disabled="!!state.busy[game.gameKey]" @click="attach(game)">
            <template #icon><rm-icon name="zap" :size="14"/></template>{{ takeover(game) ? "接管重启并连接" : "附加到运行中" }}
          </n-button>
          <n-button v-if="sessionFor(game.gameKey)" size="tiny" quaternary :disabled="!!state.busy[game.gameKey]" @click="stop(game)">
            <template #icon><rm-icon name="stop" :size="14"/></template>结束游戏
          </n-button>
          <div style="flex:1"></div>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button size="tiny" quaternary aria-label="从游戏库移除" :disabled="!!state.busy[game.gameKey]" @click="removeGame(game)">
                <template #icon><rm-icon name="trash" :size="15"/></template>
              </n-button>
            </template>
            从游戏库移除（不删游戏文件）
          </n-tooltip>
        </n-flex>
        <n-alert v-if="state.operations[game.gameKey] && (state.operations[game.gameKey].status !== 'success' || !sessionFor(game.gameKey))"
                 :type="state.operations[game.gameKey].status === 'error' ? 'error' : 'info'" :show-icon="false" :bordered="false" class="rm-operation-status" aria-live="polite">
          {{ state.operations[game.gameKey].text }}
          <n-button v-if="state.operations[game.gameKey].status === 'error'" size="tiny" tertiary :disabled="!!state.busy[game.gameKey]" @click="retry(game)">重试</n-button>
        </n-alert>
      </n-flex>
    </n-card>
  </div>
</n-flex>
</template>
