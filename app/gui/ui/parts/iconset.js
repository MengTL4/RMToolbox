// In-game item/skill/state icons, sliced out of the game's IconSet.png.
//
// The sheet is read through host.cjs as a data URL (a file:// <img> would
// taint the canvas and make slicing impossible). When the file on disk is
// unreadable — MV encryption (.rpgmvp) or custom asset protection — the sheet
// comes from the running game instead (bridge command assets.iconset), whose
// own loader has already decrypted it. One sheet per game, sliced lazily per
// icon index and cached — a catalog can be 1400 entries, but the virtual list
// only renders a screenful at a time.
//
// Sheet geometry: 32px cells, column count derived from the image width
// (MV 384px → 12 cols, MZ 512px → 16 cols; plugin sheets just work).

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  var CELL = 32;
  var TILE_CACHE_CAP = 800;

  // gameKey -> { state: "loading"|"ready"|"failed", image, cols, tiles, promise }
  var sheets = {};
  var canvas = null;
  // Bumped on every sheet state transition so lists can reactively drop the
  // icon column when a game's sheet turns out to be unavailable.
  var sheetVersion = Vue.ref(0);

  function rootFor(gameKey) {
    var games = RMCH.store.state.games;
    for (var i = 0; i < games.length; i += 1) {
      if (games[i].gameKey === gameKey) return games[i].root;
    }
    return null;
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var image = new Image();
      image.onload = function () { resolve(image); };
      image.onerror = function () { reject(new Error("image decode failed")); };
      image.src = url;
    });
  }

  function ensure(gameKey) {
    if (!gameKey) return Promise.resolve(false);
    var sheet = sheets[gameKey];
    if (sheet) return sheet.promise;
    sheet = sheets[gameKey] = { state: "loading", image: null, cols: 0, tiles: {}, tileCount: 0 };
    sheet.promise = new Promise(function (resolve) {
      function finish(image) {
        sheet.image = image;
        sheet.cols = Math.max(1, Math.floor(image.width / CELL));
        sheet.state = "ready";
        sheetVersion.value += 1;
        resolve(true);
      }
      function fail() {
        sheet.state = "failed";
        sheetVersion.value += 1;
        resolve(false);
      }
      // The sheet on disk is often unreadable (MV .rpgmvp, custom asset
      // protection) — then ask the running game, whose own loader has already
      // decoded it into a Bitmap (bridge command assets.iconset).
      function viaBridge() {
        if (!RMCH.store || !RMCH.store.send) return fail();
        RMCH.store.send(gameKey, "assets.iconset", {}).then(function (payload) {
          if (!payload || !payload.dataUrl) return fail();
          loadImage(payload.dataUrl).then(finish, fail);
        }, fail);
      }
      var root = rootFor(gameKey);
      var url = null;
      try {
        url = root && RMCH.store.server.iconSetImage(root);
      } catch (_) {}
      if (url) loadImage(url).then(finish, viaBridge);
      else viaBridge();
    });
    return sheet.promise;
  }

  // Synchronous once the sheet is ready; null while loading or on failure.
  function tile(gameKey, index) {
    var sheet = sheets[gameKey];
    if (!sheet || sheet.state !== "ready") return null;
    var id = Math.floor(Number(index));
    if (!isFinite(id) || id < 0) return null;
    if (sheet.tiles[id]) return sheet.tiles[id];
    if (sheet.tileCount >= TILE_CACHE_CAP) return null;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = CELL;
      canvas.height = CELL;
    }
    var ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, CELL, CELL);
    ctx.drawImage(sheet.image, (id % sheet.cols) * CELL, Math.floor(id / sheet.cols) * CELL,
      CELL, CELL, 0, 0, CELL, CELL);
    var url = canvas.toDataURL("image/png");
    sheet.tiles[id] = url;
    sheet.tileCount += 1;
    return url;
  }

  RMCH.iconset = {
    ensure: ensure,
    tile: tile,
    version: sheetVersion,
    // "none" (never asked) | "loading" | "ready" | "failed" — lists read this
    // to decide whether an icon column is worth rendering at all.
    state: function (gameKey) {
      var sheet = sheets[gameKey];
      return sheet ? sheet.state : "none";
    }
  };

  // <rm-game-icon game-key index size/> — renders the sliced tile, a dim
  // placeholder while the sheet loads, and nothing at all when the sheet is
  // unavailable (encrypted and no live bridge) or index is null.
  RMCH.parts.GameIcon = {
    name: "RmGameIcon",
    props: {
      gameKey: { type: String, required: true },
      index: { type: Number, default: null },
      size: { type: Number, default: 22 }
    },
    setup: function (props) {
      var version = Vue.ref(0);      // bumped when the sheet resolves, re-running src
      var failed = Vue.ref(false);
      Vue.watch(function () { return props.gameKey; }, function (key) {
        failed.value = false;
        if (!key) return;
        ensure(key).then(function (ok) {
          failed.value = !ok;
          version.value += 1;
        });
      }, { immediate: true });

      var src = Vue.computed(function () {
        if (props.index == null) return null;
        version.value;               // depend
        return tile(props.gameKey, props.index);
      });

      return function () {
        if (props.index == null || failed.value) return null;
        if (!src.value) {
          return Vue.h("span", {
            class: "rm-gicon rm-gicon-ph",
            style: { width: props.size + "px", height: props.size + "px" }
          });
        }
        return Vue.h("img", {
          class: "rm-gicon",
          src: src.value,
          width: props.size,
          height: props.size,
          draggable: false,
          alt: ""
        });
      };
    }
  };
})();
