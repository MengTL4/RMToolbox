# 开发文档

本文面向想改代码的人。普通用户看 [README](../README.md) 就够了。

仓库与代码内部代号为 RMCH（`window.RMCH`、`runtime/rmch.token` 等），界面品牌是「RM 工具箱」。

## 目录结构

```
core/            ESM 核心模块
  scanner.mjs        引擎(MV/MZ/XP/VX/Ace/RM2k) + 保护等级(L0-L4) + 布局识别（L4=nb-shell，只识别不注入；
                     bundled-engine 合体单脚本游戏识别为 container=nwjs-bundled）
  launch-plan.mjs    纯启动路线规划：首选、备用、阻断原因和桥接就绪条件
  launcher.mjs       注入启动（策略自动选择，RGSS 分发到 rgss-launcher）
  game-runtime.mjs   GUI/CLI 共用启动与附加入口；特殊壳裸启动路由集中于此
  bridge-sessions.mjs 桥接会话登记、列表、命令归属与事件通知
  jsonl-reader.mjs   文件通道增量读取：字节偏移、UTF-8 解码、完整行
  save-files.mjs     存档备份/恢复/删除、已知影子副本协调与 RGSS 回流
  tauri-cdp.mjs      Tauri(WebView2) 壳 MZ：exe 副本打 CDP 补丁 + 启动 + 会话（evaluate 轮询传输）
  sealed-seed.mjs    sealed 启动器 MZ：CDP 堆扫描(Runtime.queryObjects)发布引擎对象 + initialize 保鲜补丁 + reload 看门狗
  cdp-client.mjs     零依赖 CDP 客户端库（/json 列表 + RFC6455 + Runtime.evaluate）
  shadow-launcher.mjs 策略B：影子目录 + 补丁 bg-script + 环境伪装
  rgss.mjs           RGSS(XP/VX/Ace) 识别(Game.ini Library 字段) + shadow 构建 + 脚本注入
  rgss-launcher.mjs  RGSS 启动 + 文件轮询传输层 + 会话注册表 + 存档回同步
  rgss-marshal.mjs   最小 Ruby Marshal 读写（Scripts 归档条目字节级拼接）
  rgss-archive.mjs   RGSSAD v1/v3 加密归档索引解析/提取/打补丁（v3 免重建；v1 字节流重写；v2 拒绝）
  rgss-savecode.mjs  save.contents.apply 的 tagged JSON 树 → Ruby 源码 codegen
  evb-unpack.mjs     Enigma Virtual Box 单文件壳：.enigma1/.enigma2 段识别 + VFS 树解析 +
                     全量解包（evbunpack 的 Node 移植，raw-only；aPLib 压缩镜像会明确报错）
  attach.mjs         附加到已在运行的游戏（MTool 式 DLL 注入：MV/MZ 走 v8 符号 hook eval，
                     RGSS 走 SetWindowsHookEx + RGSSEval，旧 DLL 回退 rb_eval_string_protect）
  ws-server.mjs      零依赖 RFC6455 WebSocket 服务器（127.0.0.1:47412，token 鉴权）
  bridge-bundler.mjs runtime/bridge/src/parts → page-bridge.js 组装（含构建期语法校验）
  gui-bundler.mjs    ESM core → app/gui/gui-bundle.cjs（NW 窗口 require 不支持 ESM）
  setup-gui-runtime.mjs  官方 NW 运行时下载、SHA-256 校验与安装
app/gui/         NW.js GUI（官方运行时重命名为 RMToolbox.exe，窗口图标 icon.png）
  index.html         页面骨架（vendor 加载 + UMD 屏蔽）
  host.cjs           Node 上下文宿主（BridgeServer / game-runtime / 备份 / 锁文件）
  gui-bundle.cjs     core/*.mjs 的 CJS 打包（生成物，勿手改）
  vendor/            vendored vue.global.prod.js + naive-ui.prod.js + jsoneditor/
  ui/                启动保护、主题、Naive 兼容层与挂载点
    modern.js          Vite 编译的完整前端（生成物，勿手改）
    store/             现有业务状态切片（core / library / trainer / data / locks / saves）
  src/               TypeScript 入口与 Vue 单文件组件
    main.ts            统一模块入口、共享 store 初始化、集成注册表
    host.ts            NW 原生宿主类型边界与加载检查
    state/drafts.ts    按游戏/字段隔离的类型化草稿状态
    shell/             应用外壳、图标、主题容器
    components/        Delta 数值编辑、InjectionGuide 注入提示
    parts/             列表、选择器、图标缓存与 JSON 编辑器
    panels/            修改器卡片
    views/             游戏库、修改器、数据及其子页、存档、控制台、日志
runtime/bridge/  注入游戏的通用 bridge（同时就是 --load-extension 的扩展目录）
  manifest.json      扩展清单（manifest_version 2）
  content.js         content script：把 page-bridge.js 注入页面上下文
  page-bridge.js     生成物，勿手改（见下）
  src/parts/*.js     bridge 源码，按职责分片
  profiles/<gameKey>.js  按游戏扩展包（可选）
runtime/bridge-state/<gameKey>/   state.json / bridge.log / commands.jsonl / events.jsonl
runtime/locks/<gameKey>.json      数据锁定集合（「保存锁定状态」写这里）
runtime/shadow-apps/<gameKey>/    策略B 影子目录
runtime/rgss-bridge/bridge.rb     注入 RGSS 游戏的 Ruby bridge（镜像 MV/MZ 命令词汇，须兼容 Ruby 1.8.1）
runtime/rgss-shadow/<gameKey>/    RGSS shadow 副本（junction+hardlink，每次启动重建，不入库）
runtime/inject/  attach 用的原生注入层（MTool 式 DLL 注入）
  src/              injector.cpp（CreateRemoteThread / SetWindowsHookEx 两种投递）+
                    mvhook.cpp（v8 符号解析 + Script::Compile/Run detour）+
                    rgsshook.cpp（RGSSEval，回退 rb_eval_string_protect）+ 自测用 test-target/test-echo
  bin/<arch>/       预构建产物（rmch-inject.exe / rmch-mvhook.dll / rmch-rgsshook.dll，
                    win32+x64 双架构，**已提交入库**——没装 MinGW 也能打包 Release；
                    obj/ 中间产物不入库）
  third_party/minhook/  vendored MinHook（detour 引擎，上游源码原样拷贝）
runtime/rgss-attach/<gameKey>/    RGSS attach 的文件通道目录（不落在游戏目录里）
runtime/profiles/<gameKey>/       策略A 游戏的私有 Chromium profile（按游戏隔离单实例锁）
runtime/screenshots/              cdp.mjs 调试截图
tools/           CLI（rmch.mjs / send.mjs / serve.mjs）、setup/launch 脚本、测试、验收驱动、
                 gui-check.mjs（GUI 预检）、cdp.mjs（零依赖 CDP 客户端）、
                 winshot.py（窗口截图，被遮挡的 NW.js 窗口也能截）、
                 bake-icon.mjs（零依赖图标烘焙：SDF 栅格化 → app/gui/icon.png）、
                 rgss-probe.mjs（RGSS 冒烟测试）、rgss-dump-scripts.mjs（脚本 dump）、
                 _probe-shadow-cmd.mjs（对运行中的 RGSS shadow 实例发 bridge 命令）、
                 _probe-tauri-cdp.mjs（对运行中的 Tauri 游戏 CDP 端口发 eval 探针）、
                 evb-unpack.mjs（EVB 单文件壳解包 CLI，核心在 core/evb-unpack.mjs）、
                 _probe-ess-cmds.mjs（Pokemon Essentials 命令面实机验证）、
                 _probe-ess-actor.mjs（Essentials 队伍宝可梦详情/改招/异常状态实机验证）、
                 _probe-ess-storage.mjs（Essentials 存储箱存取/新建宝可梦实机验证）、
                 _probe-ess-debug.mjs（Essentials 调试菜单 $DEBUG/pbDebugMenu 实机验证）、
                 _probe-gui-actor.mjs（GUI 端到端：数据›角色渲染 + 页面错误过滤）、
                 _probe-evb-launch.mjs（EVB 识别→解包→rgss-script 启动全链）、
                 build-inject.mjs（MinGW 双架构构建 runtime/inject/）、
                 test-rgss-*.mjs（Marshal/归档/hook/存档/存档树编辑测试）、
                 test-attach.mjs（attach 单元：PE 解析/bootstrap 组装/管道分帧回环）、
                 test-inject-selftest.mjs（注入器 + 双 DLL 对自测目标进程的真机回路）、
                 test-tauri-cdp.mjs（Tauri 补丁/扫描 fixture 测试）、
                 test-nb-shell.mjs（NB 壳识别 + 拒绝路径 fixture 测试）、
                 e2e-tauri.mjs（Tauri-CDP 实机冒烟，需 Demon forest 或重装机兵：黎明 游戏本体）、
                 pack-release.mjs（Release zip 打包）
```

## 构建与测试

```powershell
npm ci                                   # Node >= 22.12；按 package-lock.json 安装构建工具
npm run gui:build                        # 生成 core CJS 和 Vite 前端 bundle
npm run typecheck                        # TypeScript / .vue 类型检查
npm run gui:setup                        # 安装 nw-runtime.lock.json 指定的官方 NW.js
npm run test:gui-runtime                 # 真实 NW 无窗口冒烟，不连接真实游戏
npm test                                 # 自动构建前端，再跑类型检查、宿主边界及完整回归
                                         # + attach 单元 + 注入自测 + tauri-cdp/nb-shell fixture + GUI 预检
npm run test:rgss                        # 只跑 RGSS 单元测试（设 RMCH_RGSS_SAMPLES 环境变量可启用真实归档用例）
npm run test:inject                      # 只跑 attach 单元测试 + 注入自测（预构建二进制已入库，无编译器也能跑）
npm run build:inject                     # 重建 runtime/inject/bin（需要 MSYS2 MinGW 工具链，见下）
node tools/gui-check.mjs                 # 只跑 GUI 预检（模板编译 / store 引用 / vendor 校验）
node tools/smoke-runtime-readonly.mjs <gameRoot> [--bundle] [--attach]
                                         # 只读实机冒烟（ping / runtime.info / catalog / 会话关闭；不改存档）
node tools/m2-acceptance.mjs <gameRoot>  # 全链路验收（启动→连接→命令→退出）
node tools/rgss-probe.mjs <gameRoot>     # RGSS 冒烟测试（注入→启动→连桥→读写数据）
npm run build                           # 检查、构建、安装官方 NW、实测 staging、生成 ZIP + SHA256
```

注意：`output/release/RMToolbox/` 是打包的 staging 目录，**每次打包都被整个删掉重建**
——不要从那里运行工具箱（2026-08-29 实测：打包中途从 staging 启动游戏，扩展目录被
删到一半，老 NW 静默跳过 --load-extension，表现为「游戏能起但 bridge 永远不连」）。

`build:inject` 用 MSYS2 的 MinGW 工具链（x86 与 x64 两套都要，链接器必须是 lld——
MSYS2 binutils ld 2.46 链 mvhook 时段错误）：

```powershell
pacman -S mingw-w64-i686-gcc mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-lld
```

四个游戏的验收记录见 [ACCEPTANCE.md](ACCEPTANCE.md)。RGSS（XP/VX/VX Ace）支持的
完整实现细节、踩坑记录与实测矩阵见 [RGSS-HANDOVER.md](RGSS-HANDOVER.md)。

## GUI 技术栈（Vue 3 + Naive UI，渐进引入 TypeScript / Vite）

界面保留 **Vue 3.5.13 + Naive UI 2.35.0**，运行时 bundle 位于 `app/gui/vendor/`。
**全部 28 个应用组件已迁入 `app/gui/src/` 的 `.vue` 文件**：24 个模板在构建期编译，
另 4 个保留渲染函数。页面之间直接 `import` 组件，已移除旧的字符串模板和 22 个注册脚本。
`main.ts` 统一引入状态切片和组件，Vite 输出 `ui/modern.js`；HTML 只负责 vendor、启动保护、
完整前端 bundle 和挂载点。Vue 被声明为外部依赖，继续使用同一份全局 Vue 和 store。
`RMCH.parts/views` 保留为挂载与回归测试的集成入口，组件不再依赖这个注册表寻找其他组件。
宿主接口和按游戏隔离的草稿状态已使用 TypeScript；其余业务切片和多数 SFC 的脚本仍使用
JavaScript，保持 `allowJs` 互操作，后续按业务逐个补全类型。这里不代表整个项目已全量类型化。
`npm run gui:build` 同时构建核心 CJS 与前端。`npm test` 的 `pretest` 自动刷新前端构建。
主题 token 在 `ui/theme.js`，布局样式在 `styles.css`，保留深浅主题。

前端调用原生代码统一经 `src/host.ts` 获取宿主，使用 `window.require` 保持 NW 页面的路径解析，
避免 Vite 将 Node 宿主打进浏览器包。引擎命令载荷保持动态协议，类型边界返回 `unknown`，
不伪造所有游戏都返回同一种数据。`test-gui-host-boundary.mjs` 对照真实 CJS 导出核验接口。

`npm run test:ui-browser` 覆盖 14 个页面/子页 × 2 个主题 × 2 个尺寸，共 56 组渲染，
并验证两种注入入口、手动进入修改器、草稿/应用、断线/重连和 JSON 编辑器挂载。
这是受控宿主验证，不启动真实游戏。`npm run build` 对 staging 做真实 NW 冒烟后压缩，
再逐文件对比 ZIP 与 staging 的 SHA-256；校验成功才替换上一份 ZIP，并生成 `.zip.sha256`。

运行时与边界：

- **GUI 固定 NW.js 0.115.0 / Node 26.7.0 / Chromium 152.0.7977.42**，版本、官方 URL 和
  SHA-256 记录在根目录 `nw-runtime.lock.json`。下载失败或哈希不匹配会停止安装；缓存亦会复核。
  不再从本机游戏或 modkit 借运行时。游戏 NW.js 与 RGSS Ruby 1.8 兼容边界独立，注入脚本仍须兼容它们。
- **Naive UI 暂留 2.35.0**：此次先更新宿主与构建链，组件库升级另行验证。
  `test:gui-runtime` 在锁定 NW 中验证原生文件读写、CJS 宿主、临时端口桥接、SFC 渲染与提交行为。
- **Naive UI 和 jsoneditor 都是 UMD**，而 NW.js 会把 `module`/`exports` 注入页面，会让它们走
  `require("vue")` 分支挂掉；`index.html` 在加载 vendor 期间临时屏蔽这几个全局变量。
- **jsoneditor 10.4.3（完整版，含 ace + ajv）** vendored 在 `app/gui/vendor/jsoneditor/`；
  它自带真样式表和图标 sprite（`img/jsoneditor-icons.svg`，相对路径不能动），主题覆盖在
  `app/gui/jsoneditor-theme.css`——那是「views 不写组件 CSS」规则唯一的例外，因为 Naive
  的 CSS-in-JS 够不到第三方 DOM。

`node tools/gui-check.mjs` 会把这些约束、"每个模板都能编译"、"标签成对"、"视图引用的 store
成员都存在" 一起卡住，跑在 `npm test` 里。调试实机界面用 `node tools/cdp.mjs`（零依赖 CDP
客户端，需要 `--remote-debugging-port=9222`）：

```powershell
node tools/cdp.mjs eval "window.RMCH.store.trainer.gameKey"
node tools/cdp.mjs click ".n-dropdown-option"   # 真实鼠标事件（Naive 的弹层不吃合成事件）
node tools/cdp.mjs key "ctrl+shift+z"           # 真实按键（jsoneditor 的撤销栈挂在 keydown 上）
node tools/cdp.mjs shot runtime/screenshots/library.png 1180 820
```

## bridge 的分片结构（改之前先读这段）

`page-bridge.js` 是**一个**注入页面的经典 script，所以 `src/parts/*.js` 不是模块 ——
它们是同一个函数体的片段，共享一个闭包：`00-prelude.js` 打开 IIFE，`90-startup.js` 闭合它。
数字前缀就是 concat 顺序，改顺序会改语义（后面的 part 在模块作用域调用前面的）。

这个设计是有意的（游戏里不带打包器、不泄漏全局、钩子对游戏代码不可见），但有一个尖角：
任何一个 part 里多一个花括号，产物就是语法错误，而症状是「游戏启动了，没有 bridge，也没有报错」。
所以 `core/bridge-bundler.mjs` **拒绝写出它无法证明能解析的产物**，并且会指名道姓：

- PARTS 列表必须和目录内容完全一致（防止新建的 part 被静默忽略）
- 每个 part 单独解析 → 报错直接给文件名
- 拼接后整体解析 → 报错行号映射回所属 part（能抓到「两个 part 各声明一次同名 const」）
- `@rmch-iife-open` / `@rmch-iife-close` 标记必须只在首尾各一处

分片一览（每个文件顶部注释写了它为什么存在）：

```
00-prelude   IIFE 开头 + bridge 状态对象       40-hooks          patchMethod + 倍率/遇敌/移速/技能消耗 + 坏 global 档守卫
05-node-io   require/路径/log/event            45-vitals-locks   上帝模式：HP/MP/TP 锁
10-engine    TK.$ 别名解析、$game*/$data*      50-value-locks    数据锁定：逐帧回写
20-values    强转/守卫/抑制作用域/统计         55-transport      WS 客户端 + JSONL 兜底 + CDP outbox
25-battlers  battler/队伍/敌群、actorInfo      58-state          state.json 快照
30-catalogs  目录缓存、背包槽位、地图          60..68-commands-* 命令，按领域分片
                                              69-router         冻结命令表 + execute()
                                              70-profiles       per-game profile 加载器
                                              90-startup        定时器 + IIFE 闭合
```

**两种「锁」不要搞混**（名字很容易踩）：

- `bridge.options.lockHp / lockMp / lockTp` = 上帝模式，靠方法钩子 + 100ms 守卫循环，
  在 `45-vitals-locks.js`。
- `bridge.valueLocks.{item,weapon,armor,switch,variable,gold}` = 数据锁定，靠
  `SceneManager.updateMain` 里逐帧回写，在 `50-value-locks.js`。

命令表是切片式的：`00-prelude.js` 建 `commandHandlers`，每个 `6x-commands-*.js` 用
`Object.assign` 挂自己的领域，`69-router.js` 冻结它（所以 profile 能扩展、不能覆盖核心命令）。

## 注入策略（均不改游戏原文件）

路线选择由 [LAUNCH-ROUTE-DESIGN.md](LAUNCH-ROUTE-DESIGN.md)、`core/launch-plan.mjs`（判定）和
`core/launch-routes.mjs`（唯一路线目录：id / 中文名 / 用户目标短句 userGoal / 投递机制 / preflight；GUI 的路线标签全部由它派生，不另存标签表）统一规划。
先按游戏壳选出启动路线（机制只是路线的属性），再由对应运行时适配器确认 bridge hello、运行时对象和存档路径；
不要把“进程出现”或“DLL 返回成功”单独当成适配完成。

- **策略 A（extension）**：原版 Game.exe + `--load-extension=<bridge扩展>`（MV/MZ 默认）。
  附带私有 `--user-data-dir=runtime/profiles/<gameKey>`（持久、按游戏隔离）——大量游戏
  manifest 都叫 `rmmz-game`，共享 profile 会让「单实例检测」杀掉后启动的游戏、以及
  新版 NW 写过的 profile 弄坏旧版游戏。**spawn 不能开 `windowsHide`**：它会往子进程的
  STARTUPINFO 写 SW_HIDE，NW.js 0.29 时代的老 MV 游戏用 `SW_SHOWDEFAULT` 建窗口、直接
  继承成隐藏窗口（页面照跑、bridge 照连，但用户永远看不到游戏）。
- **策略 B（shadow）**：bg-script 启动链游戏专用 —— 影子目录（硬链接+Junction）+ 补丁版 bg-script +
  `process.cwd/execPath/nw.App.manifest` 环境伪装，对付检测/杀扩展的游戏。影子 `save/` 始终 junction
  回真实游戏根（root 布局重建时先把影子残留存档按 mtime 较新者胜合并回去），存档读写直达真实目录。
  bg-script 在子目录（如 `bg_script/boot.js`）时该路径会从链接树里抠出来、在影子内重建真实目录——
  隔着 junction 写补丁会改掉游戏原文件
- **RGSS（rgss-script）**：XP/VX/VX Ace 专用。shadow 副本（目录 junction + 文件 hardlink，
  加密归档用真实副本）里往 Scripts 归档插一个 Ruby bridge 条目，位置在调用 `rgss_main`
  的条目之前（它之后的代码永远不会执行）。通信走 shadow 目录里一对 append-only 文件
  （RGSS 精简 Ruby 没有 socket 库）；游戏退出时把 shadow 里的存档同步回真实目录。
  mkxp-z（Ruby 3.x）跑 RGSS1 也行（实测宝可梦赤途 / Pokemon Essentials v21），注意
  **插件晚加载会覆盖桥的 Graphics.update 包装**（Essentials 的 Transitions 脚本与
  Main 里 PluginManager 加载的插件都重定义它）——桥的包装带身份校验
  （$rmch_graphics_wrapper），初始安装 + 300 帧巡检 + 每条命令处理前兜底重装；
  Essentials 的 pbMessage 循环走 Scene_Map#miniupdate 不走 #update，两处都要挂钩。
  细节见 [RGSS-HANDOVER.md](RGSS-HANDOVER.md)
- **EVB 单文件壳（evb-unpack-rgss-script）**：Enigma Virtual Box 打包的 RGSS 游戏
  （一个几 GB 的 exe 内含完整游戏树，实测宝可梦赤途）。scanner 按 exe 里的
  `.enigma1`/`.enigma2` 段识别（`container: "evb"`）；launcher 的 GUI 路径使用
  `core/evb-unpack.mjs` 的 `ensureEvbUnpackedAsync` 解包到 `<exe去后缀>_unpacked/`
  （已有 Game.exe 则复用），把原始目录的 save/ junction 进解包目录，之后完全走
  rgss-script 链（gameKey 仍用原始目录名）。解包器是 Python evbunpack 的 Node
  移植：只支持 raw（未压缩）镜像，aPLib 压缩会明确报错；EVB 文件记录的可选块是
  53 字节（stored_size 在偏移 49），不是旧文档说的 39。
- **Tauri（tauri-cdp）**：Tauri/WebView2 壳打包的 MZ 游戏（YanBin RPG Maker Builder 系列，
  实测 Demon forest/魔物召唤森林、重装机兵：黎明）。
  没有 NW.js、没有 www/ 目录、页面源是 `http(s)://tauri.localhost/`（两种 scheme 都
  存在：Demon forest 是 https，重装机兵：黎明是 http——匹配用 `TAURI_PAGE_PREFIXES`
  数组/`isTauriPageUrl()`，写死单一会 waitForTauriPage 超时），常规三条路全堵死。
  入口在 WRY 写死的 WebView2 浏览器参数：把 game.exe **复制**成 `game.rmch-cdp.exe`
  （原文件不动），将整段参数字符串等长覆写成 `--remote-debugging-port=<port>`+空格填充
  （WRY 会乱序重拼并截断到 ~105 字节，原 token 一个都不能留）。启动副本即得到
  127.0.0.1 上的 CDP。**两个实测杀机**：① 启动后 ~2s 内碰 DevTools HTTP 端点游戏立即
  退出（先等 BOOT_GRACE_MS=5s 再轮询）；② 页面看门狗检测到 `Runtime.enable` 会在
  毫秒内杀进程（Inspector.detached → exit 0）——所以传输只用 `Runtime.evaluate`：
  页面出站消息堆 `window.__rmchOutbox` 由宿主 250ms 轮询取回，入站走
  `window.__rmchDispatch` eval。bridge 在无 Node 环境降级运行（无 fs，
  save.list 由宿主侧直接读存档目录应答）。不支持 attach（无法事后开 CDP）。
- **NB 壳（nb-shell，不支持）**：`nb_data/nbtool.node`（Themida 加壳原生模块）+
  index.html `bootEncryptedBin()` 指纹（重装机兵-宿敌家族）。引擎与数据全部加密在
  nb_data/，登录页之后才引导。scanner 识别为 `container: "nb-shell"`、保护级别 4，
  launcher/attach 在任何动作之前直接拒绝。**不要试图注入**：实测定性（ACCEPTANCE
  v0.6.3，每条都有对照）——启动旗标零容忍（任意额外参数 ~3s 干净退出）、祖先进程
  链有 node.exe 即杀（改名即可绕过，按名不按行为）、package.json/index.html 哈希
  校验（无关字段/纯 noop 标签同样死，TOCTOU 换回无效）、DLL 注入事件检测（注入
  本身必成功、bridge 必连上、游戏 ≤6s 必被杀——杀的是加载事件，事后清理无效）、
  影子副本要求父进程常驻。五条递送路全死，拒绝是唯一正确行为。
- **sealed 启动器（extension-cdp-seed）**：引擎整体混淆进一个 IIFE、由 Vite 启动器页
  eval 的 MZ 游戏（停不下来的轮回家族）。页面（本身是 chrome-extension:// 页）上没有任何
  引擎全局，扩展注入的 bridge 起得来但 resolver 全空。启动时给游戏进程加
  `--remote-debugging-port` 并派一个 detached seeder（`core/sealed-seed.mjs` +
  `tools/seed-sealed.mjs`）：自动点掉启动器的「开始游戏」按钮，等 `__PIXI_APP__` 出现后用
  `Runtime.queryObjects` 全堆扫描（~31 万对象），按字段形状捞 `$game*`/`$data*`/管理器
  单例发布到 window（坑与判别式见 ACCEPTANCE v0.6.0：switches/vars 靠 `value(999999)`
  越界读区分、物品表无 atypeId、模板副本表取第一份；manager 多为函数形式——
  BattleManager/JsonEx/ImageManager 都在函数分支找）。堆里有多代副本时形状猜不可靠，
  **单例以 `DataManager.makeSaveContents()` 的返回为准**（闭包活引用）。保鲜两条腿：
  原型 `initialize` 包装（新游戏重建时重发布）+ `DataManager.extractSaveContents`
  包装（读档 / save.contents.apply 后重发布活集合；不能用 JsonEx._decode——存档
  预览也会解码完整树，会把引用劫持到预览副本）。游戏进程带 `RMCH_SEALED=1`，bridge 的 hook
  重试不封顶（先快后慢、5s 永久慢重试）。**自建主循环陷阱**：这类游戏可能完全不调
  `SceneManager.update`（实测 2s 内 0 次），updateMain 包装器上的每帧路径（值锁、
  按住 Ctrl 加速）不会跑——值锁已有 100ms 心跳兜底（90-startup），加速无解，已记录。
  seeder 播种后**常驻为 reload 看门狗**：F5/崩溃重启会抹掉全部发布对象（连保鲜补丁
  一起），看门狗发现 `__rmchSealed` 消失即自动重播种（含点开始按钮），游戏关闭
  （CDP 消失 90s）才退出。派 seeder 必须经 `startSealedSeeder`（launcher.mjs）：
  **GUI（NW.js）里 `process.execPath` 是 GUI 壳 exe 而非 node**，直接 spawn 会静默
  失败——该函数按「execPath 是 node → PATH 上的 node → 进程内兜底」解析。
  种子日志在
  `runtime/bridge-state/<gameKey>/seed.log`。attach 对这类游戏是**接管式**（`attachSealed`）：
  停掉该游戏目录下的运行进程（手工启动的实例没有调试端口，无法事后播种），再走标准
  sealed 启动路径，游戏自动续上最后存档。
- **bundled 引擎（shadow-engine-publish）**：整个 RPG Maker 运行时合体成单个经典
  脚本、裹在一个 `(function(){...}.call(this))` 包装闭包里的 MV/MZ 游戏（命运II
  离线版家族）——window 上没有任何引擎名字（$data*/$game*/管理器全部闭包内私有），
  且这类老 NW.js（实测 0.29）二进制里根本没有 devtools HTTP server（命令行与
  chromium-args 的 --remote-debugging-port 都无效），sealed 堆扫描路不适用。
  影子目录里把引擎脚本换成补丁副本：在包装闭包收尾 `}.call(this);` 前插入发布
  片段（锚点缺失退 `__nbTrainerAPI=`，再缺明确报错）——管理器/类静态发布，
  $data*/$game* 用 getter 访问器发布（开局/读档整体替换，静态发布会立刻过期），
  之后就是普通 MV/MZ。附加=接管重启（影子补丁只能经启动生效）。实测见
  ACCEPTANCE v0.7.3。
- **附加（attach，不改文件也不启动游戏）**：游戏已在运行时注入。MV/MZ：`rmch-mvhook.dll`
  经 CreateRemoteThread 进渲染进程，MinHook detour 住 nw.dll 导出的 `v8::Function::Call`
  （Blink 每帧 rAF 必经；`NewFromUtf8` 留作后备），在自然的 V8 调用点里
  `Script::Compile+Run` 一段 bootstrap——设好 RMCH_* env 后 indirect-eval `page-bridge.js`，
  之后走普通 WS 通道。bootstrap 在非游戏 context（NW 扩展背景页等）会主动 throw，
  DLL 看到空结果就释放 claim、限频 400ms 等下一个 context 重试。**评估完成（或彻底失败）
  后 DLL 立即 FreeLibraryAndExitThread 自卸载**——带保护的游戏（再刷一把 / 梦魇无归 /
  潜龙在渊）有周期性的模块完整性扫描，发现常驻外来 DLL 就主动崩溃（crashpad dump，
  异常码 0xE0000008）；纯 JS 的 bridge 它们不查，所以启动注入（扩展路径）不受影响。
  同一理由，attach 逐个渲染器尝试、**成功即停**（普通渲染器优先，`--extension-process`
  的排后——再刷一把这类把游戏本体打包成 chrome-extension 页面的游戏只有后者）。
  RGSS：`rmch-rgsshook.dll`
  经 SetWindowsHookEx 挂进游戏主线程，优先用引擎导出 `RGSSEval`（RGSS3 只导出引擎 API，
  没有 Ruby C API；RGSS1/2 时代 DLL 回退 `rb_eval_string_protect`）执行渲染过的
  `bridge.rb`，文件通道放 `runtime/rgss-attach/<gameKey>/`。注意 RGSSEval 的 cref 不是
  Object——bridge.rb 顶层方法必须 `Object.send(:define_method)` 显式挂载；场景泵钩子
  要覆盖所有自带 `update` 的 Scene_Base 后代（自定义引擎的子类可能不 super），且包装器
  必须调用 hook 时捕获的 **UnboundMethod** 而非按名调别名——父子类同 hook + 子类 super
  会让按名调用在两层包装器间无限递归（SystemStackError）。
  **x86/x64 的 v8 ABI 都已实测**：`Local<T>`/`MaybeLocal<T>` 因带用户构造函数，两架构都走
  隐藏 out 指针返回（x86 在 this/首参之前，x64 在 RCX 之后的 RDX），按值传参的 Local 则
  直接压栈原始句柄值。v8 符号名从 nw.dll 导出表按 mangled 前缀解析，覆盖 NW.js ≥ 0.13 的
  MV/MZ 游戏；杀毒软件可能对注入器误报（README 已写明）。

## 窗口显示看门狗（90-startup.js）

带启动保护的游戏普遍 `package.json` 里 `window.show=false`，靠启动链跑完后自己
`nw.Window.get().show()`。启动链一旦中途卡死，进程活着、bridge 连着（物品能列出来）、
BGM 在放，但窗口永远不出现。bridge 在窗口从未可见期间每 1.5s 补一次 `show()`（以
`document.visibilityState` 判定，见过一次 `visible` 就永久撤防，30s 后定时器也停），
不会和用户最小化/游戏主动隐藏打架。

## 通信

bridge 是 WS 客户端，连 GUI/serve 的 `127.0.0.1:47412`（URL 携带 `runtime/rmch.token`）。
断线指数退避重连；`runtime/bridge-state/<gameKey>/commands.jsonl` 文件队列作为兜底通道。
命令结构化返回 `{ok, payload|error}`；handler 可同步或异步（MV/MZ 均支持）。

有的游戏页面根本开不了 WebSocket（新版 NW.js 的扩展页 CSP / Private-Network-Access
拦截 `ws://127.0.0.1`，实测：潜龙在渊）——bridge 静默退回文件队列。服务器侧做了
**文件通道收养**：`BridgeServer` 传入 `stateDir`（host.cjs 与 serve.mjs 都传了）后，
周期性扫描 `runtime/bridge-state/*/state.json` 的新鲜度（bridge 每秒重写），把活着的
文件通道 bridge 收养成与 WS 会话同接口的 FileSession（describe/sendCommand 一致，
`transport: "file"` 标记），命令经 commands.jsonl 下发、events.jsonl 收结果；
state.json 变陈旧（游戏退出）即摘掉。WS 会话优先于同名收养会话，但有两条防僵尸规则
（实测：保护游戏的冻结渲染器会持有 pong 正常、命令永不应答的半死 WS）：
WS 会话的 cmd 一旦超时即被剔除（给收养/重连让位）；已有新鲜文件会话时，新 WS 连接
必须先应答一次应用层 `ping` 探测（8s）才允许转正顶替，否则安静丢弃。

RGSS 不走 WS：`runtime/rgss-shadow/<gameKey>/` 里的 `rmch-cmd.jsonl` / `rmch-res.jsonl`
append-only 文件对。bridge.rb 镜像同一套命令词汇（同名同 payload）。RGSS 与 MV/MZ
文件通道共用 `JsonlReader`，各自解释消息；RGSS 从头读取 hello，MV/MZ 收养时从文件末尾
开始，跳过历史事件。读取器保留未完成的 UTF-8 字符和行；观察到截断或文件替换时重置。
同一文件在两次轮询之间截断后又长到原偏移以上，仍无法仅凭文件大小判断，协议应使用追加写入。

### 启动入口与会话归属

`gameRuntime.launch/attach` 是 GUI/CLI 共用的入口。它在 launcher 和 attach 之上集中选择
特殊壳的裸启动路线；attach 内部仍可调用 launcher 完成接管重启，保持 GUI 打包依赖无环。
低层 `launchGame` 对不适用的壳保留防御性拒绝，直接使用低层入口的脚本行为不变。

NW 路线由 `attach.mjs` 内的 `createNwAttachment` module 完整编排。它的 interface 只有
启动与附加两种意图；目标排序、准备、重试与成功确认由 implementation 持有。内部 seam
只替换 Windows 进程操作与时间，测试仍使用真实 bridge 构建、PE 解析和 JSONL 文件。
生产入口不接受重载许可；只有本次实际启动的文件通道游戏才进入目录捕获流程。
点「启动」时发现已运行实例，也与手动附加一样不会因此触发捕获重载。

当前传输选择按游戏壳和操作集中记录，结构改动保留已有实测行为：

| 游戏壳       | 手动附加         | 启动时发现已运行 | 本次新启动       |
| ------------ | ---------------- | ---------------- | ---------------- |
| nb-evalnwbin | 文件             | 文件             | 文件             |
| enigma-nb    | WS + sealed 重试 | 文件             | WS + sealed 重试 |
| Grover       | 普通 WS          | 文件             | 文件             |

WS 以 DLL 报告执行成功为附加完成，文件路线还要确认新鲜 hello；这些成功条件不合并。
`tools/test-nw-attachment.mjs` 穿过真实编排验证上述矩阵、成功即停和启动回退，替代原来只测
spawn 子步骤的回退测试。改变传输矩阵仍需要对应家族的实机证据。

`BridgeSessions.list/send` 及其通知是宿主访问桥接会话的 interface。RGSS/CDP 在建立会话时
向 `externalSessions` 登记，由登记处统一接线与清理；宿主不再识别返回值中的会话字段。
命令查找保持 RGSS → CDP → BridgeServer 的既有顺序，列表仍保留各来源的顺序和内容。
WS/文件接管、存活探测、RGSS 存档转换、CDP 本地存档列表继续由各 adapter 负责。
CLI 启动 Tauri 后关闭其进程内会话的行为保持不变。

### 存档文件与影子副本

`save-files.mjs` module 集中主机侧备份、合并恢复、删除及 RGSS 回流；host 保留既有
interface 和存档目录查询优先级。Ruby bridge 继续拥有槽位解析、游戏内保存和加载，
并随状态报告 `saveLocation`（真实游戏根、存档目录、槽位文件名）。RGSS 启动过程将这份
定位留在影子目录的 `.rmch-save-location.json`，供异常退出后的下次启动救援使用。
没有定位信息时，只保守回流根目录及一级目录的 `SaveN` 文件；不能把 `Data/` 中同为
`.rxdata` / `.rvdata*` 的数据库和脚本归档当存档。

回流按修改时间较新者优先；同时间而内容不同，保留真实存档并在终端及 `runtime/gui.log`
报告冲突。复制失败会保留源文件，启动时的救援失败会阻止清除旧影子目录。
恢复备份保留备份之外的槽位，并更新对应独立影子副本；删除同样协调已知副本，旧副本不能
在退出或下次启动时复活。游戏随后主动保存的新内容仍然有效。退出回流在进程停止后执行。
`tools/test-save-files.mjs` 使用真实临时文件验证中文槽位、冲突、恢复/删除后的回流，以及
硬链接和 junction；有 Ruby 时还直接加载完整 bridge 验证槽位定位。

### 影子目录构建

bg-script 与 bundled 引擎的构建入口共用 `shadow-launcher.mjs` 内的 `buildShadowApp`。
该 implementation 持有存档救援 → 存档目录就位 → 链接/补丁路径隔离 → 写独立副本的次序。
即使补丁位于 `www` 内、导致 `www` 本身不能作为 junction，`www/save` 也仍指向真实存档。
旧硬链接和 junction 在写补丁或 manifest 前被解除；原游戏补丁路径经过 junction 时，
也只在影子目录中拆分。两种补丁内容、Grover 备用 shim、各自的 profile 生命周期保持独立。

改动这些路径时运行 `npm test`；新增测试包含共享路由、启动回退、会话生命周期和 JSONL
分段读取，后两者也通过实际通道的命令回环验证。实机只读冒烟见
`tools/smoke-runtime-readonly.mjs`，与会改金币或存档的完整验收脚本分开使用。

## 目录数据（关键设计）

物品/技能/地图等**不靠解密数据文件**：L1/L2 游戏自己解密后，bridge 直接从内存
（`$dataItems` 等经 `TK.$` 别名表解析）读取。缓存按表长度自动失效——游戏加载完成前后查询
都不会拿到脏数据。

## 数据页实现要点

- **数据锁定**：锁定集合存在 `runtime/locks/<游戏名>.json`，锁活在 bridge 里而不是页面里，
  所以 GUI 刷新不会丢锁。
- **存档数据编辑器**：vendored jsoneditor 10，zh-CN 语言包、`树/表单/视图/代码/文本/预览`
  模式切换，两个主按钮（`更新数据` / `应用至游戏`）通过 teleport 塞进 jsoneditor 自己的菜单栏。
- per-game profiles（`runtime/bridge/profiles/`）：游戏专属命令，通用核心不加载任何 profile
  也能跑全功能。

### 目录图标

`RMCH.iconset.useGame` 是目录图标 module 的 interface。EntryList、Picker 和 GameIcon
绑定游戏后读取可用状态与图片；本地读取、桥接回退、请求合并、缓存和失败后 15 秒主动重试
由 module 自己推进，调用方无需组合 ensure / version / state。最后一个显示方离开时
停止重试，重新进入时恢复；切换游戏目录、引擎或桥接会话会使用新的缓存身份，旧异步结果
不会覆盖当前图标。RGSS1 按名称取图及其失败恢复也在同一 module 内。
`tools/test-game-icons.mjs` 使用真实 Vue 与三个调用方，替换时间和图片来源，验证整条恢复链。

### 当前游戏与编辑草稿

页头是当前游戏选择的唯一入口，修改器、数据、存档与控制台共用选择；断开时保留目标，重新连接后刷新实时数据。`selectionEpoch` 标记选择及连接变化，命令结果和确认框不得跨 epoch 写入新上下文。主机会话回调复制快照，避免复用数组时漏掉响应式更新。

`store.useDraft` 按游戏与字段保存本窗口中的编辑值；字段包含条目或角色身份，实时状态与编辑草稿分开保存。数值加减只改草稿，Enter 或应用才提交；开关仍即时提交，但等待实际回执后显示新状态。游戏库的操作状态属于具体游戏，启动、附加、停止互斥。

完整界面决策与验收范围见 `docs/UI-REDESIGN.md`。`npm test` 包含交互回归；可另用 `npm run test:ui-browser` 运行真实浏览器的受控数据渲染与点击验证，要求 Node 22+ 和本机 Chrome。该工具不连接真实游戏，截图输出至 `runtime/screenshots/ui-review/`。
