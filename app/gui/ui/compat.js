// Guards the vendored Naive UI build against what the views actually use.
//
// The pin to naive-ui 2.35.0 existed because "Chromium 91 (the NW.js runtime
// RMCH borrows) cannot parse 2.36+". That premise was wrong: the bundled NW.js
// 0.115.0 runtime is Chromium 152 (see nw-runtime.lock.json), so the newer
// bundles load fine — verified by tools/test-ui-browser.mjs against real Chrome.
// The vendor bundle is now 2.45.3 and the NFlex shim that the old pin required
// is gone.
//
// No shims remain. Keep it that way: if a view needs something the bundle lacks,
// fail here rather than quietly re-implementing a component.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});

  RMCH.shims = [];

  // Fail loudly and specifically if the vendored bundle is missing something a
  // view depends on — far easier to read than a Vue "unknown component" warning.
  var REQUIRED = [
    "NConfigProvider",
    "NGlobalStyle",
    "NMessageProvider",
    "NDialogProvider",
    "NLayout",
    "NLayoutHeader",
    "NLayoutSider",
    "NLayoutContent",
    "NMenu",
    "NCard",
    "NButton",
    "NButtonGroup",
    "NTag",
    "NText",
    "NInput",
    "NInputNumber",
    "NInputGroup",
    "NSelect",
    "NSwitch",
    "NCheckbox",
    "NRadioGroup",
    "NRadioButton",
    "NDataTable",
    "NDrawer",
    "NDrawerContent",
    "NModal",
    "NPopconfirm",
    "NCollapse",
    "NCollapseItem",
    "NDescriptions",
    "NDescriptionsItem",
    "NForm",
    "NFormItem",
    "NAlert",
    "NEmpty",
    "NResult",
    "NGrid",
    "NGi",
    "NEllipsis",
    "NIconWrapper",
    "NTooltip",
    "NSpin",
    "NLog",
    "NTabs",
    "NTabPane",
    "NDivider",
    "NScrollbar",
    "NBreadcrumb",
    "NBreadcrumbItem",
    "NDropdown",
    "NFlex",
    "darkTheme",
    "zhCN",
    "dateZhCN",
    "useMessage",
    "useDialog",
    "install"
  ];
  var missing = REQUIRED.filter(function (name) {
    return !naive[name];
  });
  if (missing.length) {
    throw new Error(
      "vendor/naive-ui.prod.js 缺少：" +
        missing.join(", ") +
        "（版本不对？期望 2.45.3）"
    );
  }
})();
