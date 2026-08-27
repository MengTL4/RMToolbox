// App shell: sider nav + header status + the active view.
//
// Two components on purpose — the theme/locale/message providers have to sit
// above anything that calls useMessage()/useDialog(), so RmchShell renders
// inside RmchApp's provider stack.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});

  var store = RMCH.store;
  var ref = Vue.ref;
  var computed = Vue.computed;

  var TABS = [
    { key: "library", label: "游戏库", icon: "gamepad" },
    { key: "trainer", label: "修改器", icon: "sliders" },
    { key: "data", label: "数据", icon: "layers" },
    { key: "console", label: "控制台", icon: "terminal" },
    { key: "saves", label: "存档", icon: "save" },
    { key: "log", label: "日志", icon: "log" }
  ];

  var THEME_KEY = "rmch.theme";

  // ---------------------------------------------------------------------------

  var RmchShell = {
    name: "RmchShell",
    components: {
      RmIcon: RMCH.Icon,
      LibraryView: RMCH.views.Library,
      TrainerView: RMCH.views.Trainer,
      DataView: RMCH.views.Data,
      ConsoleView: RMCH.views.Console,
      SavesView: RMCH.views.Saves,
      LogView: RMCH.views.Log
    },
    props: {
      dark: { type: Boolean, required: true }
    },
    emits: ["toggle-theme"],
    setup: function (props) {
      var tab = ref("library");
      var collapsed = ref(false);
      var showAbout = ref(false);

      // Store actions raise toasts; they need the providers that only exist
      // inside this component's tree.
      store.attachFeedback({ message: naive.useMessage(), dialog: naive.useDialog() });

      var menuOptions = computed(function () {
        return TABS.map(function (entry) {
          return {
            key: entry.key,
            label: entry.label,
            icon: RMCH.icon(entry.icon, 18)
          };
        });
      });

      var current = computed(function () {
        return {
          library: "library-view",
          trainer: "trainer-view",
          data: "data-view",
          console: "console-view",
          saves: "saves-view",
          log: "log-view"
        }[tab.value];
      });

      var title = computed(function () {
        var found = TABS.filter(function (entry) { return entry.key === tab.value; })[0];
        return found ? found.label : "";
      });

      // Native title bar follows the page: "RM 工具箱 · 修改器".
      Vue.watch(title, function (value) {
        document.title = "RM 工具箱" + (value ? " · " + value : "");
      }, { immediate: true });

      // The raw 127.0.0.1:port used to sit in the header — dev telemetry, not
      // product UI. It now lives in the tooltip of a plain status pill.
      var serverStatus = computed(function () {
        if (store.state.bootError) return { type: "error", dot: "#ef4444", text: "服务异常" };
        if (!store.state.ready) return { type: "warning", dot: "#f59e0b", text: "服务启动中…" };
        return { type: "success", dot: "#22c55e", text: "服务正常" };
      });

      var connected = computed(function () {
        return store.state.sessions.filter(function (session) { return session.alive; }).length;
      });

      var about = computed(function () {
        var info = store.state.about || {};
        return {
          version: info.appVersion || "未知",
          nw: info.nw || "未知",
          chromium: info.chromium || "未知",
          node: info.node || "未知",
          root: store.state.projectRoot || "未知"
        };
      });

      function openTrainer(gameKey) {
        store.selectGame(gameKey);
        tab.value = "trainer";
      }

      return {
        store: store,
        state: store.state,
        tab: tab,
        collapsed: collapsed,
        showAbout: showAbout,
        menuOptions: menuOptions,
        current: current,
        title: title,
        serverStatus: serverStatus,
        connected: connected,
        about: about,
        openTrainer: openTrainer
      };
    },
    template: [
      '<n-layout has-sider position="absolute">',
      '  <n-layout-sider bordered collapse-mode="width" :collapsed-width="62" :width="200"',
      '                  :collapsed="collapsed" show-trigger="bar" :native-scrollbar="false"',
      '                  @collapse="collapsed = true" @expand="collapsed = false">',
      '    <div class="rm-brand">',
      '      <span class="rm-brand-mark"><rm-icon name="sliders" :size="16"/></span>',
      '      <span v-if="!collapsed" class="rm-brand-text">',
      '        <strong style="font-size: 15px; letter-spacing: .2px">RM 工具箱</strong>',
      '        <n-text depth="3" style="font-size: 10.5px">RPG Maker MV/MZ 修改器</n-text>',
      '      </span>',
      '    </div>',
      '    <n-menu :value="tab" :options="menuOptions" :collapsed="collapsed" :collapsed-width="62"',
      '            :collapsed-icon-size="20" :indent="18" @update:value="v => tab = v"',
      '            style="padding: 0 8px"/>',
      '  </n-layout-sider>',

      '  <n-layout>',
      '    <n-layout-header bordered style="height: 52px; padding: 0 18px; display: flex; align-items: center; gap: 12px">',
      '      <strong style="font-size: 15px">{{ title }}</strong>',
      '      <div style="flex: 1"></div>',
      '      <n-tag size="small" :bordered="false" type="info" v-if="connected">',
      '        <template #icon><rm-icon name="gamepad" :size="13"/></template>',
      '        {{ connected }} 个游戏已连接',
      '      </n-tag>',
      '      <n-tooltip trigger="hover">',
      '        <template #trigger>',
      '          <n-tag size="small" :bordered="false" :type="serverStatus.type">',
      '            <span class="rm-status-dot" :style="{ background: serverStatus.dot }"></span>',
      '            {{ serverStatus.text }}',
      '          </n-tag>',
      '        </template>',
      '        桥接服务 127.0.0.1:{{ state.port || 47412 }}（WebSocket，仅本机）',
      '      </n-tooltip>',
      '      <n-tooltip trigger="hover">',
      '        <template #trigger>',
      '          <n-button quaternary circle size="small" @click="showAbout = true">',
      '            <template #icon><rm-icon name="info" :size="17"/></template>',
      '          </n-button>',
      '        </template>',
      '        关于 RM 工具箱',
      '      </n-tooltip>',
      '      <n-tooltip trigger="hover">',
      '        <template #trigger>',
      '          <n-button quaternary circle size="small" @click="$emit(\'toggle-theme\')">',
      '            <template #icon><rm-icon :name="dark ? \'sun\' : \'moon\'" :size="17"/></template>',
      '          </n-button>',
      '        </template>',
      '        {{ dark ? "切换到浅色主题" : "切换到深色主题" }}',
      '      </n-tooltip>',
      '    </n-layout-header>',

      '    <n-layout-content :native-scrollbar="false" content-style="padding: 16px">',
      '      <n-alert v-if="state.bootError" type="error" title="桥接服务器没有启动" style="margin-bottom: 14px">',
      '        {{ state.bootError }} —— 端口 47412 可能已被另一个实例占用。',
      '      </n-alert>',
      '      <keep-alive>',
      '        <component :is="current" @open-trainer="openTrainer" @open-library="tab = \'library\'"',
      '                   @open-data="tab = \'data\'"/>',
      '      </keep-alive>',
      '    </n-layout-content>',
      '  </n-layout>',

      '  <n-modal v-model:show="showAbout">',
      '    <n-card style="width: 520px" title="关于 RM 工具箱" :bordered="false" role="dialog" aria-modal="true">',
      '      <div class="rm-about">',
      '        <span class="rm-brand-mark rm-about-mark"><rm-icon name="sliders" :size="22"/></span>',
      '        <div style="display: flex; flex-direction: column; gap: 2px">',
      '          <span><strong style="font-size: 16px">RM 工具箱</strong>',
      '            <n-text depth="3" style="font-size: 12px; margin-left: 8px">v{{ about.version }}</n-text></span>',
      '          <n-text depth="2" style="font-size: 12.5px">通用 RPG Maker MV/MZ 单机游戏修改器</n-text>',
      '        </div>',
      '      </div>',
      '      <n-descriptions size="small" :column="1" bordered label-placement="left" style="margin-top: 16px">',
      '        <n-descriptions-item label="NW.js 运行时">{{ about.nw }}</n-descriptions-item>',
      '        <n-descriptions-item label="Chromium">{{ about.chromium }}</n-descriptions-item>',
      '        <n-descriptions-item label="Node.js">{{ about.node }}</n-descriptions-item>',
      '        <n-descriptions-item label="桥接端口">{{ state.port || 47412 }}（仅本机）</n-descriptions-item>',
      '        <n-descriptions-item label="项目路径">{{ about.root }}</n-descriptions-item>',
      '      </n-descriptions>',
      '      <n-text depth="3" style="display: block; margin-top: 14px; font-size: 11.5px">',
      '        仅限本地单机游戏使用 · 不修改游戏原文件 · 内部代号 RMCH',
      '      </n-text>',
      '    </n-card>',
      '  </n-modal>',
      '</n-layout>'
    ].join("\n")
  };

  // ---------------------------------------------------------------------------

  RMCH.App = {
    name: "RmchApp",
    components: { RmchShell: RmchShell },
    setup: function () {
      var stored = null;
      try { stored = window.localStorage.getItem(THEME_KEY); } catch (_) {}
      var dark = ref(stored !== "light");

      // Briefly enable a cross-fade on painted colours so the flip doesn't
      // snap. The class lives just past the 150ms transition window.
      var animTimer = null;
      function toggleTheme() {
        var root = document.documentElement;
        root.classList.add("rm-theme-anim");
        clearTimeout(animTimer);
        animTimer = setTimeout(function () { root.classList.remove("rm-theme-anim"); }, 220);
        dark.value = !dark.value;
        try { window.localStorage.setItem(THEME_KEY, dark.value ? "dark" : "light"); } catch (_) {}
      }

      // Naive UI theming is CSS-in-JS, so the vendored jsoneditor stylesheet has
      // no way to know which scheme is live — mirror it onto <body> for
      // jsoneditor-theme.css (whose context menu / modals hang off <body> too).
      Vue.watchEffect(function () {
        var classes = document.body.classList;
        classes.toggle("rm-dark", dark.value);
        classes.toggle("rm-light", !dark.value);
      });

      return {
        dark: dark,
        toggleTheme: toggleTheme,
        darkTheme: RMCH.theme.darkTheme,
        overrides: computed(function () { return dark.value ? RMCH.theme.dark : RMCH.theme.light; }),
        locale: RMCH.theme.locale,
        dateLocale: RMCH.theme.dateLocale
      };
    },
    template: [
      '<n-config-provider :theme="dark ? darkTheme : null" :theme-overrides="overrides"',
      '                   :locale="locale" :date-locale="dateLocale">',
      '  <n-global-style/>',
      '  <n-message-provider placement="bottom-right" :duration="2600" :max="4">',
      '    <n-dialog-provider>',
      '      <rmch-shell :dark="dark" @toggle-theme="toggleTheme"/>',
      '    </n-dialog-provider>',
      '  </n-message-provider>',
      '</n-config-provider>'
    ].join("\n")
  };

  // Exported so tools/gui-check.mjs can compile its template too.
  RMCH.Shell = RmchShell;
})();
