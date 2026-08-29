// Pre-flight check for the NW.js GUI page scripts.
//
// The GUI only runs inside NW.js, where a bad template shows up as a blank
// window. This loads every ui/*.js file in a vm sandbox (real Vue from the
// vendored bundle, stubs for naive-ui and the Node glue) and then compiles each
// component template with Vue's own compiler — so template typos fail here
// instead of at runtime.
//
//   node tools/gui-check.mjs

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { MODULES as GUI_BUNDLED_MODULES } from "../core/gui-bundler.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guiDir = path.join(projectRoot, "app", "gui");

// The GUI's embedded Node is 16.1 (NW 0.54), older than the dev machine's.
// Node APIs younger than that in a bundled core module only blow up when a
// user clicks the button (cpSync broke shadow launches), so check up front.
const TOO_NEW_NODE_APIS = [
  [/\bcpSync\b/, "fs.cpSync (Node 16.7+, GUI 是 16.1)"],
];
for (const mod of [...GUI_BUNDLED_MODULES, "app/gui/host.cjs"]) {
  const source = readFileSync(path.join(projectRoot, mod), "utf8");
  for (const [pattern, label] of TOO_NEW_NODE_APIS) {
    if (pattern.test(source)) fail(`${mod} 使用了 ${label}`);
  }
}

// Load order comes from app/gui/index.html itself, so the two cannot drift.
const indexHtml = readFileSync(path.join(guiDir, "index.html"), "utf8");
const PAGE_SCRIPTS = [...indexHtml.matchAll(/<script src="([^"]+)"><\/script>/g)]
  .map((match) => match[1])
  .filter((src) => src.startsWith("ui/"));
const SCRIPTS = PAGE_SCRIPTS.filter((src) => src !== "ui/main.js");
if (!SCRIPTS.length) throw new Error("index.html declares no ui/ scripts");

function fail(message) {
  console.error("FAIL " + message);
  process.exitCode = 1;
}

// --- sandbox ----------------------------------------------------------------

// Any property access returns a fresh callable stub, so `naive.NButton`,
// `naive.useDialog()` and `naive.darkTheme` all resolve without naive-ui.
function deepStub(label) {
  const target = function () { return deepStub(label + "()"); };
  target.__stub = label;
  return new Proxy(target, {
    get(t, key) {
      if (key === "__stub") return label;
      if (key === Symbol.toPrimitive || key === "toString") return () => label;
      if (key === "then") return undefined;              // don't look thenable
      if (!(key in t)) t[key] = deepStub(label + "." + String(key));
      return t[key];
    },
    apply() { return deepStub(label + "()"); },
  });
}

// Vue's browser build decodes HTML entities by round-tripping them through a
// real element (compiler-dom/decodeHtmlBrowser). Templates here contain both
// entities (&lt;) and bare ampersands (v-if="a && b"), so the stub element has
// to actually decode rather than just record.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
};

function decodeEntities(raw) {
  return String(raw).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function decoderElement() {
  let html = "";
  return {
    set innerHTML(value) { html = String(value); },
    get innerHTML() { return html; },
    get textContent() { return decodeEntities(html); },
    // asAttr path: Vue sets innerHTML to `<div foo="...">` then reads the attr.
    get children() {
      const match = /^<div foo="([\s\S]*)">$/.exec(html);
      const value = match ? decodeEntities(match[1]) : "";
      return [{ getAttribute: () => value }];
    },
    setAttribute() {},
    addEventListener() {},
    appendChild() {},
    click() {},
  };
}

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  naive: deepStub("naive"),
  JSONEditor: deepStub("JSONEditor"),
  require: (id) => {
    if (id === "./host.cjs") return deepStub("guiServer");
    throw new Error("unexpected require(" + id + ") from a page script");
  },
  document: {
    getElementById: () => null,
    createElement: () => decoderElement(),
  },
  localStorage: { getItem: () => null, setItem() {} },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);

function runFile(relativePath) {
  const file = path.join(guiDir, relativePath);
  const code = readFileSync(file, "utf8");
  new vm.Script(code, { filename: relativePath }).runInContext(context);
}

// --- vendor bundle checks (text-level; no DOM needed) ------------------------

// NW.js 0.54 = Chromium 91. Syntax newer than that is a blank window, and the
// only symptom is a one-line SyntaxError in runtime/gui.log, so check up front.
const TOO_NEW_SYNTAX = [
  ["static{", "ES2022 class static blocks (Chromium 94+)"],
  ["static {", "ES2022 class static blocks (Chromium 94+)"],
  ["Object.hasOwn", "Object.hasOwn (Chromium 93+)"],
  [".at(", "Array/String.prototype.at (Chromium 92+)"],
  ["structuredClone", "structuredClone (Chromium 98+)"],
];

const VENDOR_BUNDLES = [
  "vendor/vue.global.prod.js",
  "vendor/naive-ui.prod.js",
  "vendor/jsoneditor/jsoneditor.min.js",
];

for (const bundle of VENDOR_BUNDLES) {
  const source = readFileSync(path.join(guiDir, bundle), "utf8");
  for (const [needle, label] of TOO_NEW_SYNTAX) {
    if (source.includes(needle)) fail(`${bundle} contains ${label} — Chromium 91 cannot parse it`);
  }
}

// The page reaches for these on the naive-ui namespace; a version bump that
// drops one should fail here, not at render time.
const NAIVE_REQUIRED = [
  "NConfigProvider", "NGlobalStyle", "NMessageProvider", "NDialogProvider",
  "NLayout", "NLayoutHeader", "NLayoutSider", "NLayoutContent", "NMenu",
  "NCard", "NButton", "NButtonGroup", "NTag", "NText", "NInput", "NInputNumber",
  "NInputGroup", "NSelect", "NSwitch", "NCheckbox", "NRadioGroup", "NRadioButton",
  "NDataTable", "NDrawer", "NDrawerContent", "NModal", "NPopconfirm",
  "NDescriptions", "NDescriptionsItem", "NForm", "NFormItem", "NAlert",
  "NEmpty", "NResult", "NGrid", "NGi", "NEllipsis", "NIconWrapper",
  "NTooltip", "NSpin", "NLog", "NTabs", "NTabPane", "NDivider",
  "NScrollbar", "NBreadcrumb", "NBreadcrumbItem", "NDropdown",
  "darkTheme", "zhCN", "dateZhCN",
  "useMessage", "useDialog", "install",
];

const naiveSource = readFileSync(path.join(guiDir, "vendor/naive-ui.prod.js"), "utf8");
const missingExports = NAIVE_REQUIRED.filter((name) => !naiveSource.includes("e." + name + "="));
if (missingExports.length) {
  fail("vendor/naive-ui.prod.js is missing exports: " + missingExports.join(", "));
} else {
  console.log(NAIVE_REQUIRED.length + " required naive-ui exports present");
}

// --- jsoneditor (存档数据 editor) -------------------------------------------

// This one is a real stylesheet with a real sprite, so it can fail in ways the
// CSS-in-JS bundles cannot: a missing img/ directory shows up as an editor whose
// buttons are all invisible, with nothing in the console.
const JSONEDITOR_JS = "vendor/jsoneditor/jsoneditor.min.js";
const JSONEDITOR_CSS = "vendor/jsoneditor/jsoneditor.min.css";

const jsoneditorSource = readFileSync(path.join(guiDir, JSONEDITOR_JS), "utf8");
if (!jsoneditorSource.includes(".JSONEditor=")) {
  fail(JSONEDITOR_JS + " has no UMD global branch (.JSONEditor=) — window.JSONEditor would stay undefined");
}
if (!jsoneditorSource.includes("zh-CN")) {
  fail(JSONEDITOR_JS + " has no zh-CN locale — ui/parts/json-editor.js asks for it");
}

const jsoneditorCss = readFileSync(path.join(guiDir, JSONEDITOR_CSS), "utf8");
const cssAssets = [...jsoneditorCss.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]
  .map((match) => match[1])
  .filter((href) => !href.startsWith("data:"));
const missingAssets = [...new Set(cssAssets)].filter(
  (href) => !existsSync(path.join(guiDir, "vendor", "jsoneditor", href)));
if (missingAssets.length) {
  fail(JSONEDITOR_CSS + " references missing assets: " + missingAssets.join(", "));
} else {
  console.log(new Set(cssAssets).size + " jsoneditor css asset(s) present");
}

// The UMD bundle only reaches `window` while index.html has module/exports
// hidden, so the script tag has to sit inside that window.
const cjsRestore = indexHtml.indexOf("module = window.__rmchCjs.module");
const jsoneditorTag = indexHtml.indexOf(JSONEDITOR_JS);
if (jsoneditorTag === -1) {
  fail("index.html does not load " + JSONEDITOR_JS);
} else if (cjsRestore !== -1 && jsoneditorTag > cjsRestore) {
  fail(JSONEDITOR_JS + " is loaded after the CJS globals are restored — window.JSONEditor will be undefined");
}
for (const sheet of [JSONEDITOR_CSS, "jsoneditor-theme.css"]) {
  if (!indexHtml.includes(sheet)) fail("index.html does not link " + sheet);
  if (!existsSync(path.join(guiDir, sheet))) fail("missing " + sheet);
}

// Vue's HTML parser silently auto-closes a mismatched end tag, so
// `<rm-virtual>…</rm-foo>` compiles fine and then explodes at render time with a
// slot attached to the wrong component. Count the tags instead.
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

function tagBalanceErrors(template) {
  const stack = [];
  const problems = [];
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tagPattern.exec(template)) !== null) {
    const [, closing, name, attrs, selfClosed] = match;
    if (closing) {
      if (!stack.length) problems.push(`stray </${name}>`);
      else if (stack[stack.length - 1] !== name) {
        problems.push(`</${name}> closes <${stack[stack.length - 1]}>`);
        stack.pop();
      } else stack.pop();
      continue;
    }
    if (selfClosed || VOID_TAGS.has(name.toLowerCase())) continue;
    void attrs;
    stack.push(name);
  }
  if (stack.length) problems.push(`unclosed <${stack.join(">, <")}>`);
  return problems;
}

// --- load Vue, then the page scripts ----------------------------------------

runFile("vendor/vue.global.prod.js");
if (!sandbox.Vue || typeof sandbox.Vue.compile !== "function") {
  fail("vendor/vue.global.prod.js did not expose a compiler-enabled Vue global");
  process.exit(1);
}
console.log("vue " + sandbox.Vue.version + " loaded (compiler present)");

sandbox.window.addEventListener = () => {};

for (const script of SCRIPTS) {
  try {
    runFile(script);
  } catch (error) {
    fail(script + " threw while loading: " + (error && error.stack ? error.stack : error));
    process.exit(1);
  }
}
console.log(SCRIPTS.length + " page scripts loaded without throwing");

const RMCH = sandbox.window.RMCH;
if (!RMCH) {
  fail("page scripts did not populate window.RMCH");
  process.exit(1);
}

// --- store surface --------------------------------------------------------------

// Views reach the store as `store.something(...)`. Nothing type-checks that, and
// a rename in ui/store/* only fails when a user clicks the button, so assert
// every referenced name exists on the assembled store.
const STORE_ALLOWED_MISSES = new Set(["value"]);   // `store.value` never appears; guard against noise

const storeObject = RMCH.store;
if (!storeObject) {
  fail("ui/store/core.js did not create RMCH.store");
} else {
  const referenced = new Map();
  for (const script of SCRIPTS) {
    const source = readFileSync(path.join(guiDir, script), "utf8");
    for (const match of source.matchAll(/\bstore\.([A-Za-z_$][\w$]*)/g)) {
      if (!referenced.has(match[1])) referenced.set(match[1], script);
    }
  }
  const missing = [...referenced]
    .filter(([name]) => !STORE_ALLOWED_MISSES.has(name) && !(name in storeObject))
    .map(([name, script]) => `${name} (${script})`);
  if (missing.length) {
    fail("page scripts reference store members that do not exist:\n  " + missing.join("\n  "));
  } else {
    console.log(referenced.size + " distinct store members referenced, all present");
  }
}

// --- compile every template -------------------------------------------------


const components = new Map();
function collect(prefix, bag) {
  for (const [name, component] of Object.entries(bag || {})) {
    if (component && typeof component === "object") components.set(prefix + name, component);
  }
}
collect("views.", RMCH.views);
collect("parts.", RMCH.parts);
collect("", { App: RMCH.App, Shell: RMCH.Shell, Icon: RMCH.Icon });

let compiled = 0;
let renderOnly = 0;

for (const [name, component] of components) {
  if (typeof component.template !== "string") {
    if (typeof component.render === "function" || typeof component.setup === "function") renderOnly += 1;
    continue;
  }
  const errors = [];
  let result = null;
  tagBalanceErrors(component.template).forEach((problem) => errors.push("tags: " + problem));
  try {
    result = sandbox.Vue.compile(component.template, {
      onError: (error) => errors.push(error.message || String(error)),
      onWarn: (warning) => errors.push("warn: " + (warning.message || String(warning))),
    });
  } catch (error) {
    errors.push(process.env.RMCH_DEBUG && error && error.stack ? error.stack
      : (error && error.message ? error.message : String(error)));
  }
  if (errors.length) {
    fail(name + " template: " + errors.join(" | "));
    continue;
  }
  if (typeof result !== "function") {
    fail(name + " template did not compile to a render function");
    continue;
  }
  compiled += 1;
}

console.log(compiled + " templates compiled, " + renderOnly + " render-function components skipped");

// Sanity: the shell's five views must all exist and be components.
for (const expected of ["Library", "Trainer", "Console", "Saves", "Log"]) {
  if (!RMCH.views || !RMCH.views[expected]) fail("missing RMCH.views." + expected);
}

if (process.exitCode) {
  console.error("gui-check FAILED");
} else {
  console.log("gui-check OK");
}
