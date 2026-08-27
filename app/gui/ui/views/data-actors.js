// 数据 › 角色 — master-detail actor editor. The list checkbox is the party
// toggle (MTool's 在队伍中 column); 技能 / 状态 open searchable picker overlays.

(function () {
  "use strict";

  var RMCH = (window.RMCH = window.RMCH || {});
  RMCH.views = RMCH.views || {};

  var store = RMCH.store;
  var data = store.data;
  var trainer = store.trainer;
  var ref = Vue.ref;
  var computed = Vue.computed;
  var watch = Vue.watch;

  var PARAM_NAMES = ["最大HP", "最大MP", "攻击", "防御", "魔攻", "魔防", "敏捷", "幸运"];

  RMCH.views.DataActors = {
    name: "DataActorsView",
    components: {
      RmIcon: RMCH.Icon,
      RmEntryList: RMCH.parts.EntryList,
      RmPicker: RMCH.parts.Picker
    },
    setup: function () {
      var form = ref({ name: "", nickname: "", level: 1, exp: 0, hp: 0, mp: 0, tp: 0 });
      var paramDrafts = ref([0, 0, 0, 0, 0, 0, 0, 0]);
      var picker = ref(null);              // "skill" | "state" | null
      var pickerBusy = ref(false);
      var skills = ref([]);
      var states = ref([]);

      var actor = computed(function () { return trainer.actor; });
      var selectedId = computed(function () { return data.selected.actor; });

      var inParty = computed(function () {
        if (!actor.value) return false;
        return trainer.party.some(function (member) { return member.id === actor.value.id; });
      });

      // Reset the form whenever a different actor (or refreshed data) arrives.
      watch(actor, function (next) {
        if (!next) return;
        form.value = {
          name: next.name || "",
          nickname: next.nickname || "",
          level: next.level,
          exp: 0,
          hp: next.hp,
          mp: next.mp,
          tp: next.tp == null ? 0 : next.tp
        };
        paramDrafts.value = [0, 0, 0, 0, 0, 0, 0, 0];
      }, { immediate: true });

      function select(row) {
        data.selected.actor = row.id;
        store.openActor(row.id);
      }

      function toggleParty(row, enabled) {
        store.cmd(enabled ? "party.addActor" : "party.removeActor", { id: row.id })
          .then(function (payload) {
            if (!payload) return;
            store.ok("#" + row.id + " " + (row.name || "") + (enabled ? " 已入队" : " 已离队"));
            store.refreshParty();
          });
      }

      function apply(type, args, label) {
        return store.cmd(type, Object.assign({ id: actor.value.id }, args)).then(function (payload) {
          store.applyActor(payload);
          store.refreshParty();
          if (payload) store.ok(label + " 已应用");
          return payload;
        });
      }

      function applyName() {
        return store.cmd("actor.name.set", { id: actor.value.id, name: form.value.name })
          .then(function (payload) {
            store.applyActor(payload);
            return store.cmd("actor.nickname.set", { id: actor.value.id, nickname: form.value.nickname });
          })
          .then(function (payload) {
            store.applyActor(payload);
            store.refreshParty();
            if (payload) store.ok("名称 / 昵称已应用");
          });
      }

      function applyParam(index) {
        var value = Number(paramDrafts.value[index]) || 0;
        if (!value) return store.warn("加值为 0，没什么可应用的");
        return apply("actor.param.add", { paramId: index, value: value }, PARAM_NAMES[index]);
      }

      function bumpParam(index, step) {
        var next = (Number(paramDrafts.value[index]) || 0) + step;
        paramDrafts.value = paramDrafts.value.map(function (v, i) { return i === index ? next : v; });
      }

      // --- pickers -------------------------------------------------------------

      function openPicker(kind) {
        picker.value = kind;
        var target = kind === "skill" ? skills : states;
        if (target.value.length) return;
        pickerBusy.value = true;
        store.cmd("catalog.query", { kind: kind, limit: 20000 })
          .then(function (payload) {
            if (payload) target.value = payload.entries || [];
          })
          .finally(function () { pickerBusy.value = false; });
      }

      function togglePickerEntry(entry, enabled) {
        if (!actor.value) return;
        pickerBusy.value = true;
        var type = picker.value === "skill"
          ? (enabled ? "actor.skill.learn" : "actor.skill.forget")
          : (enabled ? "actor.state.add" : "actor.state.remove");
        var args = picker.value === "skill" ? { skillId: entry.id } : { stateId: entry.id };
        store.cmd(type, Object.assign({ id: actor.value.id }, args))
          .then(function (payload) { store.applyActor(payload); })
          .finally(function () { pickerBusy.value = false; });
      }

      var pickerEntries = computed(function () {
        return picker.value === "skill" ? skills.value : states.value;
      });

      var ownedIds = computed(function () {
        if (!actor.value) return [];
        var list = picker.value === "skill" ? (actor.value.skills || []) : (actor.value.states || []);
        return list.map(function (entry) { return entry.id; });
      });

      // MTool's "选中已拥有的": jump the list to what the actor already has.
      var ownedOnly = ref(false);
      var visibleEntries = computed(function () {
        if (!ownedOnly.value) return pickerEntries.value;
        var owned = Object.create(null);
        ownedIds.value.forEach(function (id) { owned[id] = true; });
        return pickerEntries.value.filter(function (entry) { return owned[entry.id]; });
      });

      var rosterEntries = computed(function () {
        var inPartyIds = Object.create(null);
        trainer.party.forEach(function (member) { inPartyIds[member.id] = true; });
        return trainer.roster.map(function (entry) {
          return { id: entry.id, name: entry.name, inParty: !!inPartyIds[entry.id] };
        });
      });

      var listHeight = computed(function () { return Math.max(240, store.viewport.height - 340); });

      return {
        store: store,
        data: data,
        trainer: trainer,
        actor: actor,
        selectedId: selectedId,
        inParty: inParty,
        form: form,
        paramNames: PARAM_NAMES,
        paramDrafts: paramDrafts,
        rosterEntries: rosterEntries,
        listHeight: listHeight,
        picker: picker,
        pickerBusy: pickerBusy,
        visibleEntries: visibleEntries,
        ownedIds: ownedIds,
        ownedOnly: ownedOnly,
        select: select,
        toggleParty: toggleParty,
        apply: apply,
        applyName: applyName,
        applyParam: applyParam,
        bumpParam: bumpParam,
        openPicker: openPicker,
        togglePickerEntry: togglePickerEntry,
        closePicker: function () { picker.value = null; ownedOnly.value = false; },
        isInParty: function (row) { return row.inParty; },
        partyMark: function (row) { return row.inParty ? "在队" : ""; },
        queryOf: computed(function () { return data.query.actor; })
      };
    },
    template: [
      '<div class="rm-md">',
      '  <n-card class="rm-md-list" size="small" title="角色列表">',
      '    <template #header-extra>',
      '      <n-flex align="center" :size="8">',
      '        <n-text depth="3" style="font-size: 12px">在队 {{ trainer.party.length }}</n-text>',
      '        <n-button size="tiny" quaternary :loading="trainer.loading.roster"',
      '                  @click="store.loadRoster(); store.refreshParty()">',
      '          <template #icon><rm-icon name="refresh" :size="14"/></template>',
      '        </n-button>',
      '      </n-flex>',
      '    </template>',
      '    <rm-entry-list :entries="rosterEntries" :selected-id="selectedId" :query="queryOf"',
      '                   check-label="在队伍中" :checked="isInParty"',
      '                   value-label="" :value-of="partyMark"',
      '                   :height="listHeight" :loading="trainer.loading.roster"',
      '                   empty-text="等待游戏数据加载…"',
      '                   @update:query="v => data.query.actor = v"',
      '                   @select="select" @toggle="toggleParty"/>',
      '  </n-card>',

      '  <n-card class="rm-md-detail" size="small"',
      '          :title="actor ? \'#\' + actor.id + \' \' + actor.name : \'角色详情\'">',
      '    <template #header-extra>',
      // Actions live in the card header: the forms + param grid push the old
      // bottom button row out of view, and 技能/状态 are the most-used ones.
      '      <n-flex v-if="actor" align="center" :size="6" :wrap="false">',
      '        <n-button size="tiny" secondary type="primary" @click="openPicker(\'skill\')">',
      '          技能 {{ (actor.skills || []).length }}',
      '        </n-button>',
      '        <n-button size="tiny" secondary @click="openPicker(\'state\')">',
      '          状态 {{ (actor.states || []).length }}',
      '        </n-button>',
      '        <n-button size="tiny" tertiary @click="apply(\'actor.recover\', {}, \'全恢复\')">全恢复</n-button>',
      '        <n-button v-if="!inParty" size="tiny" type="primary"',
      '                  @click="toggleParty({ id: actor.id, name: actor.name }, true)">入队</n-button>',
      '        <n-button v-else size="tiny" type="error" secondary',
      '                  @click="toggleParty({ id: actor.id, name: actor.name }, false)">离队</n-button>',
      '        <n-tag size="small" :bordered="false" :type="inParty ? \'success\' : \'default\'">',
      '          {{ inParty ? "在队" : "未入队" }}',
      '        </n-tag>',
      '      </n-flex>',
      '    </template>',
      '    <n-empty v-if="!actor" description="在左边点一个角色" style="padding: 40px 0"/>',
      '    <n-flex v-else vertical :size="14">',
      '      <n-descriptions :column="3" size="small" bordered label-placement="top">',
      '        <n-descriptions-item label="职业">{{ actor.className || actor.classId || "-" }}</n-descriptions-item>',
      '        <n-descriptions-item label="等级">{{ actor.level }} / {{ actor.maxLevel == null ? "?" : actor.maxLevel }}</n-descriptions-item>',
      '        <n-descriptions-item label="经验">{{ actor.exp == null ? "-" : actor.exp }}{{ actor.nextLevelExp == null ? "" : " / " + actor.nextLevelExp }}</n-descriptions-item>',
      '        <n-descriptions-item label="HP">{{ actor.hp }} / {{ actor.mhp }}</n-descriptions-item>',
      '        <n-descriptions-item label="MP">{{ actor.mp }} / {{ actor.mmp }}</n-descriptions-item>',
      '        <n-descriptions-item label="TP">{{ actor.tp == null ? "-" : actor.tp }}{{ actor.maxTp == null ? "" : " / " + actor.maxTp }}</n-descriptions-item>',
      '      </n-descriptions>',

      '      <n-form label-placement="top" size="small" :show-feedback="false">',
      '        <n-flex vertical :size="12">',
      '          <n-form-item label="名称 / 昵称">',
      '            <n-flex :size="6" :wrap="false" style="width: 100%">',
      '              <n-input v-model:value="form.name" placeholder="名称" style="flex: 1"/>',
      '              <n-input v-model:value="form.nickname" placeholder="昵称" style="flex: 1"/>',
      '              <n-button type="primary" @click="applyName">应用</n-button>',
      '            </n-flex>',
      '          </n-form-item>',
      '          <n-form-item label="等级 / 追加经验">',
      '            <n-flex :size="6" :wrap="false" style="width: 100%">',
      '              <n-input-number v-model:value="form.level" :min="1" :show-button="false" style="flex: 1"/>',
      '              <n-input-number v-model:value="form.exp" :min="0" :show-button="false" style="flex: 1" placeholder="经验 +"/>',
      '              <n-button type="primary"',
      '                        @click="apply(\'actor.level.set\', { level: form.level }, \'等级\').then(() => form.exp > 0 && apply(\'actor.exp.add\', { amount: form.exp }, \'经验\'))">',
      '                应用',
      '              </n-button>',
      '            </n-flex>',
      '          </n-form-item>',
      '          <n-form-item label="HP / MP / TP">',
      '            <n-flex :size="6" :wrap="false" style="width: 100%">',
      '              <n-input-number v-model:value="form.hp" :show-button="false" style="flex: 1"/>',
      '              <n-input-number v-model:value="form.mp" :show-button="false" style="flex: 1"/>',
      '              <n-input-number v-model:value="form.tp" :show-button="false" style="flex: 1"/>',
      '              <n-button type="primary"',
      '                        @click="apply(\'actor.vitals.set\', { hp: form.hp, mp: form.mp, tp: form.tp }, \'HP/MP/TP\')">',
      '                应用',
      '              </n-button>',
      '            </n-flex>',
      '          </n-form-item>',
      '        </n-flex>',
      '      </n-form>',

      '      <div>',
      '        <n-text depth="3" style="font-size: 12px">属性加值（当前值 → 加多少）</n-text>',
      '        <div class="rm-params">',
      '          <div v-for="(name, index) in paramNames" :key="name" class="rm-param-row">',
      '            <span class="rm-param-name">{{ name }}</span>',
      '            <span class="rm-param-cur">{{ actor.params ? actor.params[index] : "-" }}</span>',
      '            <n-input-number :value="paramDrafts[index]" size="tiny" :show-button="false"',
      '                            style="width: 72px"',
      '                            @update:value="v => paramDrafts = paramDrafts.map((x, i) => i === index ? v : x)"/>',
      '            <n-button-group size="tiny">',
      '              <n-button @click="bumpParam(index, -100)">-100</n-button>',
      '              <n-button @click="bumpParam(index, -1)">-1</n-button>',
      '              <n-button @click="bumpParam(index, 1)">+1</n-button>',
      '              <n-button @click="bumpParam(index, 100)">+100</n-button>',
      '            </n-button-group>',
      '            <n-button size="tiny" type="primary" @click="applyParam(index)">应用</n-button>',
      '          </div>',
      '        </div>',
      '      </div>',
      '    </n-flex>',
      '  </n-card>',

      '  <rm-picker :show="!!picker" :title="picker === \'skill\' ? \'技能\' : \'状态\'"',
      '             :entries="visibleEntries" :owned-ids="ownedIds" :busy="pickerBusy"',
      '             :game-key="store.trainer.gameKey"',
      '             @update:show="v => { if (!v) closePicker() }"',
      '             @toggle="togglePickerEntry" @select-owned="ownedOnly = !ownedOnly"/>',
      '</div>'
    ].join("\n")
  };
})();
