# 傲世修仙录完结定制版（Grover 壳）逆向事实清单 — 2026-09-06

本文是 grover-boot 家族的权威逆向记录（工具箱适配该家族的依据）。
落地代码：launch 路由（`app/gui/host.cjs` / `tools/rmch.mjs` /
`core/launcher.mjs` → `core/attach.mjs` 的裸启动+DLL 注入）+
`runtime/src/wmic-shim.c`（`tools/build-wmic-shim.mjs` 构建，备用）。

## 最终策略（实测验证）

**grover-boot 游戏的「启动并注入」= 裸启动真实目录的 Game.exe（无任何
flag、无 shadow）→ 等 60s 沉淀（loading.html 的自重载循环期）→ DLL 注入
一次成功。** 用户实测「先开游戏再附加」可用；工具箱路由（launch →
launchNwInjectGame）与之等价，实测注入一次成功 + ping/catalog/
assets.iconset 全通（catalog 600 物品带 iconIndex 实时返回，图标表
512×4000 解码交付）。

关键实测事实：**这台机器（Win11）上壳的自杀路径自然失效**——未通过验证的
游戏照常启动、数据自解密（Some.js 的 decipherData 自带密钥，不依赖壳的
验证产物）、标题画面可玩。而验证通过（shim 辅助）反而**武装壳的反注入**
（V8 调用渲染进程超时，注入必败）。所以 shim 是「备用」：若未来某台机器
壳的自杀路径恢复生效，再启用 shadow+shim+守卫方案（shadow-launcher 的
grover 分支保留了该实现与测试）。

## 壳架构（全部实测）

- package.json：`bg-script=loading`（29KB obfuscator.io JS，字符串明文索引）；
  `main=www/loading.html`（26KB 同样混淆的 loader 页）。游戏名「傲视修仙录」，
  页面标题「傲世修仙录」。
- `loading` 的动作：自检（self-defend）→ `nw.Window.get().on('loaded', ...)` →
  每次 loaded 都 `nw.Window.get().evalNWBin(null, 'bg_script')` —— **bg_script
  跑在当时的页面上下文里**，窗口每导航/重载一次就多一份实例。失败路径
  `location.reload()` ×3。
- `bg_script`（12KB nwjc V8 字节码，魔数 03 04 DE C0）：祖先链校验
  （`exec("wmic process where ProcessId=<pid> get ParentProcessId/value" / "get
Name=value"`，从自身 pid 向上走）、白名单 GearNT.exe/TOTALCMD/steam.exe/
  cmd.exe/explorer.exe、`localStorage.setItem IGameKingR`、文件大小监视
  （bg_script/loading/package.json/www/index.html/www/loading.html/
  www/js/libs/load-resources.js + www 下 .css/.wasm/.data/.html/.json/.node，
  大小运行期不变即可）、`mmt`(1.2s) 与 `modulesMmt`(15s) 两个 interval、
  crashLog/crashBrowser/quit/showDevTools、`isReady`（Promise 链上的就绪检查，
  对某数据做 `/\d+/` match）。
- `www/loading.html` 的 loader → evalNWBin `www/js/libs/load-resources.js`
  （Grover 的窗口管理/检查库：cWindowId/cWindow/_loadCount、checkTimer、
  chrome.runtime.reload、Window.open www/index.html（base64
  `d3d3L2luZGV4Lmh0bWw=`）、process.kill/ppid、crashLog、performance.timing
  反调试）。校验不过 → **~200ms 一次 chrome.runtime.reload 整应用重载死循环**，
  cWindowId 递增到 ~61 后放弃——**放弃后照常前进到 index.html 引导载荷**
  （本机壳自杀路径失效，游戏可玩）。
- `www/index.html`：内联混淆 loader，XHR 取引擎 js → `evalNWBin(ArrayBuffer)`，
  先 video-main.js（内嵌 node-watch 库 oneprice.js 的 watcher +
  `process.report.getReport().sharedObjects` DLL 检测）、oneprice.js，然后
  rpg_* 全家 + ~60 插件 + **Some.js**（35KB，最后一个插件，载荷侧 DRM 伴生：
  decipherData 数据解密、getPassword/passwordIsValid/nodeCrypto/signature/
  privateKey、localStorage.setItem IGameKing、compareManifest/AppManifest/
  coreFiles（Game.exe/nw.dll/node.dll 等哈希清单）、navigator.plugins
  "Native Client" 检查、process.versions.nw-flavor、inWinmm/HackLoaded 注入
  检测、crashRenderer 自杀、boot_CheckPlayerLocation/_Scene_Boot_initialize
  包装、`document.currentScript.src` 依赖（evalNWBin 下必 null →
  「加载 js/plugins/Grover_GameOptimization.js 插件失败」为 2024 年起的
  良性固定报错）。
- data/*.json：ASCII hex 文本 → 二进制密文（Some.js 的 decipherData 解密，
  自带密钥）。img 为标准 MV .rpgmvp。存档为标准 .rpgsave LZString。
- 图标表 IconSet.rpgmvp 解码后为 **512×4000 扩展表**（标准 MV 384×1536；
  另有 newIcon.rpgmvp 自定义表）——GUI 的列数按宽度推导，天然兼容。

## 根因与实测时间线

1. **Win11 无 wmic**（Microsoft 移除；System32/wbem、WinSxS 均无）→ 壳的
   `exec("wmic")` 探测必然失败 → fail-closed → 写崩溃日志 + quit。**但本机
   壳的自杀路径失效**（quit/crashRenderer 均未奏效），游戏未验证也照常启动。
   失败的可见症状：loading.html ~200ms 自重载循环 ~10-26s、崩溃日志追加。
2. 一切「祖先链隐身」方案（WMI 重挂、改名 helper、死父进程）无效：真正原因
   是 wmic 缺失，与祖先名字无关。
3. 旧「中和层」方案（拦 quit/crashBrowser）实测：quit 确实被拦（日志为证）但
   进程树仍死（0xC0000005）——多实例（每次 loaded 一份 bg_script）各持杀器
   竞态所致；crashRenderer（Some.js）即旧「第二杀路」真身。
4. rehost 方案（换掉 bg_script、main 直指 index.html）与 shadow+中和层方案：
   载荷在 main.js 求值后 ~0.7s 同步自旋（等壳的验证产物）——shadow 环境
   本身会让载荷卡死，放弃。
5. **wmic shim 实验（有价值的失败）**：`runtime/bin/wmic.exe` 以真 wmic 字节
   格式应答（每行 `\r\r\n` 结尾、`Node=<计算机名>` 头行、PPID 用快照真值/
   死 stub 链根植真实 explorer、Name 恒答快照真实映像名——壳对已知 pid 做
   反伪抽检：PID 4 必须答 "system"），验证链全部应答、导航、引擎全量加载。
   **但验证通过后壳武装反注入，DLL 注入的 V8 调用全部超时**——shim 路线
   整体让位给「裸启动」策略，shim 保留为备用。
6. 踩过的坑（都有对照实验）：
   - 应答缺 `Node=` 行 → 壳按固定行号取到空串 → isReady 对空串做 `/\d+/`
     match 得 null → 同步自旋冻结（100% CPU）。
   - Name(PID 4) 答 "explorer.exe" → 触发反伪（真 wmic 查 PID 4 必得
     "system"）→ 静默冻结。
   - PowerShell 版 shim 冷启动 ~200-400ms，赶不上重载循环周期 → 必须 C 纳秒
     级应答。
   - 诊断用的 JS 包装（match/exec/正则包装）会被壳的 self-defend
     `/\s+/g` 函数源码扫描盯上——实验配置必须最小化注入面。
   - 游戏主进程是「自退出 stub」：reported pid 立即消失，渲染进程的
     process.ppid 指向死 stub。
7. **GUI 图标不显示的机制**：图标由 `assets.iconset` 向游戏页面要解码表；
   「开完游戏立刻附加」时页面还在重载循环里，请求超时 → GUI 的
   iconset.js 把 failed 状态按 gameKey 永久缓存（会话内不重试）→ 游戏
   可玩后图标也不再加载。修复：failed 后 15s 冷却自动重试。

## 环境备忘

- 杀游戏：`taskkill //F //IM Game.exe`；桥日志
  `runtime/bridge-state/傲世修仙录完结定制版/{bridge.log,bg-bridge.log,state.json}`；
  shim 调用日志 `%TEMP%\rmch-wmic-shim.log`（仅诊断）。
- WS 47412，token `runtime/rmch.token`；CLI `node tools/rmch.mjs
launch|send <gameKey> <cmd> '<json>'`（gold.add 参数名 amount）。
- 壳的 `游戏插件异常.log`（Grover_GameOptimization 加载失败）是 2024 年起的
  良性固定报错，与适配无关。
- 本机 Clash Verge 常驻连接 192.168.31.88:1949（壳每 15s netstat 查的就是它），
  与查杀无关。
