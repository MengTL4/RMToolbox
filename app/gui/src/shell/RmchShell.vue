<script>
import Component_RmIcon from './RmIcon.vue';
import Component_ConsoleView from '../views/ConsoleView.vue';
import Component_DataView from '../views/DataView.vue';
import Component_LibraryView from '../views/LibraryView.vue';
import Component_LogView from '../views/LogView.vue';
import Component_SavesView from '../views/SavesView.vue';
import Component_TrainerView from '../views/TrainerView.vue';

import { RMCH, store, ref, computed, TABS, THEME_KEY } from './app-context.js';

export default {
    name: "RmchShell",
    components: {
      RmIcon: Component_RmIcon,
      LibraryView: Component_LibraryView,
      TrainerView: Component_TrainerView,
      DataView: Component_DataView,
      ConsoleView: Component_ConsoleView,
      SavesView: Component_SavesView,
      LogView: Component_LogView
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
        var entries = TABS.map(function (entry) {
          return {
            key: entry.key,
            label: entry.label,
            icon: RMCH.icon(entry.icon, 18)
          };
        });
        return [entries[0], entries[1], entries[2], entries[4],
          { key: "advanced", label: "高级工具", icon: RMCH.icon("terminal", 18), children: [entries[3], entries[5]] }];
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

      // Same distinction as the library card: a live bridge is not the same as a
      // game on screen, and a black loading window must not read as a broken one.
      var currentStatus = computed(function () {
        var session = store.sessionFor(store.trainer.gameKey);
        if (!session) return { label: "已断开", type: "warning" };
        return store.sessionStatus(session);
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
        currentStatus: currentStatus,
        about: about,
        openTrainer: openTrainer
      };
    },

  };
</script>

<template>
<n-layout has-sider position="absolute">
  <n-layout-sider bordered collapse-mode="width" :collapsed-width="62" :width="184"
                  :collapsed="collapsed" show-trigger="bar" :native-scrollbar="false"
                  @collapse="collapsed = true" @expand="collapsed = false">
    <div class="rm-brand">
      <span class="rm-brand-mark"><rm-icon name="sliders" :size="16"/></span>
      <span v-if="!collapsed" class="rm-brand-text">
        <strong style="font-size: 15px; letter-spacing: .2px">RM 工具箱</strong>
        <n-text depth="3" style="font-size: 11px">RPG Maker 游戏工具</n-text>
      </span>
    </div>
    <n-menu :value="tab" :options="menuOptions" :collapsed="collapsed" :collapsed-width="62"
            :collapsed-icon-size="20" :indent="18" @update:value="v => tab = v"
            style="padding: 0 8px"/>
  </n-layout-sider>
  <n-layout>
    <n-layout-header bordered class="rm-header">
      <strong style="font-size: 15px">{{ title }}</strong>
      <div class="rm-current-game">
        <span class="rm-context-label">当前游戏</span>
        <n-select :value="store.trainer.gameKey" :options="store.currentGameOptions.value"
                  placeholder="选择已连接的游戏" size="small" filterable clearable @update:value="store.selectGame"/>
        <n-tooltip v-if="currentStatus.hint" trigger="hover">
          <template #trigger>
            <n-tag v-if="store.trainer.gameKey" size="small" :bordered="false" :type="currentStatus.type">
              {{ currentStatus.label }}
            </n-tag>
          </template>
          {{ currentStatus.hint }}
        </n-tooltip>
        <n-tag v-else-if="store.trainer.gameKey" size="small" :bordered="false" :type="currentStatus.type">
          {{ currentStatus.label }}
        </n-tag>
      </div>
      <div style="flex: 1"></div>
      <n-tag class="rm-session-count" size="small" :bordered="false" v-if="connected > 1">
        <template #icon><rm-icon name="gamepad" :size="13"/></template>
        {{ connected }} 个游戏已连接
      </n-tag>
      <n-tooltip trigger="hover">
        <template #trigger>
          <span class="rm-service-status" :aria-label="serverStatus.text">
            <span class="rm-status-dot" :style="{ background: serverStatus.dot }"></span>
          </span>
        </template>
        {{ serverStatus.text }} · 本机桥接服务 127.0.0.1:{{ state.port || 47412 }}
      </n-tooltip>
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button quaternary circle size="small" aria-label="关于工具箱" @click="showAbout = true">
            <template #icon><rm-icon name="info" :size="17"/></template>
          </n-button>
        </template>
        关于 RM 工具箱
      </n-tooltip>
      <n-tooltip trigger="hover">
        <template #trigger>
          <n-button quaternary circle size="small" aria-label="切换深浅主题" @click="$emit('toggle-theme')">
            <template #icon><rm-icon :name="dark ? 'sun' : 'moon'" :size="17"/></template>
          </n-button>
        </template>
        {{ dark ? "切换到浅色主题" : "切换到深色主题" }}
      </n-tooltip>
    </n-layout-header>
    <n-layout-content class="rm-main" :native-scrollbar="false" content-style="padding: 20px">
      <n-alert v-if="state.bootError" type="error" title="桥接服务器没有启动" style="margin-bottom: 14px">
        {{ state.bootError }} —— 端口 47412 可能已被另一个实例占用。
      </n-alert>
      <n-result v-if="tab !== 'library' && tab !== 'log' && !store.currentConnected.value"
                status="info" :title="store.trainer.gameKey ? '当前游戏已断开' : '选择一个游戏，开始修改'"
                :description="store.trainer.gameKey ? '已保留当前游戏和编辑草稿。重新连接后可以继续，未提交的修改不会自动应用。' : '到游戏库启动或连接游戏，再打开修改器。'" class="rm-empty-state">
        <template #footer><n-button type="primary" @click="tab = 'library'">前往游戏库</n-button></template>
      </n-result>
      <keep-alive>
        <component v-if="tab === 'library' || tab === 'log' || store.currentConnected.value" :is="current" :key="current" @open-trainer="openTrainer" @open-library="tab = 'library'"
                   @open-data="tab = 'data'"/>
      </keep-alive>
    </n-layout-content>
  </n-layout>
  <n-modal v-model:show="showAbout">
    <n-card style="width: 520px" title="关于 RM 工具箱" :bordered="false" role="dialog" aria-modal="true">
      <div class="rm-about">
        <span class="rm-brand-mark rm-about-mark"><rm-icon name="sliders" :size="22"/></span>
        <div style="display: flex; flex-direction: column; gap: 2px">
          <span><strong style="font-size: 16px">RM 工具箱</strong>
            <n-text depth="3" style="font-size: 12px; margin-left: 8px">v{{ about.version }}</n-text></span>
          <n-text depth="2" style="font-size: 12.5px">RPG Maker MV/MZ 与 XP/VX/VX Ace 游戏工具</n-text>
        </div>
      </div>
      <n-descriptions size="small" :column="1" bordered label-placement="left" style="margin-top: 16px">
        <n-descriptions-item label="NW.js 运行时">{{ about.nw }}</n-descriptions-item>
        <n-descriptions-item label="Chromium">{{ about.chromium }}</n-descriptions-item>
        <n-descriptions-item label="Node.js">{{ about.node }}</n-descriptions-item>
        <n-descriptions-item label="桥接端口">{{ state.port || 47412 }}（仅本机）</n-descriptions-item>
        <n-descriptions-item label="项目路径">{{ about.root }}</n-descriptions-item>
      </n-descriptions>
      <n-text depth="3" style="display: block; margin-top: 14px; font-size: 11.5px">
        仅限本地单机游戏使用 · 不修改游戏原文件 · 内部代号 RMCH
      </n-text>
    </n-card>
  </n-modal>
</n-layout>
</template>
