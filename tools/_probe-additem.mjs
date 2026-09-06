// Real-machine repro for "数据页添加物品/技能不生效" on 万族穿越-源启崛起.
// Launches via the GUI path (launchNwInjectGame), then:
//   1. title screen: item.set / actor.skill.learn — capture the exact errors
//   2. console.eval: inspect what the page exposes (capture state, globals)
//   3. blind keyboard drive (继续游戏) while polling party.info for a live
//      capture; once live, re-run item.set / skill.learn and verify in-game
//      state actually changed (item.list / actor.info read-backs).
// Keeps catalog-cache.json (mimics the user's second launch).
import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { scanGame } from "../core/scanner.mjs";
import { launchNwInjectGame } from "../core/attach.mjs";

const projectRoot = "E:\\project\\RMToolbox";
const gameRoot = "D:\\Downloads\\RPG\\_V1.2.2_B电脑端";
const stateDir = path.join(projectRoot, "runtime", "bridge-state", "_V1.2.2_B电脑端");
const commandsPath = path.join(stateDir, "commands.jsonl");
const eventsPath = path.join(stateDir, "events.jsonl");
const t0 = Date.now();
const elog = (msg, extra) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}${extra ? " " + extra : ""}`);

for (const f of ["commands.jsonl", "events.jsonl", "state.json"]) {
  rmSync(path.join(stateDir, f), { force: true });
}

let cmdN = 0;
async function cmd(type, args) {
  cmdN += 1;
  const id = `pr${cmdN}`;
  const before = existsSync(eventsPath)
    ? readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean).length : 0;
  writeFileSync(commandsPath, JSON.stringify({ commandId: id, ts: Date.now(), type, args: args || {} }) + "\n", { flag: "a" });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    if (!existsSync(eventsPath)) continue;
    const lines = readFileSync(eventsPath, "utf8").split(/\r?\n/).filter(Boolean);
    for (let i = Math.max(before, 0); i < lines.length; i += 1) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.commandId === `file:${id}`) return e;
      } catch (_) {}
    }
  }
  return { ok: false, error: "timeout" };
}

const ps = (script) => new Promise((resolve) => {
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { windowsHide: true }, (err, stdout) => resolve(String(stdout || "").trim()));
});

const windowTitle = () => ps(
  "Get-Process -Name '万族穿越-源启崛起' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1 -ExpandProperty MainWindowTitle"
);

const sendKeys = (title, keys) => ps(
  `$ws = New-Object -ComObject WScript.Shell;` +
  `$ok = $ws.AppActivate(${JSON.stringify(title)}); Start-Sleep -Milliseconds 600;` +
  keys.map((k) => `$ws.SendKeys(${JSON.stringify(k)}); Start-Sleep -Milliseconds 350;`).join("")
);

const captureLive = async () => {
  const r = await cmd("console.eval", { code: "!!window.__rmchCapture" });
  return !!(r.ok && r.payload && String(r.payload.result) === "true");
};

// --- launch -----------------------------------------------------------------
const scan = scanGame(gameRoot);
elog("scan", `container=${scan.container}`);
const summary = await launchNwInjectGame({ scan, projectRoot, port: 47412 });
elog("launch returned", `strategy=${summary.strategy}`);

// --- phase 1: title screen, mutations must fail with a clear error ----------
elog("--- phase 1: title screen mutations (expect clean errors)");
const add1 = await cmd("item.set", { kind: "item", id: 1, count: 5 });
elog("item.set @title", add1.ok ? `OK?! ${JSON.stringify(add1.payload)}` : `error=${String(add1.error || "").split("\n")[0]}`);
const learn1 = await cmd("actor.skill.learn", { id: 1, skillId: 10 });
elog("actor.skill.learn @title", learn1.ok ? `OK?! ${JSON.stringify(learn1.payload)}` : `error=${String(learn1.error || "").split("\n")[0]}`);
const env = await cmd("console.eval", {
  code: "JSON.stringify({sp: typeof window.$gameParty, dm: typeof window.DataManager, cap: !!window.__rmchCapture, tables: Object.keys(window.__rmchDataTables||{}).length, href: location.href.slice(0, 60), title: document.title})"
});
elog("page env", env.ok ? env.payload.result : `error=${env.error}`);

// --- phase 2: blind keyboard drive to load a save ---------------------------
elog("--- phase 2: keyboard drive (继续游戏), polling for live capture");
const title = await windowTitle();
elog("game window title", JSON.stringify(title));
let live = await captureLive();
elog("capture live before keys?", String(live));
if (!live && title) {
  const attempts = [
    ["{DOWN}", "{ENTER}", "{ENTER}"],   // 继续游戏 → 第一个存档
    ["{ENTER}"],                        // 可能已在存档列表
    ["{UP}", "{ENTER}", "{ENTER}"],     // 菜单顺序反排的情况
    ["{DOWN}", "{DOWN}", "{ENTER}", "{ENTER}"]
  ];
  for (let i = 0; i < attempts.length && !live; i += 1) {
    elog(`key attempt ${i + 1}`, attempts[i].join(" "));
    await sendKeys(title, attempts[i]);
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline && !live) {
      await new Promise((r) => setTimeout(r, 700));
      live = await captureLive();
    }
    elog(`attempt ${i + 1} capture`, String(live));
  }
}
if (!live) {
  elog("RESULT", "no live capture after keyboard drive — 游戏可能无存档或键位不匹配；"
    + "标题界面下 item.set/skill.learn 的报错见上。GUI 静默吞错已确认是用户体验缺陷。");
  process.exit(3);
}

// --- phase 3: in-game, mutations must take effect ---------------------------
elog("--- phase 3: in-game mutations (live capture)");
const p0 = await cmd("party.info", {});
elog("party.info", JSON.stringify(p0.payload).slice(0, 200));
const set5 = await cmd("item.set", { kind: "item", id: 1, count: 5 });
elog("item.set #1 -> 5", set5.ok ? `count=${set5.payload.count}` : `error=${String(set5.error || "").split("\n")[0]}`);
const list = await cmd("item.list", {});
const got = list.ok && list.payload.entries.find((e) => e.kind === "item" && e.id === 1);
elog("item.list read-back", got ? `${got.name} x${got.count}` : `missing (${list.ok ? "not in list" : list.error})`);
const gold = await cmd("gold.set", { value: 98765 });
elog("gold.set 98765", gold.ok ? `gold=${gold.payload.gold}` : `error=${String(gold.error || "").split("\n")[0]}`);
const ainfo0 = await cmd("actor.info", { id: 1 });
elog("actor.info #1", ainfo0.ok ? JSON.stringify(ainfo0.payload.actor).slice(0, 160) : `error=${String(ainfo0.error || "").split("\n")[0]}`);
const learn = await cmd("actor.skill.learn", { id: 1, skillId: 10 });
elog("actor.skill.learn #1 skill 10", learn.ok ? JSON.stringify(learn.payload).slice(0, 120) : `error=${String(learn.error || "").split("\n")[0]}`);
const ainfo1 = await cmd("actor.info", { id: 1 });
const hasSkill = ainfo1.ok && JSON.stringify(ainfo1.payload).includes('"id":10');
elog("skill read-back has 10?", String(!!hasSkill));
elog("RESULT", "done");
process.exit(0);
