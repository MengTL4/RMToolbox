// jsoneditor (josdejong) wrapper — the 存档数据 editor.
//
// MTool's 数据修改 is this exact library in tree mode with the zh-CN locale, so
// the option set below is deliberately MTool's: 树/表单/视图/代码/文本/预览 mode
// switcher, per-row action menu (Ctrl+M), drag-to-move, sort, transform
// (JMESPath), undo/redo, search with ‹ ›. Anything we add on top of it goes into
// the #menu slot, which gets teleported into the editor's own menu bar — the
// same trick MTool uses (#jsoneditor-search-updateDataB).
//
// The editor instance is a plain closure variable on purpose: handing a 3 MB
// document's worth of Node objects to Vue's reactive proxy would be a disaster.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  var ref = Vue.ref;
  var watch = Vue.watch;

  RMCH.parts.JsonEditor = {
    name: "RmJsonEditor",
    props: {
      json: { type: String, default: null },
      height: { type: Number, default: 420 },
      readonly: { type: Boolean, default: false }
    },
    emits: ["dirty"],
    setup: function (props, ctx) {
      var host = ref(null);        // the div JSONEditor takes over
      var menuEl = ref(null);      // .jsoneditor-menu — teleport target for #menu
      var editor = null;
      var dirty = ref(false);
      // Undoing back to the source has to clear the dirty tag (and with it the
      // 「放弃未应用的修改？」 guard on 更新数据), but jsoneditor's onChange has no
      // "is pristine" signal — compare the document against the source instead.
      // Debounced: a burst of edits costs at most one serialisation.
      var dirtyTimer = null;
      // The text last pushed into (or read out of) the editor. Used to ignore the
      // prop echo after 应用至游戏 — re-running setText there would collapse the
      // whole tree just as the user finished working in it.
      var lastText = null;

      function markDirty(next) {
        if (dirty.value === next) return;
        dirty.value = next;
        ctx.emit("dirty", next);
      }

      // The menu bar is rebuilt from scratch on every mode switch, so the
      // teleport target has to be re-resolved or our buttons stay detached.
      function syncMenu() {
        menuEl.value = host.value ? host.value.querySelector(".jsoneditor-menu") : null;
      }

      function options() {
        var opts = {
          mode: "tree",
          modes: ["tree", "form", "view", "code", "text", "preview"],
          language: "zh-CN",
          mainMenuBar: true,
          navigationBar: true,
          statusBar: true,
          search: true,
          history: true,
          enableSort: true,
          enableTransform: true,
          limitDragging: false,
          sortObjectKeys: false,      // key order is part of the save's shape
          escapeUnicode: false,       // 存档里全是中文，转义了没法读
          maxVisibleChilds: 100,      // wide arrays paginate with 「显示更多」
          onChange: function () {
            markDirty(true);
            clearTimeout(dirtyTimer);
            dirtyTimer = setTimeout(function () {
              if (!editor || lastText === null) return;
              try { markDirty(editor.getText() !== lastText); } catch (_) {}
            }, 400);
          },
          onModeChange: function () { Vue.nextTick(syncMenu); },
          onError: function (error) {
            RMCH.store.fail("编辑器错误：" + (error && error.message ? error.message : error));
          }
        };
        if (props.readonly) opts.onEditable = function () { return false; };
        return opts;
      }

      // Load is synchronous and O(values) — jsoneditor builds a Node per value
      // (only the DOM is lazy), so log the real cost instead of guessing at it.
      function load(text) {
        if (!editor) return;
        clearTimeout(dirtyTimer);
        if (!text) {
          lastText = null;
          editor.set({});
          markDirty(false);
          return;
        }
        var started = Date.now();
        try {
          editor.setText(text);
          lastText = text;
          markDirty(false);
          RMCH.store.log("[存档树] 载入 " + Math.round(text.length / 1024) + " KB，"
            + (Date.now() - started) + " ms");
        } catch (error) {
          RMCH.store.fail("存档数据不是合法 JSON：" + error.message);
        }
      }

      Vue.onMounted(function () {
        if (!window.JSONEditor) {
          return RMCH.store.fail("vendor/jsoneditor 未加载，存档数据页不可用");
        }
        editor = new window.JSONEditor(host.value, options());
        syncMenu();
        if (props.json) load(props.json);
      });

      Vue.onBeforeUnmount(function () {
        clearTimeout(dirtyTimer);
        if (!editor) return;
        editor.destroy();     // leaks the whole Node tree otherwise
        editor = null;
        menuEl.value = null;
      });

      watch(function () { return props.json; }, function (next) {
        if (next === lastText) return;      // echo of our own 应用至游戏
        load(next);
      });

      return {
        host: host,
        menuEl: menuEl,
        dirty: dirty,
        // Re-read the source even when the text did not change — 「重新拉取」 has
        // to discard local edits, and a game that handed back byte-identical
        // JSON would otherwise leave them sitting in the tree.
        reload: function (text) {
          var next = text === undefined ? props.json : text;
          if (next === lastText && !dirty.value) return;
          load(next);
        },
        // Read the document only when someone actually needs it: getText()
        // re-serialises the entire tree.
        getText: function () {
          if (!editor) return null;
          lastText = editor.getText();
          return lastText;
        },
        setPristine: function () { markDirty(false); }
      };
    },
    template: [
      '<div class="rm-je" :style="{ height: height + \'px\' }">',
      '  <div ref="host" class="rm-je-host"></div>',
      '  <teleport v-if="menuEl" :to="menuEl">',
      '    <div class="rm-je-actions"><slot name="menu"/></div>',
      '  </teleport>',
      '</div>'
    ].join("\n")
  };
})();
