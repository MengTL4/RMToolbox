# 傲世修仙录完结定制版（Grover 壳）逆向事实清单 — 2026-09-06

本文是 grover-boot 家族的权威逆向记录（工具箱适配该家族的依据）。
v0.7.6 落地的代码路径：`core/shadow-launcher.mjs` 的 grover 分支 +
`runtime/src/wmic-shim.c`（`tools/build-wmic-shim.mjs` 构建）。

## 壳架构（全部实测）

- package.json：`bg-script=loading`（29KB obfuscator.io JS，字符串明文索引）；
  `main=www/loading.html`（26KB 同样混淆的 loader 页）。游戏名「傲视修仙录」，
  页面标题「傲世修仙录」。
- `loading` 的动作：自检（self-defend）→ `nw.Window.get().on('loaded', ...)` →
  每次 loaded 都 `nw.Window.get().evalNWBin(null, 'bg_script')` —— **bg_script
  跑在当时的页面上下文里**，窗口每导航/重载一次就多一份实例。失败路径
  `location.reload()` ×3。这解释了旧观察「patched bg-script 在两个上下文执行」
  与「第二杀路」的多实例竞态。
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
  cWindowId 递增到 ~61 后放弃退出。
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
- data/*.json：ASCII hex 文本 → 二进制密文（解密在 Some.js 的 decipherData，
  依赖壳验证产物）。存档为标准 .rpgsave LZString。

## 根因与实测时间线

1. **Win11 无 wmic**（Microsoft 移除；System32/wbem、WinSxS 均无）→ 壳的
   `exec("wmic")` 探测必然失败 → **fail-closed**。原生双击 explorer 启动同样
   +15s 被杀（崩溃日志摘要与 node 启动死亡完全相同）——游戏在本机原样就
   玩不了，与工具箱无关（用户此前在 Win10 或别的机器玩）。
2. 一切「祖先链隐身」方案（WMI 重挂、改名 helper、死父进程）无效：真正原因
   是 wmic 缺失，与祖先名字无关。
3. 旧「中和层」方案（拦 quit/crashBrowser）实测：quit 确实被拦（日志为证）但
   进程树仍死（0xC0000005）——多实例（每次 loaded 一份 bg_script）各持杀器
   竞态所致；rehost（换掉 bg_script、main 直指 index.html）则载荷在
   main.js 求值后 ~0.7s 同步自旋（等壳的验证产物）。
4. **wmic shim 路线（v0.7.6 落地）**：`runtime/bin/wmic.exe`（C，mingw 静态
   编译）部署进 shadow 目录 + 游戏 PATH 前插 shadow 目录（exec 的 cwd 被
   prelude 欺骗到真实游戏根，cmd 按 cwd→PATH 解析，PATH 是唯一可靠入口）。
   应答格式为真 wmic 字节级仿真：**每行（含首空行）以 `\r\r\n`（CRCRLF）结尾、
   首行 `Node=<计算机名>`、UTF-16/ASCII 均可（壳用 `/[\r\n]+/g` split 后按
   行号取值）**。实测走过的最远链：probe(exec("wmic")) → PPID(自身 pid) →
   Name(<根植的 explorer pid>) 全部应答成功。
5. 踩过的坑（都有对照实验）：
   - 应答缺 `Node=` 行 → 壳按固定行号取到空串 → isReady 对空串做 `/\d+/`
     match 得 null → 同步自旋冻结（100% CPU）。
   - Name(PID 4) 答 "explorer.exe" → 触发反伪（真 wmic 查 PID 4 必得
     "system"）→ 静默冻结。**已知 pid 的名字必须答真实值。**
   - PowerShell 版 shim 冷启动 ~200-400ms，赶不上重载循环周期，回调永远
     丢失 → 必须 C 纳秒级应答。
   - 诊断用的 JS 包装（match/exec/正则包装）会被壳的 self-defend
     `/\s+/g` 函数源码扫描盯上——**实验配置必须最小化注入面**。
   - 游戏主进程是「自退出 stub」：reported pid 立即消失（walk-end 证实），
     渲染进程的 process.ppid 指向死 stub → shim 对死 pid 以真实存活的
     explorer.exe 根植祖先链。
6. **当前阻塞（v0.7.6 已知限制）**：干净 shadow + shim 下，壳验证链全部
   应答、导航到 index.html、引擎与全部插件加载、桥注入两页、进程存活
   15s+——但载荷仍在验证后的状态机里冻结（ping 超时、黑屏、0 心跳）。
   崩溃日志的失败摘要跨运行恒定
   （d0a2a2d0…2411d，含重复段 d081a0），说明壳对「祖先链数据」仍有未满足
   的校验。下一步候选：抓真 wmic 的完整输出比对（找 Win10 机器）、对
   bg_script/Some.js 做 nwjc 常量池与控制流深挖、或在 Win10 环境验证
   工具箱的整链路。

## 环境备忘

- 杀游戏：`taskkill //F //IM Game.exe`；桥日志
  `runtime/bridge-state/傲世修仙录完结定制版/{bridge.log,bg-bridge.log,state.json}`；
  shim 调用日志 `wmic-shim.log`（仅诊断构建写）。
- WS 47412，token `runtime/rmch.token`；CLI `node tools/rmch.mjs
  launch|send <gameKey> <cmd> '<json>'`（gold.add 参数名 amount）。
- 壳的 `游戏插件异常.log`（Grover_GameOptimization 加载失败）是 2024 年起的
  良性固定报错，与适配无关。
- 本机 Clash Verge 常驻连接 192.168.31.88:1949（壳每 15s netstat 查的就是它），
  与查杀无关。
