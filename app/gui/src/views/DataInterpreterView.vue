<script setup>
import { ref, computed, watch, nextTick, onActivated } from "vue";
import { useEventTools } from "../state/event-tools";
import {
  describeCommand,
  describeConditions,
  raw
} from "../state/event-format";
import {
  confirmExecution,
  executionActive,
  executionLabels
} from "../state/event-execution-ui";
const props = defineProps({
  source: { type: Object, default: null },
  visibleKey: { type: String, default: "event" },
  executable: { type: Boolean, default: false }
});
const tools = useEventTools(props.visibleKey),
  s = tools.state,
  host = window.RMCH.store;
const dialog = host.gameDialog(naive.useDialog()),
  selectedStep = ref(null);
const execution = tools.currentExecution;
const steps = computed(() => s.reader?.execution?.steps || []);
const chosen = computed(() =>
  steps.value.find((step) => step.start === selectedStep.value)
);
const canExecute = computed(
  () =>
    props.executable &&
    s.reader?.source.kind === "common" &&
    !s.stale &&
    tools.connected() &&
    !s.readLoading &&
    !execution.value?.pending &&
    !executionActive(execution.value)
);
const kind = ref("map"),
  id = ref(null),
  query = ref(""),
  viewport = ref(null),
  page = ref(1);
const options = computed(() =>
  kind.value === "running"
    ? s.running.map((r) => ({
        label: r.name + " · 第 " + (r.index + 1) + " 条",
        value: r.id
      }))
    : (kind.value === "common" ? s.common : s.map?.events || []).map((r) => ({
        label: "#" + (r.id ?? r.eventId) + " " + r.name,
        value: r.id ?? r.eventId
      }))
);
const engine = computed(() => host.trainer.live?.engine?.maker || "");
const commands = computed(() =>
  (s.reader?.commands || [])
    .map((command, index) => ({
      ...command,
      index,
      ...describeCommand(command, engine.value)
    }))
    .filter((row) => row.text.toLowerCase().includes(query.value.toLowerCase()))
);
const visibleCommands = computed(() =>
  commands.value.slice((page.value - 1) * 100, page.value * 100)
);
const conditions = computed(() =>
  describeConditions(s.reader?.conditions, s.reader?.values)
);
async function read() {
  if (id.value == null) return;
  page.value = 1;
  query.value = "";
  await tools.read(
    kind.value === "running"
      ? { kind: "running", runId: id.value }
      : { kind: kind.value, id: id.value }
  );
  if (s.reader?.source.kind === "running") await locate();
}
function reread() {
  if (!s.reader) return;
  if (
    s.reader.mapToken !== s.map?.mapToken &&
    s.reader.source.kind !== "common"
  ) {
    s.readError = "来源地图已改变，请从列表重新选择事件";
    return;
  }
  page.value = 1;
  tools.read({ ...s.reader.source });
}
async function locate() {
  const index = s.reader?.index;
  if (index == null) return;
  while (
    s.reader &&
    s.reader.commands.length <= index &&
    s.reader.commands.length < s.reader.total &&
    !s.stale
  ) {
    const count = s.reader.commands.length;
    await tools.read(null, true);
    if (s.reader.commands.length <= count) break;
  }
  query.value = "";
  page.value = Math.floor(index / 100) + 1;
  await nextTick();
  viewport.value
    ?.querySelector('[data-current="true"]')
    ?.scrollIntoView({ block: "center", behavior: "smooth" });
}
watch(kind, (value) => {
  id.value = null;
  if (value === "common") tools.common();
});
watch(query, () => {
  page.value = 1;
});
watch(
  () => s.reader?.source,
  () => {
    if (s.reader) {
      kind.value = s.reader.source.kind;
      nextTick(() => {
        id.value = s.reader.source.runId ?? s.reader.source.id;
      });
    }
  }
);
watch(
  () => host.trainer.gameKey,
  () => {
    id.value = null;
    query.value = "";
    page.value = 1;
  }
);
watch(
  () => props.source,
  (source) => {
    if (source) {
      kind.value = source.kind;
      id.value = source.id;
      selectedStep.value = null;
      query.value = "";
      page.value = 1;
      const same =
        s.reader?.source.kind === source.kind &&
        s.reader?.source.id === source.id &&
        (!source.mapToken || source.mapToken === s.reader.mapToken);
      if (!same) tools.read(source);
    }
  },
  { immediate: true, deep: true }
);
function restoreSource() {
  if (props.source) {
    kind.value = props.source.kind;
    id.value = props.source.id;
    tools.read(props.source);
  }
}
function restoreVisible() {
  if (
    props.source &&
    host.data.tab === props.visibleKey &&
    (s.reader?.source.kind !== props.source.kind ||
      s.reader?.source.id !== props.source.id)
  )
    restoreSource();
}
watch(() => host.data.tab, restoreVisible);
onActivated(restoreVisible);
function runStep() {
  return confirmExecution(tools, chosen.value, false, dialog, host);
}
</script>
<template>
  <n-flex vertical :size="14">
    <n-card
      size="small"
      :title="executable ? '事件解释器' : '事件解释器 · 只读'"
    >
      <p class="rm-event-hint">
        {{
          executable
            ? "选中完整步骤后点击执行；结构内部的行仅供阅读。"
            : "查看事件各页及当前执行指令，此入口只读。"
        }}
        正文保留读取快照。
      </p>
      <n-flex :size="8" align="center">
        <n-button size="small" @click="restoreSource">查看选中事件</n-button>
        <n-button
          size="small"
          @click="
            kind = 'running';
            id = null;
          "
          >查看执行中事件</n-button
        >
        <n-select
          v-if="kind === 'running'"
          v-model:value="id"
          filterable
          :options="
            s.running.map((r) => ({
              label: r.name + ' · 第 ' + (r.index + 1) + ' 条',
              value: r.id
            }))
          "
          placeholder="选择执行中事件"
          style="flex: 1; min-width: 180px"
        />
        <n-button
          v-if="kind === 'running'"
          size="small"
          :disabled="id == null || !tools.connected()"
          @click="read"
          >读取</n-button
        >
      </n-flex>
      <n-flex v-if="!source" :size="8">
        <n-select
          v-model:value="id"
          filterable
          :options="options"
          placeholder="选择要阅读的事件"
          style="flex: 1; min-width: 180px"
        />
        <n-button
          type="primary"
          :loading="s.readLoading"
          :disabled="id == null || !tools.connected() || !!s.error"
          @click="read"
          >读取指令</n-button
        >
        <n-button
          :disabled="!tools.connected()"
          @click="kind === 'common' ? tools.common() : tools.refresh()"
          >刷新列表</n-button
        >
      </n-flex>
      <p v-if="kind === 'running' && !s.running.length" class="rm-event-hint">
        {{
          s.runningError ||
          "未识别到执行中事件；游戏可能正空闲，或自定义解释器无法识别。"
        }}
      </p>
      <n-alert
        v-if="s.readError || s.error || !tools.connected()"
        type="warning"
        :show-icon="false"
        >{{
          !tools.connected()
            ? "游戏已断开；保留阅读快照，停止刷新"
            : s.readError || s.error
        }}</n-alert
      >
    </n-card>
    <n-alert
      v-if="execution?.id"
      :type="execution.state === 'failed' ? 'warning' : 'info'"
      :show-icon="false"
    >
      <n-flex align="center" :size="8">
        <strong
          >公共事件 #{{ execution.eventId }} · {{ execution.name }}：{{
            !tools.connected() || execution.unknown
              ? "连接状态待核实"
              : executionLabels[execution.state]
          }}</strong
        >
        <span v-if="execution.index != null"
          >指令 #{{ execution.index + 1
          }}{{
            execution.commandEventId !== execution.eventId
              ? "（子事件 #" + execution.commandEventId + "）"
              : ""
          }}</span
        >
        <n-button
          v-if="executable && executionActive(execution)"
          size="small"
          :disabled="
            !tools.connected() ||
            execution.unknown ||
            execution.pending ||
            execution.stopRequested
          "
          @click="tools.stopExecution"
          >停止后续指令</n-button
        >
      </n-flex>
      <p v-if="execution.reason">{{ execution.reason }}</p>
      <p class="rm-event-hint">关闭面板不会取消执行；停止不回滚已有改动。</p>
    </n-alert>
    <n-card v-if="s.reader" size="small" :title="s.reader.name || '事件指令'">
      <template #header-extra
        ><n-button
          size="small"
          :loading="s.readLoading"
          :disabled="!tools.connected()"
          @click="reread"
          >重读快照</n-button
        ></template
      >
      <p class="rm-event-hint">
        {{ s.reader.game }} · 来源地图 #{{ s.reader.mapId }} ·
        {{
          s.reader.source.kind === "map"
            ? "事件 #" +
              s.reader.source.id +
              " / 第 " +
              (s.reader.source.pageIndex + 1) +
              " 页"
            : s.reader.source.kind === "common"
              ? "公共事件 #" + s.reader.source.id
              : "执行中事件"
        }}
        · {{ s.reader.captured }} 读取
      </p>
      <n-alert v-if="s.stale" type="warning" :show-icon="false"
        >内容已过期：{{ s.stale }}。正文保持不变，重读才会更新。</n-alert
      >
      <n-alert
        v-if="executable && s.reader.executionError"
        type="warning"
        :show-icon="false"
        >{{ s.reader.executionError }}</n-alert
      >
      <n-flex
        v-if="executable && s.reader.source.kind === 'common'"
        align="center"
        :size="8"
        style="margin: 12px 0"
      >
        <n-select
          v-model:value="selectedStep"
          filterable
          placeholder="选择完整步骤"
          style="flex: 1; min-width: 180px"
          :options="
            steps.map((step) => ({
              value: step.start,
              label:
                '#' +
                (step.start + 1) +
                '–' +
                step.end +
                ' ' +
                describeCommand({ code: step.code, parameters: [] }, engine)
                  .name +
                (step.reason ? ' · 不可执行' : '')
            }))
          "
        />
        <n-button
          type="primary"
          :disabled="!canExecute || !chosen || !!chosen.reason"
          :loading="!!execution?.pending"
          @click="runStep"
          >执行这一步</n-button
        >
        <span v-if="chosen?.reason" class="rm-event-hint">{{
          chosen.reason
        }}</span>
      </n-flex>
      <n-flex v-if="s.reader.pages.length" :size="6" style="margin: 10px 0">
        <n-button
          v-for="p in s.reader.pages"
          :key="p.index"
          size="small"
          :type="s.reader.source.pageIndex === p.index ? 'primary' : 'default'"
          :disabled="!tools.connected() || !!s.stale"
          @click="
            page = 1;
            tools.read({ ...s.reader.source, pageIndex: p.index });
          "
          >第 {{ p.index + 1 }} 页{{ p.active ? " · 生效" : "" }}</n-button
        >
      </n-flex>
      <div v-if="s.reader.pages.length" class="rm-event-conditions">
        <strong>本页条件（读取时）</strong>
        <p v-for="line in conditions" :key="line">{{ line }}</p>
      </div>
      <n-flex align="center" :size="8" style="margin: 12px 0">
        <n-input
          v-model:value="query"
          clearable
          placeholder="搜索已读取指令、编号或原始参数"
          style="flex: 1; min-width: 180px"
        />
        <n-button
          v-if="s.reader.index != null"
          size="small"
          :disabled="!!s.stale"
          @click="locate"
          >定位当前指令 #{{ s.reader.index + 1 }}</n-button
        >
        <span class="rm-event-hint"
          >已读 {{ s.reader.commands.length }} / {{ s.reader.total }} · 匹配
          {{ commands.length }}</span
        >
      </n-flex>
      <div ref="viewport" class="rm-event-commands">
        <article
          v-for="row in visibleCommands"
          :key="row.index"
          class="rm-event-command"
          :data-current="row.index === s.reader.index"
          :style="{ paddingLeft: 12 + Math.min(12, row.indent) * 16 + 'px' }"
        >
          <div>
            <span class="rm-event-index">{{ row.index + 1 }}</span
            ><strong>{{ row.name }}</strong>
            <span class="rm-event-hint">[{{ row.code }}]</span
            ><n-tag
              v-if="row.index === s.reader.index"
              size="small"
              type="info"
              >{{ s.stale ? "上次执行位置" : "当前执行" }}</n-tag
            >
            <n-button
              v-if="
                executable && steps.some((step) => step.start === row.index)
              "
              size="tiny"
              quaternary
              @click="selectedStep = row.index"
              >{{
                selectedStep === row.index ? "已选步骤" : "选择步骤"
              }}</n-button
            >
          </div>
          <pre v-if="row.detail">{{ row.detail }}</pre>
          <details>
            <summary>原始参数</summary>
            <pre>{{ raw(row.parameters) }}</pre>
          </details>
        </article>
        <p v-if="!commands.length" class="rm-event-hint">
          没有匹配的已读取指令。
        </p>
      </div>
      <n-flex align="center" justify="space-between" style="margin-top: 12px">
        <n-pagination
          v-model:page="page"
          :page-count="Math.max(1, Math.ceil(commands.length / 100))"
          :page-slot="5"
        />
        <n-button
          v-if="s.reader.commands.length < s.reader.total"
          size="small"
          :loading="s.readLoading"
          :disabled="!!s.stale || !tools.connected()"
          @click="tools.read(null, true)"
          >继续读取 300 条</n-button
        >
      </n-flex>
    </n-card>
    <n-empty
      v-else
      description="选择事件后开始阅读，也可从地图事件的「指令」按钮进入"
    />
  </n-flex>
</template>
