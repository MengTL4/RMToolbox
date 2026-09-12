// Real NW.js smoke: production UI, native CJS/filesystem and an isolated bridge.
// The host fixture prevents any game launch or access to the user's library.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import {
  readRuntimeLock,
  verifyInstalledRuntime
} from "../core/setup-gui-runtime.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gui = path.resolve(process.argv[3] || path.join(root, "app/gui"));
const runtime = path.resolve(process.argv[2] || gui);
const lock = readRuntimeLock(root);
assert.ok(
  verifyInstalledRuntime(runtime, lock),
  "Runtime must match the pinned manifest"
);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rmch-nw-smoke-"));
const resultFile = path.join(temp, "result.json");
const json = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
const intro = `<base href=${json(pathToFileURL(gui + path.sep).href)}><script>
window.__nativeRequire = require;
window.__nativeNw = nw;
window.__finish = function(result) {
  __nativeRequire('node:fs').writeFileSync(${json(resultFile)}, JSON.stringify(result));
  __nativeNw.App.quit();
};
window.addEventListener('error', function(e) { __finish({error: e.message, stack: e.error && e.error.stack}); });
window.addEventListener('unhandledrejection', function(e) { __finish({error: String(e.reason), stack: e.reason && e.reason.stack}); });
</script><script src=${json(pathToFileURL(path.join(root, "tools/fixtures/gui-host.js")).href)}></script>`;
const smoke = `<script>
(async function () {
  const check = (value, message) => { if (!value) throw new Error(message); };
  const versions = __nativeRequire('node:process').versions;
  check(versions.nw === ${json(lock.version)}, 'Wrong NW version: ' + versions.nw);
  check(versions.node === ${json(lock.node)}, 'Wrong Node version: ' + versions.node);
  const fs = __nativeRequire('node:fs');
  const probe = ${json(path.join(temp, "中文读写.txt"))};
  fs.writeFileSync(probe, '工具箱');
  check(fs.readFileSync(probe, 'utf8') === '工具箱', 'Native file roundtrip failed');
  const bundle = __nativeRequire(${json(path.join(gui, "gui-bundle.cjs"))});
  __nativeRequire(${json(path.join(root, "tools/fixtures/shadow-filesystem.cjs"))}).checkShadowFilesystem(bundle.mod('core/shadow-launcher.mjs'));
  await __nativeRequire(${json(path.join(root, "tools/fixtures/rgss-shadow-rebuild.cjs"))}).checkRgssShadowRebuild(bundle.mod('core/rgss-launcher.mjs').launchRgssGame);
  const {BridgeServer} = bundle.mod('core/ws-server.mjs');
  const server = new BridgeServer({port: 0, token: 'isolated-smoke'});
  await server.start();
  const address = server.httpServer.address();
  const response = await new Promise((resolve, reject) => {
    __nativeRequire('node:http').get('http://127.0.0.1:' + address.port, resolve).on('error', reject);
  });
  response.resume();
  check(response.statusCode === 404, 'Native bridge HTTP failed');
  await server.stop();
  check(typeof __nativeRequire(${json(path.join(gui, "host.cjs"))}).init === 'function', 'Host CJS failed');
  await RMCH.store.init();
  const app = Vue.createApp(RMCH.App).use(naive);
  app.component('RmIcon', RMCH.Icon);
  RMCH.shims.forEach(name => app.component(name, naive[name]));
  app.mixin({mounted() { if (this.$options.name === 'RmchShell') window.__shell = this; }});
  app.config.errorHandler = error => { throw error; };
  app.mount('#app');
  await Vue.nextTick();
  check(document.body.innerText.includes('两种注入方式'), 'Compiled injection guide missing');
  RMCH.store.selectGame('a');
  for (let i = 0; i < 30; i++) await Promise.resolve();
  RMCH.store.applyLiveState({engine: {maker: 'MZ'}, gold: 100, inBattle: false});
  __shell.tab = 'data';
  await Vue.nextTick();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  RMCH.store.data.selected.item = 1;
  await Vue.nextTick();
  const plus = Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '+1');
  check(plus, 'Delta button missing');
  plus.click();
  await Vue.nextTick();
  check(!__guiFixture.calls.some(c => c.type === 'item.set'), 'Draft submitted automatically');
  Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '应用').click();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  check(__guiFixture.calls.filter(c => c.type === 'item.set').length === 1, 'Explicit apply did not submit once');
  RMCH.store.data.tab = 'map';
  await Vue.nextTick();
  const mapCard = Array.from(document.querySelectorAll('.n-card')).find(c => c.querySelector('.n-card-header')?.textContent.includes('当前地图事件'));
  check(mapCard, 'Map tools did not mount');
  Array.from(mapCard.querySelectorAll('button')).find(b => b.textContent.trim() === '刷新').click();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await Vue.nextTick();
  for (let i = 0; i < 30 && !mapCard.innerText.includes('港口守卫'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  check(mapCard.innerText.includes('港口守卫'), 'Map protocol fixture did not render: ' + mapCard.innerText);
  Array.from(mapCard.querySelectorAll('button')).find(b => b.textContent.trim() === '指令').click();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  await Vue.nextTick();
  for (let i = 0; i < 30 && !document.body.innerText.includes('9876'); i++) await new Promise(resolve => setTimeout(resolve, 50));
  check(document.body.innerText.includes('事件解释器 · 只读') && document.body.innerText.includes('9876'), 'Event reader did not render raw unknown commands');
  check(!__guiFixture.calls.some(c => c.type === 'map.move' || c.type === 'console.eval'), 'Reading events mutated the game');
  RMCH.store.data.tab='event';RMCH.store.data.selected.event=1;
  await Vue.nextTick();
  for(let i=0;i<30;i++)await Promise.resolve();
  Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='事件解释器').click();
  for(let i=0;i<30 && !document.body.innerText.includes('选择步骤');i++)await new Promise(resolve=>setTimeout(resolve,50));
  Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='选择步骤').click();
  await Vue.nextTick();
  check(!__guiFixture.calls.some(c=>c.type==='events.execute'),'Step selection executed automatically');
  Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行这一步').click();
  for(let i=0;i<30;i++)await Promise.resolve();
  check(__guiFixture.calls.filter(c=>c.type==='events.execute').length===1,'Explicit step execution missing');
  __shell.tab = 'saves';
  await Vue.nextTick();
  check(document.body.innerText.includes('存档文件与备份'), 'Page navigation failed');
  check(!document.querySelector('#boot-error').innerText, 'Boot guard reported errors');
  __finish({ok: true, versions, checks: ['native-files', 'shadow-junction-rebuild', 'rgss-shadow-rebuild', 'bridge-listen-stop', 'host-cjs', 'vue-sfc', 'draft-only', 'navigation', 'map-events', 'readonly-interpreter', 'embedded-step-execution']});
})();
</script>`;
// NW prefers an adjacent package.json even over an explicit app argument. Copy
// the verified runtime into the owned test app so production manifests are
// never edited and an installed GUI cannot accidentally boot its real host.
const stamp = JSON.parse(
  fs.readFileSync(path.join(runtime, ".nw-runtime.json"), "utf8")
);
for (const file of stamp.files) {
  const destination = path.join(temp, file.path);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(path.join(runtime, file.path), destination);
}
const manifest = JSON.parse(
  fs.readFileSync(path.join(gui, "package.json"), "utf8")
);
fs.writeFileSync(
  path.join(temp, "package.json"),
  JSON.stringify({
    ...manifest,
    name: "rmch-runtime-smoke",
    main: "index.html",
    window: { ...manifest.window, show: false }
  })
);
fs.writeFileSync(
  path.join(temp, "index.html"),
  fs
    .readFileSync(path.join(gui, "index.html"), "utf8")
    .replace("<head>", "<head>" + intro)
    .replace('<script src="ui/main.js"></script>', smoke)
);
const child = spawn(
  path.join(temp, "RMToolbox.exe"),
  [
    "--headless",
    "--disable-gpu",
    `--user-data-dir=${path.join(temp, "profile")}`
  ],
  { windowsHide: true, stdio: "ignore" }
);
let spawnError;
child.on("error", (error) => {
  spawnError = error;
});
try {
  const deadline = Date.now() + 45000;
  while (
    !fs.existsSync(resultFile) &&
    Date.now() < deadline &&
    child.exitCode === null &&
    !spawnError
  )
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (spawnError) throw spawnError;
  assert.ok(
    fs.existsSync(resultFile),
    "NW smoke did not write a result (exit " + child.exitCode + ")"
  );
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(result.ok, true, JSON.stringify(result));
  console.log(
    "NW smoke PASS " + result.versions.nw + ": " + result.checks.join(", ")
  );
} finally {
  if (child.exitCode === null) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else {
      child.once("exit", resolve);
      setTimeout(resolve, 2000).unref();
    }
  });
  // mkdtemp creates this exact owned directory; never follow a linked replacement.
  if (
    !fs.lstatSync(temp).isSymbolicLink() &&
    path.dirname(temp) === path.resolve(os.tmpdir())
  ) {
    // Chromium child processes can release their profile handles after the NW
    // parent exits. Let Windows finish releasing this owned test directory.
    await fs.promises.rm(temp, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500
    });
  }
}
