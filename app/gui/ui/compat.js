// Fills the gaps between the vendored Naive UI build and what the views use.
//
// RMCH is pinned to naive-ui 2.35.0 — the last release that Chromium 91 (the
// NW.js runtime RMCH borrows) can parse; 2.36+ ships ES2022 class `static {}`
// blocks. NFlex arrived in 2.36, so it is shimmed here. Everything registers
// onto the `naive` namespace itself so `naive.NFlex` keeps working in render
// functions, and drops out automatically if the bundle is ever upgraded.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  var h = Vue.h;

  var NAMED_SIZE = { small: 8, medium: 12, large: 16 };
  var EDGE = { start: "flex-start", end: "flex-end" };

  function gapOf(size) {
    if (Array.isArray(size)) return size[0] + "px " + size[1] + "px";
    if (typeof size === "number") return size + "px";
    if (typeof size === "string" && NAMED_SIZE[size]) return NAMED_SIZE[size] + "px";
    return NAMED_SIZE.medium + "px";
  }

  // Same public surface as naive-ui's NFlex, which is itself a thin flexbox box.
  RMCH.Flex = {
    name: "NFlex",
    props: {
      vertical: { type: Boolean, default: false },
      size: { type: [Number, String, Array], default: "medium" },
      align: String,
      justify: { type: String, default: "start" },
      wrap: { type: Boolean, default: true },
      inline: { type: Boolean, default: false }
    },
    setup: function (props, ctx) {
      return function () {
        return h("div", {
          style: {
            display: props.inline ? "inline-flex" : "flex",
            flexDirection: props.vertical ? "column" : "row",
            flexWrap: props.wrap && !props.vertical ? "wrap" : "nowrap",
            alignItems: EDGE[props.align] || props.align || undefined,
            justifyContent: EDGE[props.justify] || props.justify,
            gap: gapOf(props.size)
          }
        }, ctx.slots.default ? ctx.slots.default() : []);
      };
    }
  };

  RMCH.shims = [];
  if (!naive.NFlex) {
    naive.NFlex = RMCH.Flex;
    RMCH.shims.push("NFlex");
  }

  // Fail loudly and specifically if the vendored bundle is missing something a
  // view depends on — far easier to read than a Vue "unknown component" warning.
  var REQUIRED = [
    "NConfigProvider", "NGlobalStyle", "NMessageProvider", "NDialogProvider",
    "NLayout", "NLayoutHeader", "NLayoutSider", "NLayoutContent", "NMenu",
    "NCard", "NButton", "NButtonGroup", "NTag", "NText", "NInput", "NInputNumber",
    "NInputGroup", "NSelect", "NSwitch", "NCheckbox", "NRadioGroup", "NRadioButton",
    "NDataTable", "NDrawer", "NDrawerContent", "NModal", "NPopconfirm",
    "NCollapse", "NCollapseItem",
    "NDescriptions", "NDescriptionsItem", "NForm", "NFormItem", "NAlert",
    "NEmpty", "NResult", "NGrid", "NGi", "NEllipsis", "NIconWrapper",
    "NTooltip", "NSpin", "NLog", "NTabs", "NTabPane", "NDivider",
    "NScrollbar", "NBreadcrumb", "NBreadcrumbItem", "NDropdown",
    "darkTheme", "zhCN", "dateZhCN",
    "useMessage", "useDialog", "install"
  ];
  var missing = REQUIRED.filter(function (name) { return !naive[name]; });
  if (missing.length) {
    throw new Error("vendor/naive-ui.prod.js 缺少：" + missing.join(", ") +
      "（版本不对？期望 2.35.0）");
  }
})();
