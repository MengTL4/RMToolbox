<script>
var RMCH = (window.RMCH = window.RMCH || {});

var RETRY_MS = 15000;

var CACHE_CAP = 800;

var games = new Map();

var canvas = null;

function describeGame(key) {
  var store = RMCH.store;
  var game = store.state.games.find(function (entry) {
    return entry.gameKey === key;
  });
  var session = store.sessionFor ? store.sessionFor(key) : null;
  var root = game ? game.root : null;
  var engine = game && game.engine ? game.engine.id : "";
  return {
    key: key,
    root: root,
    engine: engine,
    identity: JSON.stringify([
      key,
      root,
      engine,
      session && session.connectedAt
    ])
  };
}

function recordFor(info) {
  var record = games.get(info.key);
  if (!record || record.identity !== info.identity) {
    record = {
      key: info.key,
      root: info.root,
      identity: info.identity,
      cell: /^RGSS/i.test(info.engine) ? 24 : 32,
      hasSheet: info.engine !== "RGSS1",
      users: 0,
      state: Vue.ref("none"),
      image: null,
      cols: 0,
      tiles: new Map(),
      names: new Map(),
      nameVersion: Vue.ref(0),
      nameRetry: null,
      promise: null,
      retry: null,
      retryAt: 0
    };
    games.set(info.key, record);
  }
  return record;
}

function loadImage(url) {
  return new Promise(function (resolve, reject) {
    var image = new Image();
    image.onload = function () {
      resolve(image);
    };
    image.onerror = function () {
      reject(new Error("image decode failed"));
    };
    image.src = url;
  });
}

function fetchSheet(record) {
  // Local files and the running game's decoded Bitmap are two real sources.
  // Promise chaining also turns synchronous host failures into fallback.
  return Promise.resolve()
    .then(function () {
      var url = record.root && RMCH.store.server.iconSetImage(record.root);
      if (!url) throw new Error("no local icon sheet");
      return loadImage(url);
    })
    .catch(function () {
      return RMCH.store
        .send(record.key, "assets.iconset", {})
        .then(function (payload) {
          if (!payload || !payload.dataUrl)
            throw new Error("no bridge icon sheet");
          return loadImage(payload.dataUrl);
        });
    });
}

function scheduleRetry(record) {
  if (
    !record.users ||
    record.retry !== null ||
    games.get(record.key) !== record
  )
    return;
  record.retry = setTimeout(
    function () {
      record.retry = null;
      if (record.users && games.get(record.key) === record) loadSheet(record);
    },
    Math.max(0, record.retryAt - Date.now())
  );
}

function loadSheet(record) {
  if (!record.hasSheet || record.promise || record.state.value === "ready")
    return;
  if (Date.now() < record.retryAt) {
    scheduleRetry(record);
    return;
  }
  record.state.value = "loading";
  record.promise = fetchSheet(record)
    .then(function (image) {
      if (!image.width || !image.height) throw new Error("empty icon sheet");
      record.image = image;
      record.cols = Math.max(1, Math.floor(image.width / record.cell));
      record.state.value = "ready";
    })
    .catch(function () {
      record.state.value = "failed";
      record.retryAt = Date.now() + RETRY_MS;
    })
    .then(function () {
      record.promise = null;
      if (record.state.value === "failed") scheduleRetry(record);
    });
}

function release(record) {
  if (!record) return;
  record.users -= 1;
  if (!record.users && record.retry !== null) {
    clearTimeout(record.retry);
    record.retry = null;
  }
  if (!record.users && record.nameRetry !== null) {
    clearTimeout(record.nameRetry);
    record.nameRetry = null;
  }
}

function tile(record, index) {
  if (record.state.value !== "ready") return null;
  var id = Math.floor(Number(index));
  if (!isFinite(id) || id < 0) return null;
  if (record.tiles.has(id)) return record.tiles.get(id);
  if (record.tiles.size >= CACHE_CAP) return null;
  var cell = record.cell;
  if (!canvas) canvas = document.createElement("canvas");
  canvas.width = cell;
  canvas.height = cell;
  var ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, cell, cell);
  ctx.drawImage(
    record.image,
    (id % record.cols) * cell,
    Math.floor(id / record.cols) * cell,
    cell,
    cell,
    0,
    0,
    cell,
    cell
  );
  var url = canvas.toDataURL("image/png");
  record.tiles.set(id, url);
  return url;
}

function readNamedIcon(record, name) {
  var url = null;
  try {
    if (record.root) url = RMCH.store.server.iconFileImage(record.root, name);
  } catch (_) {}
  record.names.set(name, { url: url, retryAt: Date.now() + RETRY_MS });
  return url;
}

function scheduleNames(record) {
  if (
    !record.users ||
    record.nameRetry !== null ||
    games.get(record.key) !== record
  )
    return;
  var next = Infinity;
  record.names.forEach(function (entry) {
    if (!entry.url) next = Math.min(next, entry.retryAt);
  });
  if (!isFinite(next)) return;
  record.nameRetry = setTimeout(
    function () {
      record.nameRetry = null;
      if (!record.users || games.get(record.key) !== record) return;
      record.names.forEach(function (entry, name) {
        if (!entry.url && entry.retryAt <= Date.now())
          readNamedIcon(record, name);
      });
      record.nameVersion.value += 1;
      scheduleNames(record);
    },
    Math.max(0, next - Date.now())
  );
}

function namedIcon(record, name) {
  if (!name) return null;
  record.nameVersion.value;
  var cached = record.names.get(name);
  if (cached) return cached.url;
  if (record.names.size >= CACHE_CAP) return null;
  var url = readNamedIcon(record, name);
  if (!url) scheduleNames(record);
  return url;
}

function useGame(getKey) {
  var current = Vue.shallowRef(null);
  Vue.watch(
    function () {
      var key = getKey();
      return key ? describeGame(key) : null;
    },
    function (info) {
      if (info && current.value && current.value.identity === info.identity)
        return;
      release(current.value);
      var record = info ? recordFor(info) : null;
      current.value = record;
      if (record) {
        record.users += 1;
        loadSheet(record);
        scheduleNames(record);
      }
    },
    { immediate: true }
  );
  Vue.onScopeDispose(function () {
    release(current.value);
    current.value = null;
  });
  return {
    ready: Vue.computed(function () {
      return !!current.value && current.value.state.value === "ready";
    }),
    loading: Vue.computed(function () {
      return !!current.value && current.value.state.value === "loading";
    }),
    image: function (index, name) {
      var record = current.value;
      if (!record) return null;
      return index != null ? tile(record, index) : namedIcon(record, name);
    }
  };
}

RMCH.iconset = { useGame: useGame };

export default {
  name: "RmGameIcon",
  props: {
    gameKey: { type: String, required: true },
    index: { type: Number, default: null },
    iconName: { type: String, default: null },
    size: { type: Number, default: 22 }
  },
  setup: function (props) {
    var icons = useGame(function () {
      return props.gameKey;
    });
    var src = Vue.computed(function () {
      return icons.image(props.index, props.iconName);
    });
    return function () {
      if (src.value)
        return Vue.h("img", {
          class: "rm-gicon",
          src: src.value,
          width: props.size,
          height: props.size,
          draggable: false,
          alt: ""
        });
      if (props.index != null && icons.loading.value)
        return Vue.h("span", {
          class: "rm-gicon rm-gicon-ph",
          style: { width: props.size + "px", height: props.size + "px" }
        });
      return null;
    };
  }
};
</script>
