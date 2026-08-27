// Naive UI theme for RMCH. Every visual token lives here — views should never
// hand-write colours, radii or shadows.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});

  var FONT = '"Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
  var MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, "Courier New", monospace';

  // Brand ramp: indigo primary, violet info, shared by both schemes.
  var brand = {
    fontFamily: FONT,
    fontFamilyMono: MONO,
    fontSize: "14px",
    borderRadius: "8px",
    borderRadiusSmall: "6px",

    primaryColor: "#5b8cff",
    primaryColorHover: "#7aa4ff",
    primaryColorPressed: "#4571e0",
    primaryColorSuppl: "#5b8cff",

    infoColor: "#8b5cf6",
    infoColorHover: "#a17ff8",
    infoColorPressed: "#7442e4",
    infoColorSuppl: "#8b5cf6",

    successColor: "#22c55e",
    successColorHover: "#3dd47a",
    successColorPressed: "#17a84c",
    successColorSuppl: "#22c55e",

    warningColor: "#f59e0b",
    warningColorHover: "#fbb42a",
    warningColorPressed: "#d98706",
    warningColorSuppl: "#f59e0b",

    errorColor: "#ef4444",
    errorColorHover: "#f76a6a",
    errorColorPressed: "#d93030",
    errorColorSuppl: "#ef4444"
  };

  var darkCommon = Object.assign({}, brand, {
    bodyColor: "#0e1016",
    popoverColor: "#1b1f2a",
    cardColor: "#161a23",
    modalColor: "#1b1f2a",
    tableColor: "#161a23",
    tableColorHover: "rgba(91, 140, 255, 0.09)",
    tableHeaderColor: "#1b1f2a",
    inputColor: "#11141b",
    inputColorDisabled: "#141821",
    actionColor: "#1b1f2a",
    hoverColor: "rgba(91, 140, 255, 0.11)",
    borderColor: "#272c39",
    dividerColor: "#242936",
    scrollbarColor: "rgba(140, 152, 180, 0.38)",
    scrollbarColorHover: "rgba(140, 152, 180, 0.6)",
    textColorBase: "#eaecf3",
    textColor1: "#f2f4f9",
    textColor2: "#c9cedb",
    textColor3: "#7c8496",
    placeholderColor: "#5f6779",
    closeIconColor: "#7c8496",
    boxShadow2: "0 6px 22px rgba(0, 0, 0, 0.5)",
    boxShadow3: "0 10px 34px rgba(0, 0, 0, 0.58)"
  });

  var lightCommon = Object.assign({}, brand, {
    bodyColor: "#f4f6fb",
    cardColor: "#ffffff",
    tableColor: "#ffffff",
    tableHeaderColor: "#f6f8fd",
    tableColorHover: "rgba(91, 140, 255, 0.07)",
    hoverColor: "rgba(91, 140, 255, 0.08)",
    borderColor: "#e0e4ee",
    dividerColor: "#e6e9f2",
    textColorBase: "#1b2030",
    textColor1: "#151a27",
    textColor2: "#3b4356",
    textColor3: "#8b93a7",
    boxShadow2: "0 6px 22px rgba(24, 32, 56, 0.1)"
  });

  // Shared per-component tuning: denser cards/tables than Naive's defaults,
  // which matters a lot on a 1180px trainer window.
  function componentOverrides(common) {
    return {
      Card: {
        paddingSmall: "12px 14px",
        titleFontSizeSmall: "14px",
        titleFontWeight: "600",
        borderColor: common.borderColor
      },
      DataTable: {
        thPaddingSmall: "7px 10px",
        tdPaddingSmall: "6px 10px",
        thFontWeight: "600",
        borderRadius: "8px"
      },
      Layout: {
        headerColor: common.cardColor,
        siderColor: common.cardColor,
        color: common.bodyColor
      },
      Menu: {
        itemHeight: "40px",
        borderRadius: "8px",
        itemColorActive: "rgba(91, 140, 255, 0.16)",
        itemColorActiveHover: "rgba(91, 140, 255, 0.22)",
        itemTextColorActive: common.primaryColor,
        itemIconColorActive: common.primaryColor,
        itemTextColorActiveHover: common.primaryColor,
        itemIconColorActiveHover: common.primaryColor
      },
      Tag: { borderRadius: "6px" },
      Button: { fontWeight: "500" },
      Statistic: { valueFontSize: "20px" },
      Log: { loaderFontSize: "12.5px" }
    };
  }

  // n-config-provider expects a flat overrides object: `common` plus component
  // names as sibling keys.
  function overrides(common) {
    return Object.assign({ common: common }, componentOverrides(common));
  }

  RMCH.theme = {
    dark: overrides(darkCommon),
    light: overrides(lightCommon),
    darkTheme: naive.darkTheme,
    locale: naive.zhCN,
    dateLocale: naive.dateZhCN
  };
})();
