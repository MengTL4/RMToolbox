// Fixed-row-height windowed list.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.parts = RMCH.parts || {};

  var h = Vue.h;
  var ref = Vue.ref;
  var computed = Vue.computed;
  // Fixed-row-height windowed list. naive-ui 2.35 does not export NVirtualList
  // (it became public in 2.36), and the save-data tree can put tens of thousands
  // of rows on screen, so this renders only the visible slice.
  RMCH.parts.Virtual = {
    name: "RmVirtual",
    props: {
      items: { type: Array, required: true },
      itemSize: { type: Number, default: 30 },
      height: { type: Number, default: 400 },
      overscan: { type: Number, default: 6 },
      keyField: { type: String, default: null }
    },
    setup: function (props, ctx) {
      var scrollTop = ref(0);

      var total = computed(function () { return props.items.length * props.itemSize; });

      var window_ = computed(function () {
        var first = Math.floor(scrollTop.value / props.itemSize) - props.overscan;
        if (first < 0) first = 0;
        var visible = Math.ceil(props.height / props.itemSize) + props.overscan * 2;
        var last = Math.min(props.items.length, first + visible);
        return { first: first, last: last };
      });

      var slice = computed(function () {
        return props.items.slice(window_.value.first, window_.value.last);
      });

      return function () {
        return h("div", {
          style: { height: props.height + "px", overflow: "auto", position: "relative" },
          onScroll: function (event) { scrollTop.value = event.target.scrollTop; }
        }, [
          h("div", { style: { height: total.value + "px", position: "relative" } },
            slice.value.map(function (item, index) {
              var absolute = window_.value.first + index;
              return h("div", {
                key: props.keyField ? item[props.keyField] : absolute,
                style: {
                  position: "absolute",
                  top: (absolute * props.itemSize) + "px",
                  left: 0,
                  right: 0,
                  height: props.itemSize + "px"
                }
              }, ctx.slots.default ? ctx.slots.default({ item: item, index: absolute }) : []);
            }))
        ]);
      };
    }
  };
})();
