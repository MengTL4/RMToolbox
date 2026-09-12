// Render production Vue/Naive UI against a controlled host in headless Chrome.
// No real game is launched. Optional local visual check (requires Chrome).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gui = path.join(root, "app/gui");
const output = path.join(root, "runtime/screenshots/ui-review");
const chrome =
  process.env.CHROME_PATH ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";
if (typeof WebSocket === "undefined")
  throw new Error("The optional browser check requires Node 22 or newer");
if (!fs.existsSync(chrome))
  throw new Error("Set CHROME_PATH to run the browser UI check");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rmch-ui-browser-"));
const bootstrap = `<script>
(async function () {
  const params = new URLSearchParams(location.search);
  __guiFixture.webStorage = params.get('storage') === 'web';
  const [page, subtab] = (params.get('view') || 'library').split(':');
  localStorage.setItem('rmch.theme', params.get('theme') || 'dark');
  const store = RMCH.store;
  await store.init();
  if (page !== 'library') {
    store.selectGame(params.get('game') || 'a');
    for (let i = 0; i < 30; i++) await Promise.resolve();
    store.applyLiveState({ engine: { maker: 'MZ' }, map: { mapId: 1 }, gold: 24860, inBattle: false });
  }
  const app = Vue.createApp(RMCH.App).use(naive);
  app.component('RmIcon', RMCH.Icon);
  RMCH.shims.forEach(name => app.component(name, naive[name]));
  app.mixin({ mounted() { if (this.$options.name === 'RmchShell') window.__shell = this; } });
  app.config.errorHandler = error => { window.__uiError = String(error.stack || error); };
  app.mount('#app');
  await Vue.nextTick();
  __shell.tab = page;
  await Vue.nextTick();
  if (page === 'data') {
    store.data.tab = subtab || 'item';
    for (let i = 0; i < 30; i++) await Promise.resolve();
    if (store.data.tab in store.data.selected) store.data.selected[store.data.tab] = 1;
    if (subtab === 'tree') await store.loadSaveTree();
    if (subtab === 'event') {store.data.selected.event=1;await Vue.nextTick();Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='事件解释器').click();}
    for (let i = 0; i < 30; i++) await Promise.resolve();
  }
  await Vue.nextTick();
  window.__uiReady = true;
})();
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/") {
    let html = fs.readFileSync(path.join(gui, "index.html"), "utf8");
    html = html
      .replace(
        "<head>",
        '<head><base href="/gui/"><script src="/fixture.js"></script>'
      )
      .replace('<script src="ui/main.js"></script>', bootstrap);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(html);
    return;
  }
  const file =
    url.pathname === "/fixture.js"
      ? path.join(root, "tools/fixtures/gui-host.js")
      : path.resolve(
          gui,
          "." + decodeURIComponent(url.pathname.replace(/^\/gui/, ""))
        );
  if (
    !(
      file.startsWith(gui + path.sep) ||
      file === path.join(root, "tools/fixtures/gui-host.js")
    ) ||
    !fs.existsSync(file)
  ) {
    res.writeHead(404).end();
    return;
  }
  res.setHeader(
    "Content-Type",
    file.endsWith(".css")
      ? "text/css"
      : file.endsWith(".js")
        ? "text/javascript"
        : "application/octet-stream"
  );
  res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const child = spawn(
  chrome,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank"
  ],
  { windowsHide: true, stdio: "ignore" }
);
let ws;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const activePort = path.join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100 && !fs.existsSync(activePort); i++) await sleep(100);
  const port = fs.readFileSync(activePort, "utf8").split("\n")[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  ws = new WebSocket(
    targets.find((t) => t.type === "page").webSocketDebuggerUrl
  );
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let next = 0;
  const pending = new Map(),
    errors = [];
  ws.onmessage = (event) => {
    const packet = JSON.parse(event.data);
    if (packet.method === "Runtime.exceptionThrown")
      errors.push(
        packet.params.exceptionDetails.exception?.description ||
          packet.params.exceptionDetails.text
      );
    if (packet.id) {
      const call = pending.get(packet.id);
      pending.delete(packet.id);
      packet.error
        ? call.reject(new Error(JSON.stringify(packet.error)))
        : call.resolve(packet.result);
    }
  };
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await cdp("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ||
          result.exceptionDetails.text
      );
    return result.result.value;
  }
  await cdp("Runtime.enable");
  await cdp("Page.enable");
  fs.mkdirSync(output, { recursive: true });
  const views = [
    "library",
    "trainer",
    "data",
    "saves",
    "console",
    "log",
    ...[
      "armor",
      "weapon",
      "switch",
      "variable",
      "actor",
      "map",
      "event",
      "tree"
    ].map((tab) => "data:" + tab)
  ];
  for (const theme of ["light", "dark"])
    for (const size of [
      [1180, 800],
      [900, 640]
    ])
      for (const view of views) {
        const [width, height] = size;
        await cdp("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false
        });
        await cdp("Page.navigate", {
          url: `${origin}/?view=${view}&theme=${theme}`
        });
        let ready = false;
        for (let i = 0; i < 80; i++) {
          await sleep(100);
          if (await evaluate("!!window.__uiReady")) {
            ready = true;
            break;
          }
        }
        assert.ok(
          ready,
          `${view} mounted: ${JSON.stringify(errors)} ${await evaluate("document.body.innerText.slice(0, 1800)")}`
        );
        await sleep(250);
        const layout =
          await evaluate(`({title:document.title, header:!!document.querySelector('.rm-header'),
      overflow:document.documentElement.scrollWidth > innerWidth,
      text:document.body.innerText, errors:window.__uiError || document.querySelector('#boot-error').innerText})`);
        assert.ok(layout.header);
        assert.equal(
          layout.overflow,
          false,
          `${view} horizontal page overflow`
        );
        assert.equal(layout.errors, "");
        assert.deepEqual(errors, []);
        const expected = view.startsWith("data")
          ? "数据编辑"
          : {
              library: "你的游戏",
              trainer: "常用开关",
              saves: "存档文件与备份",
              console: "控制台",
              log: "日志"
            }[view];
        assert.ok(layout.text.includes(expected), view + ": " + layout.text);
        if (view === "data:tree")
          assert.ok(
            await evaluate("!!document.querySelector('.jsoneditor')"),
            "JSON editor did not mount"
          );
        const shot = await cdp("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(
          path.join(output, `${view.replace(":", "-")}-${theme}-${width}.png`),
          Buffer.from(shot.data, "base64")
        );
        console.log(`render PASS ${view} ${theme} ${width}x${height}`);
      }
  await cdp("Page.navigate", { url: `${origin}/?view=library&theme=light` });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if (await evaluate("!!window.__uiReady")) break;
  }
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '附加到运行中' && !b.disabled).click()`
  );
  await sleep(150);
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c => c.type === 'attach').length"
    ),
    1
  );
  assert.equal(await evaluate("__shell.tab"), "library");
  // The primary button names the action the SELECTED route performs, so a route
  // whose launch differs from the generic "relaunch and hook" reading (the dll
  // route starts the game bare) says so on the button, not only in a tooltip.
  {
    const before = await evaluate(
      `Array.from(document.querySelectorAll('.rm-game-card')).map(c => { const b = c.querySelector('.n-button--primary-type'); return b ? b.textContent.trim() : ''; })`
    );
    assert.ok(
      before.some((text) => text.startsWith("启动并注入")),
      `launch buttons keep the recognised verb: ${JSON.stringify(before)}`
    );
    // The fixture's minimal candidates carry no actionLabel, so the button must
    // fall back to the bare verb rather than render "（）" or "undefined".
    assert.ok(
      before.every(
        (text) => !text.includes("（）") && !text.includes("undefined")
      ),
      `no empty action label: ${JSON.stringify(before)}`
    );
  }
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim().startsWith('启动并注入')).click()`
  );
  await sleep(150);
  assert.equal(await evaluate("__shell.tab"), "library");
  await evaluate(
    `__guiFixture.sessions.push({gameKey:'c',alive:true,connectedAt:1}); __guiFixture.handlers.onSessions(__guiFixture.sessions)`
  );
  await sleep(100);
  assert.equal(
    await evaluate("RMCH.store.trainer.gameKey"),
    null,
    "connection does not steal selection"
  );
  await evaluate(
    `Array.from(document.querySelectorAll('.rm-game-card')).find(c => c.textContent.includes('星河旅人')).querySelector('.n-button--primary-type').click()`
  );
  await sleep(150);
  assert.equal(await evaluate("__shell.tab"), "trainer");
  assert.equal(await evaluate("RMCH.store.trainer.gameKey"), "a");
  // The About dialog must surface the newer release the host reported, and the
  // download link must go through openExternal (not openPath, which stats a
  // filesystem path and would reject a URL).
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '关于工具箱').click()`
  );
  await sleep(200);
  const aboutText = await evaluate("document.body.innerText");
  assert.ok(
    aboutText.includes("版本更新"),
    "About dialog is missing the update row"
  );
  assert.ok(
    aboutText.includes("9.9.9"),
    "About dialog does not show the newer version: " + aboutText.slice(0, 600)
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '前往下载').click()`
  );
  await sleep(100);
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c => c.type === 'openExternal').length"
    ),
    1,
    "前往下载 must open the URL through the host"
  );
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c => c.type === 'openPath').length"
    ),
    0,
    "a release URL must never be routed through openPath"
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === '关于工具箱').click()`
  );
  await sleep(150);
  await evaluate(
    `Array.from(document.querySelectorAll('.n-menu-item-content')).find(e => e.textContent.trim() === '数据').click()`
  );
  await sleep(150);
  await evaluate("RMCH.store.data.selected.item=1");
  await sleep(100);
  const editsBefore = await evaluate(
    "__guiFixture.calls.filter(c=>c.type==='item.set').length"
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='+1').click()`
  );
  assert.equal(
    await evaluate("__guiFixture.calls.filter(c=>c.type==='item.set').length"),
    editsBefore
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='应用').click()`
  );
  await sleep(100);
  assert.equal(
    await evaluate("__guiFixture.calls.filter(c=>c.type==='item.set').length"),
    editsBefore + 1
  );
  await evaluate(
    `RMCH.store.data.owned.item=[{kind:'item',id:'I123',baseItemId:1,name:'独立实例测试',count:1}]; RMCH.store.data.counts.item.I123=1; RMCH.store.data.selected.item='I123'`
  );
  await sleep(100);
  assert.ok(await evaluate("document.body.innerText.includes('独立实例测试')"));
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='+1').click()`
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='应用').click()`
  );
  await sleep(100);
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='item.set').at(-1).args.id"
    ),
    "I123"
  );
  await evaluate(
    `__guiFixture.sessions=__guiFixture.sessions.filter(s=>s.gameKey!=='a'); __guiFixture.handlers.onSessions(__guiFixture.sessions)`
  );
  await sleep(100);
  assert.ok(
    await evaluate("document.body.innerText.includes('当前游戏已断开')")
  );
  assert.equal(await evaluate("RMCH.store.trainer.gameKey"), "a");
  await evaluate(
    `__guiFixture.sessions.push({gameKey:'a',alive:true,connectedAt:2}); __guiFixture.handlers.onSessions(__guiFixture.sessions)`
  );
  await sleep(150);
  assert.ok(
    await evaluate("document.body.innerText.includes('数据编辑')"),
    await evaluate(
      "JSON.stringify({error:window.__uiError,text:document.body.innerText, key:RMCH.store.trainer.gameKey, connected:RMCH.store.currentConnected.value})"
    )
  );
  assert.equal(await evaluate("window.__uiError || ''"), "");
  assert.deepEqual(errors, []);
  console.log(
    "browser interaction PASS: launch, manual entry, navigation, draft/apply, disconnect and reconnect"
  );
  await evaluate("RMCH.store.data.tab='map'");
  await sleep(300);
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='定位').click()`
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='事件迷你地图').click()`
  );
  await sleep(300);
  assert.ok(await evaluate("!!document.querySelector('.rm-event-canvas')"));
  assert.equal(await evaluate("window.__uiError || ''"), "");
  const mapShot = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(output, "event-mini-map.png"),
    Buffer.from(mapShot.data, "base64")
  );
  assert.equal(
    await evaluate("__guiFixture.calls.filter(c=>c.type==='map.move').length"),
    0,
    "selecting never teleports"
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='强制到事件坐标…').at(-1).click()`
  );
  await sleep(150);
  assert.equal(
    await evaluate("__guiFixture.calls.filter(c=>c.type==='map.move').length"),
    0,
    "force waits for confirmation"
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='确认强制传送').click()`
  );
  await sleep(150);
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='map.move' && c.args.force && c.args.confirmed).length"
    ),
    1
  );
  await evaluate(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='查看事件指令').click()`
  );
  await sleep(300);
  assert.ok(
    await evaluate(
      "document.body.innerText.includes('脚本') && document.body.innerText.includes('9876')"
    )
  );
  assert.equal(
    await evaluate("RMCH.store.data.tab"),
    "map",
    "map reader opens in-place"
  );
  assert.ok(
    await evaluate(
      "!Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='执行这一步')"
    ),
    "map reader stays readonly"
  );
  const readShot = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(output, "event-interpreter.png"),
    Buffer.from(readShot.data, "base64")
  );
  await evaluate("__guiFixture.eventRevision='two'");
  await sleep(1300);
  assert.ok(await evaluate("document.body.innerText.includes('内容已过期')"));
  const beforeHidden = await evaluate(
    "__guiFixture.calls.filter(c=>c.type==='map.inspect').length"
  );
  await evaluate("__shell.tab='library'");
  await sleep(1400);
  assert.ok(
    (await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='map.inspect').length"
    )) <=
      beforeHidden + 1,
    "hidden tools stop polling"
  );
  assert.equal(await evaluate("window.__uiError || ''"), "");
  assert.deepEqual(errors, []);
  console.log(
    "browser event tools PASS: mini-map, select-only, force confirmation, reader, stale snapshot, hidden polling"
  );
  // 能力声明驱动渲染：XP（RGSS1）游戏没有独立开关，数据·地图视图不呈现该
  // 卡片；MZ 游戏保留。游戏 e 是夹具里的 RGSS1 游戏。
  for (const [game, expected] of [
    ["a", true],
    ["e", false]
  ]) {
    await cdp("Page.navigate", {
      url: `${origin}/?view=data:map&theme=light&game=${game}`
    });
    let capReady = false;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      if (await evaluate("!!window.__uiReady")) {
        capReady = true;
        break;
      }
    }
    assert.ok(capReady, `data:map game=${game} mounted`);
    await sleep(250);
    assert.equal(
      await evaluate("document.body.innerText.includes('独立开关')"),
      expected,
      expected
        ? "MZ shows the 独立开关 card"
        : "XP (RGSS1) hides the 独立开关 card"
    );
    assert.equal(await evaluate("window.__uiError || ''"), "");
    assert.deepEqual(errors, []);
  }
  console.log("browser capability gating PASS: XP hides 独立开关, MZ keeps it");
  await cdp("Page.navigate", { url: origin + "/?view=data:event&theme=light" });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if (await evaluate("!!window.__uiReady")) break;
  }
  await sleep(300);
  assert.ok(
    await evaluate("document.body.innerText.includes('执行这一步')"),
    "embedded reader mounted"
  );
  assert.ok(
    await evaluate(
      "!Array.from(document.querySelectorAll('.n-tabs-tab')).some(t=>t.textContent.trim()==='事件解释器')"
    ),
    "standalone tab removed"
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='选择步骤').click()"
  );
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='events.execute').length"
    ),
    0,
    "select is read only"
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行这一步').click()"
  );
  await sleep(150);
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='events.execute').length"
    ),
    1
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='停止后续指令').click()"
  );
  await sleep(150);
  assert.ok(
    await evaluate("document.body.innerText.includes('等待当前操作结束后停止')")
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='收起事件解释器').click()"
  );
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='events.stop').length"
    ),
    1,
    "closing does not send a stop"
  );
  await evaluate(
    "__guiFixture.executions.a.state='stopped';RMCH.store.selectGame('b')"
  );
  await sleep(150);
  await evaluate("RMCH.store.selectGame('a');RMCH.store.data.selected.event=1");
  await sleep(1200);
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='事件解释器').click()"
  );
  await sleep(300);
  assert.ok(
    await evaluate("document.body.innerText.includes('已停止')"),
    "execution belongs to original game"
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='选择步骤').at(-1).click()"
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='执行这一步').click()"
  );
  await sleep(150);
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='events.execute').length"
    ),
    1,
    "script waits for confirmation"
  );
  assert.ok(
    await evaluate(
      "document.body.innerText.includes('$gameParty.gainGold(6);')"
    )
  );
  await evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='确认执行').click()"
  );
  await sleep(150);
  assert.equal(
    await evaluate(
      "__guiFixture.calls.filter(c=>c.type==='events.execute' && c.args.confirmed===true).length"
    ),
    1
  );
  assert.equal(await evaluate("window.__uiError || ''"), "");
  assert.deepEqual(errors, []);
  const executionShot = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(output, "common-event-execution.png"),
    Buffer.from(executionShot.data, "base64")
  );
  console.log(
    "browser execution PASS: embedded reader, explicit step, wait/stop, close, game ownership, script confirmation"
  );
  await cdp("Page.navigate", {
    url: origin + "/?view=saves&storage=web&theme=light"
  });
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if (await evaluate("!!window.__uiReady")) break;
  }
  await sleep(250);
  assert.ok(
    await evaluate(
      "document.body.innerText.includes('浏览器数据') && document.body.innerText.includes('RPG File1')"
    )
  );
  assert.ok(
    await evaluate(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='打开存档目录').disabled"
    )
  );
  await evaluate(`__guiFixture.backupSaves = () => new Promise(resolve => { window.__finishBackup = () => {window.__backupComplete=true;resolve({files:1,destDir:'fixture-backup'})}; });
    __guiFixture.listBackups = () => window.__backupComplete ? [{name:'browser-backup',files:1,bytes:4096}] : [];
    Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='备份存档').click();`);
  await sleep(150);
  assert.equal(
    await evaluate("document.body.innerText.includes('browser-backup')"),
    false,
    "pending backup must not be shown as completed"
  );
  await evaluate("__finishBackup()");
  await sleep(250);
  assert.ok(
    await evaluate("document.body.innerText.includes('browser-backup')"),
    "backup list refreshes after async completion"
  );
  assert.equal(await evaluate("window.__uiError || ''"), "");
  assert.deepEqual(errors, []);
  const webSaveShot = await cdp("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(
    path.join(output, "webstorage-saves.png"),
    Buffer.from(webSaveShot.data, "base64")
  );
  console.log(
    "browser WebStorage PASS: real slot labels, no fake directory, async backup completion"
  );
  console.log(`UI screenshots: ${output}`);
} finally {
  if (ws) ws.close();
  child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", resolve);
  });
  server.close();
  // This exact directory was created by mkdtemp above for this Chrome process.
  fs.rmSync(profile, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}
