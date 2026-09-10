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

export { RMCH, store, ref, computed, TABS, THEME_KEY };
