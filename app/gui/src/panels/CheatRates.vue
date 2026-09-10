<script>
import Component_RmIcon from "../shell/RmIcon.vue";

import {
  RMCH,
  store,
  trainer,
  h,
  ref,
  computed,
  NButton,
  NInputNumber,
  NFlex,
  BOOL_OPTIONS,
  NUM_OPTIONS,
  QUICK_ACTIONS
} from "./trainer-cheats-context.js";

export default {
  name: "CheatRates",
  components: { RmIcon: Component_RmIcon },
  setup: function () {
    var drafts = store.useDraft("trainer.rates", {});
    var pending = ref(false);
    function push(key, value) {
      drafts.value[key] = value;
    }
    function apply() {
      if (pending.value) return;
      var patch = {};
      NUM_OPTIONS.forEach(function (opt) {
        if (drafts.value[opt[0]] != null)
          patch[opt[0]] = Math.max(opt[2], Number(drafts.value[opt[0]]) || 0);
      });
      if (!Object.keys(patch).length) return;
      pending.value = true;
      store
        .setOptions(patch)
        .then(function (payload) {
          if (payload) store.ok("倍率与数值已应用");
        })
        .finally(function () {
          pending.value = false;
        });
    }
    return {
      trainer: trainer,
      drafts: drafts,
      pending: pending,
      options: NUM_OPTIONS,
      push: push,
      apply: apply
    };
  },
  render: function () {
    var self = this;
    return h(
      naive.NCard,
      { size: "small", title: "倍率与数值" },
      {
        "header-extra": function () {
          return h(Component_RmIcon, { name: "wand" });
        },
        footer: function () {
          return h(
            NFlex,
            { align: "center", justify: "space-between" },
            {
              default: function () {
                return [
                  h(
                    naive.NText,
                    { depth: 3, style: "font-size:12px" },
                    {
                      default: function () {
                        return "编辑后应用 · 不会自动提交";
                      }
                    }
                  ),
                  h(
                    NButton,
                    {
                      size: "small",
                      type: "primary",
                      loading: self.pending,
                      onClick: self.apply
                    },
                    {
                      default: function () {
                        return "应用数值";
                      }
                    }
                  )
                ];
              }
            }
          );
        },
        default: function () {
          return h(
            "div",
            { class: "rm-pairs rm-pairs-wide" },
            NUM_OPTIONS.map(function (opt) {
              var label = h("span", null, opt[1]);
              if (opt[4]) {
                label = h(
                  naive.NTooltip,
                  { trigger: "hover", delay: 400 },
                  {
                    trigger: function () {
                      return h("span", { class: "rm-tip-label" }, opt[1]);
                    },
                    default: function () {
                      return opt[4];
                    }
                  }
                );
              }
              return h("label", { class: "rm-pair", key: opt[0] }, [
                label,
                h(NInputNumber, {
                  size: "small",
                  value:
                    self.drafts[opt[0]] === undefined
                      ? self.trainer.options[opt[0]]
                      : self.drafts[opt[0]],
                  min: opt[2],
                  step: opt[3],
                  showButton: false,
                  placeholder: "-",
                  style: { width: "84px", flex: "none" },
                  title:
                    "当前实际值：" +
                    (self.trainer.options[opt[0]] == null
                      ? "未知"
                      : self.trainer.options[opt[0]]),
                  onKeyup: function (event) {
                    if (event.key === "Enter") self.apply();
                  },
                  "onUpdate:value": function (value) {
                    self.push(opt[0], value);
                  }
                })
              ]);
            })
          );
        }
      }
    );
  }
};
</script>
