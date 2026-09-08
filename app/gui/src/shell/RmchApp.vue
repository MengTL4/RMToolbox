<script>
import RmchShell from './RmchShell.vue';
import { RMCH, store, ref, computed, TABS, THEME_KEY } from './app-context.js';

export default {
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

  };
</script>

<template>
<n-config-provider :theme="dark ? darkTheme : null" :theme-overrides="overrides"
                   :locale="locale" :date-locale="dateLocale">
  <n-global-style/>
  <n-message-provider placement="bottom-right" :duration="2600" :max="4">
    <n-dialog-provider>
      <rmch-shell :dark="dark" @toggle-theme="toggleTheme"/>
    </n-dialog-provider>
  </n-message-provider>
</n-config-provider>
</template>
