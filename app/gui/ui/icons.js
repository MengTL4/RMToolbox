// Stroke icon set (Lucide geometry, 24x24, currentColor). Vendoring an icon
// package would add another megabyte for the ~30 glyphs this GUI uses, so the
// path data lives here and one <rm-icon name="..."> component renders it.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  var h = Vue.h;

  // Each entry is a list of [tag, attrs] shapes.
  var P = function () { return ["path", { d: Array.prototype.join.call(arguments, "") }]; };

  var ICONS = {
    zap: [P("M13 2 3 14h9l-1 8 10-12h-9l1-8z")],
    gamepad: [
      P("M6 12h4m-2-2v4"),
      P("M15 10h.01M18 13h.01"),
      P("M17.32 5H6.68a4 4 0 0 0-3.98 3.59C2.6 9.42 2 14.46 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.41-1.41A2 2 0 0 1 9.83 16h4.34a2 2 0 0 1 1.41.59L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.54-.6-6.58-.68-7.26A4 4 0 0 0 17.32 5z")
    ],
    sliders: [P("M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6")],
    terminal: [P("m4 17 6-6-6-6M12 19h8")],
    save: [
      P("M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"),
      P("M17 21v-8H7v8M7 3v5h8")
    ],
    log: [
      P("M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"),
      P("M14 2v6h6M16 13H8M16 17H8M10 9H8")
    ],
    search: [["circle", { cx: 11, cy: 11, r: 8 }], P("m21 21-4.3-4.3")],
    folder: [
      P("M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"),
      P("M12 10v6M9 13h6")
    ],
    refresh: [P("M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"), P("M21 3v5h-5")],
    undo: [P("M9 14 4 9l5-5"), P("M4 9h10.5a5.5 5.5 0 0 1 0 11H11")],
    redo: [P("m15 14 5-5-5-5"), P("M20 9H9.5a5.5 5.5 0 0 0 0 11H13")],
    play: [P("M6 3 20 12 6 21z")],
    stop: [["rect", { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
    archive: [
      ["rect", { x: 2, y: 3, width: 20, height: 5, rx: 1 }],
      P("M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4")
    ],
    trash: [P("M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6")],
    plus: [P("M5 12h14M12 5v14")],
    users: [
      P("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"),
      ["circle", { cx: 9, cy: 7, r: 4 }],
      P("M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75")
    ],
    box: [
      P("M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"),
      P("m3.3 7 8.7 5 8.7-5M12 22V12m-4.5-7.7 9 5.15")
    ],
    layers: [
      P("M11.17 2.18a2 2 0 0 1 1.66 0l8.58 3.9a1 1 0 0 1 0 1.83l-8.58 3.91a2 2 0 0 1-1.66 0L2.6 7.91a1 1 0 0 1 0-1.83Z"),
      P("m6.08 9.5-3.48 1.58a1 1 0 0 0 0 1.83l8.57 3.9a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83L17.92 9.5"),
      P("m6.08 14.5-3.48 1.58a1 1 0 0 0 0 1.83l8.57 3.9a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83l-3.49-1.58")
    ],
    toggle: [
      ["rect", { x: 2, y: 6, width: 20, height: 12, rx: 6 }],
      ["circle", { cx: 8, cy: 12, r: 2.5 }]
    ],
    database: [
      ["ellipse", { cx: 12, cy: 5, rx: 9, ry: 3 }],
      P("M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"),
      P("M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3")
    ],
    pin: [P("M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"), ["circle", { cx: 12, cy: 10, r: 3 }]],
    sword: [P("M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2")],
    coins: [
      ["circle", { cx: 8, cy: 8, r: 6 }],
      P("M18.09 10.37A6 6 0 1 1 10.34 18"),
      P("M7 6h1v4m6.71 3.88.7.71-2.82 2.82")
    ],
    heart: [P("M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z")],
    edit: [P("M12 20h9"), P("M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z")],
    close: [P("M18 6 6 18M6 6l12 12")],
    check: [P("M20 6 9 17l-5-5")],
    sun: [
      ["circle", { cx: 12, cy: 12, r: 4 }],
      P("M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41")
    ],
    moon: [P("M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z")],
    power: [P("M12 2v10"), P("M18.36 6.64a9 9 0 1 1-12.73 0")],
    wand: [P("M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5")],
    filter: [P("M22 3H2l8 9.46V19l4 2v-8.54L22 3z")],
    grid: [P("M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z")],
    info: [["circle", { cx: 12, cy: 12, r: 10 }], P("M12 16v-4M12 8h.01")]
  };

  RMCH.Icon = {
    name: "RmIcon",
    props: {
      name: { type: String, required: true },
      size: { type: [Number, String], default: 18 }
    },
    setup: function (props) {
      return function () {
        var shapes = ICONS[props.name] || ICONS.info;
        return h(
          "svg",
          {
            xmlns: "http://www.w3.org/2000/svg",
            viewBox: "0 0 24 24",
            width: props.size,
            height: props.size,
            fill: "none",
            stroke: "currentColor",
            "stroke-width": 1.8,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            style: { display: "block", flex: "none" }
          },
          shapes.map(function (shape) { return h(shape[0], shape[1]); })
        );
      };
    }
  };

  // Naive UI slots want a factory (`{ icon: () => h(...) }`); this keeps call
  // sites to `RMCH.icon("zap")`.
  RMCH.icon = function (name, size) {
    return function () { return h(RMCH.Icon, { name: name, size: size }); };
  };

  RMCH.iconNames = Object.keys(ICONS);
})();
