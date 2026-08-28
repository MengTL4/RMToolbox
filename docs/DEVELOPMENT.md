# 开发文档

本文面向想改代码的人。普通用户看 [README](../README.md) 就够了。

仓库与代码内部代号为 RMCH（`window.RMCH`、`runtime/rmch.token` 等），界面品牌是「RM 工具箱」。

## 目录结构

```
core/            ESM 核心模块
  scanner.mjs        引擎(MV/MZ/XP/VX/Ace/RM2k) + 保护等级(L0-L3) + 布局识别
  launcher.mjs       注入启动（策略自动选择）
  shadow-launcher.mjs 策略B：影子目录 + 补丁 bg-script + 环境伪装
  ws-server.mjs      零依赖 RFC6455 WebSocket 服务器（127.0.0.1:47412，token 鉴权）
  bridge-bundler.mjs runtime/bridge/src/parts → page-bridge.js 组装（含构建期语法校验）
  gui-bundler.mjs    ESM core → app/gui/gui-bundle.cjs（NW 窗口 require 不支持 ESM）
  setup-gui-runtime.mjs  NW 运行时 donor 链接/拷贝
app/gui/         NW.js GUI（运行时二进制链接为 RMToolbox.exe，窗口图标 icon.png）
  index.html         页面骨架（vendor 加载 + UMD 屏蔽）
  host.cjs           Node 上下文宿主（BridgeServer / scanner / launcher / 备份 / 锁文件）
  gui-bundle.cjs     core/*.mjs 的 CJS 打包（生成物，勿手改）
  vendor/            vendored vue.global.prod.js + naive-ui.prod.js + jsoneditor/
  ui/                Vue 3 + Naive UI 前端
    store/             状态与动作（core / library / trainer / data / locks / saves）
    parts/             通用组件（virtual-list / entry-list / picker / delta / json-editor）
    panels/            「修改器」的卡片（RMCH.parts.*）
    views/             每个页签一个（RMCH.views.*）
runtime/bridge/  注入游戏的通用 bridge（同时就是 --load-extension 的扩展目录）
  manifest.json      扩展清单（manifest_version 2）
  content.js         content script：把 page-bridge.js 注入页面上下文
  page-bridge.js     生成物，勿手改（见下）
  src/parts/*.js     bridge 源码，按职责分片
  profiles/<gameKey>.js  按游戏扩展包（可选）
runtime/bridge-state/<gameKey>/   state.json / bridge.log / commands.jsonl / events.jsonl
runtime/locks/<gameKey>.json      数据锁定集合（「保存锁定状态」写这里）
runtime/shadow-apps/<gameKey>/    策略B 影子目录
runtime/screenshots/              cdp.mjs 调试截图
tools/           CLI（rmch.mjs / send.mjs / serve.mjs）、setup/launch 脚本、测试、验收驱动、
                 gui-check.mjs（GUI 预检）、cdp.mjs（零依赖 CDP 客户端）、
                 winshot.py（窗口截图，被遮挡的 NW.js 窗口也能截）、
                 bake-icon.mjs（零依赖图标烘焙：SDF 栅格化 → app/gui/icon.png）、
                 pack-release.mjs（Release zip 打包）
```

## 构建与测试

```powershell
npm test                                 # ws-server 合同 + bridge harness + GUI 预检
node tools/gui-check.mjs                 # 只跑 GUI 预检（模板编译 / store 引用 / vendor 校验）
node tools/m2-acceptance.mjs <gameRoot>  # 全链路验收（启动→连接→命令→退出）
node tools/pack-release.mjs              # 构建 output/RMToolbox-v<version>-win-x64.zip
```

四个游戏的验收记录见 [ACCEPTANCE.md](ACCEPTANCE.md)。

## GUI 技术栈（Vue 3 + Naive UI，无构建步骤）

界面用 **Vue 3.5** + **Naive UI 2.35**，两个包以浏览器 bundle 形式 vendored 在
`app/gui/vendor/`（零 npm 依赖、无构建步骤）：页面用普通 `<script>` 标签加载它们，
组件写在 `app/gui/ui/` 下、模板是字符串由 Vue 运行时编译。Naive UI 是 CSS-in-JS，
所以**没有手写的组件样式**——所有视觉 token 在 `app/gui/ui/theme.js`（深/浅双主题，
右上角切换、记在 localStorage）；`app/gui/styles.css` 只剩文档级排版（html/body、滚动条、
几个 flex 容器）。

三个必须知道的约束（细节见 `app/gui/vendor/README.md`）：

- **Naive UI 锁 2.35.0**：借用的 NW.js 运行时是 0.54 = Chromium 91，2.36+ 的 bundle
  带 ES2022 的 class `static {}` 块，Chromium 91 直接 SyntaxError（整个窗口白屏）。
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
00-prelude   IIFE 开头 + bridge 状态对象       40-hooks          patchMethod + 倍率/遇敌/移速/技能消耗
05-node-io   require/路径/log/event            45-vitals-locks   上帝模式：HP/MP/TP 锁
10-engine    TK.$ 别名解析、$game*/$data*      50-value-locks    数据锁定：逐帧回写
20-values    强转/守卫/抑制作用域/统计         55-transport      WS 客户端 + JSONL 兜底队列
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

- **策略 A（extension）**：原版 Game.exe + `--load-extension=<bridge扩展>`（MV/MZ 默认）
- **策略 B（shadow）**：bg-script 启动链游戏专用 —— 影子目录（硬链接+Junction）+ 补丁版 bg-script +
  `process.cwd/execPath/nw.App.manifest` 环境伪装，对付检测/杀扩展的游戏。影子 `save/` 始终 junction
  回真实游戏根（root 布局重建时先把影子残留存档按 mtime 较新者胜合并回去），存档读写直达真实目录

## 通信

bridge 是 WS 客户端，连 GUI/serve 的 `127.0.0.1:47412`（URL 携带 `runtime/rmch.token`）。
断线指数退避重连；`runtime/bridge-state/<gameKey>/commands.jsonl` 文件队列作为兜底通道。
命令结构化返回 `{ok, payload|error}`；handler 可同步或异步（MV/MZ 均支持）。

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
