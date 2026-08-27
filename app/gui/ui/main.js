// Mount point. Everything above this file only defines things.

(function () {
  "use strict";

  var RMCH = window.RMCH;

  var app = Vue.createApp(RMCH.App);

  app.use(naive);
  app.component("RmIcon", RMCH.Icon);
  // app.use(naive) registers a fixed component list, so anything ui/compat.js
  // added to the namespace has to be registered by hand.
  RMCH.shims.forEach(function (name) { app.component(name, naive[name]); });

  app.config.errorHandler = function (error, instance, info) {
    RMCH.reportFatal("Vue 运行时错误 · " + info, error);
  };

  app.mount("#app");

  // Bridge server + first library scan. Kept out of setup() so a slow scan
  // never delays the first paint.
  RMCH.store.init();

  try {
    var server = require("./host.cjs");
    if (typeof server.log === "function") server.log("gui ui mounted (vue " + Vue.version + ")");
  } catch (_) {}
})();
