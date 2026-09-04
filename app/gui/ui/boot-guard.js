// Runs before anything else: paints uncaught boot/runtime errors into the page
// (and runtime/gui.log when the Node glue is reachable) so a failed mount never
// shows up as a blank NW window.

(function () {
  "use strict";

  var box = null;

  function show(title, detail) {
    if (!box) box = document.getElementById("boot-error");
    if (!box) return;
    box.hidden = false;
    var block = document.createElement("div");
    block.className = "boot-error-item";
    var head = document.createElement("strong");
    head.textContent = title;
    var body = document.createElement("pre");
    body.textContent = detail;
    block.appendChild(head);
    block.appendChild(body);
    box.appendChild(block);
  }

  function mirror(line) {
    // Best effort: gui-server owns the log file, but it may not have booted yet.
    try {
      var server = require("./host.cjs");
      if (server && typeof server.log === "function") server.log(line);
    } catch (_) {}
  }

  function report(title, error) {
    var detail = (error && (error.stack || error.message)) || String(error);
    show(title, detail);
    mirror("[page] " + title + " " + detail);
  }

  window.addEventListener("error", function (event) {
    var message = String((event.error && event.error.message) || event.message || "");
    // Chromium's self-healing ResizeObserver notice ("loop limit exceeded" /
    // "loop completed with undelivered notifications"): Naive UI tables and
    // scrollbars trip it during normal layout, the layout settles on the next
    // frame, and nothing is actually broken. Log quietly, never paint it.
    if (/ResizeObserver loop/.test(message)) {
      mirror("[page] ResizeObserver notice ignored: " + message);
      return;
    }
    report("页面脚本错误 · " + (event.filename || "?") + ":" + (event.lineno || 0), event.error || event.message);
  });

  window.addEventListener("unhandledrejection", function (event) {
    report("未处理的 Promise 拒绝", event.reason);
  });

  window.RMCH = window.RMCH || {};
  window.RMCH.reportFatal = report;
})();
