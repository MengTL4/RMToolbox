# RM 工具箱 (RM Toolbox)

通用 RPG Maker MV/MZ（NW.js）单机游戏修改器：一个外部 GUI + 一个注入游戏的通用 bridge，
功能对标 MTool 修改器部分，零 npm 运行时依赖。

> 界面品牌为「RM 工具箱」，仓库与代码内部代号仍为 RMCH（window.RMCH、runtime/rmch.token 等）。

**当前状态：M0–M2 完成并在四个游戏上全量验收通过**（见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)）。

![游戏库](docs/screenshots/library.png)
![修改器](docs/screenshots/trainer.png)
![数据页（物品列表带游戏内图标）](docs/screenshots/data-items.png)

## 安装与首次运行

前置条件：

- **Node.js ≥ 18**（跑 CLI 和构建脚本；GUI 本身零 npm 依赖）
- **一份 NW.js 运行时**（≈0.54 / Chromium 91；更新的版本未必兼容 vendored 前端库）。
  GUI 不自带运行时二进制，首次启动时 `tools/launch-gui.ps1` 会把它硬链接进 `app/gui/`。
  三种提供方式，按优先级：
  1. 把官方 NW.js（sdk 或 normal 均可）解压到仓库根的 `nwjs/` 目录（[nwjs.io/downloads](https://nwjs.io/downloads/)）
  2. 在 `config.local.json` 里指一条路：`{ "nwRuntimeDonor": "D:\\path\\to\\nw-runtime" }`
  3. 本机已有含 NW 运行时的 modkit/trainer 目录也能当 donor（`core/setup-gui-runtime.mjs`
     里的 `DEFAULT_DONORS` 可自行添加）

## 快速开始

```powershell
# 启动 GUI（首次自动链接 NW 运行时 + 重建 CJS bundle，然后开窗）
powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-gui.ps1

# CLI（无需 GUI）
node tools/rmch.mjs scan                 # 扫描 Steam 库，识别引擎/保护等级
node tools/rmch.mjs launch <gameRoot>    # 注入 bridge 并启动游戏
node tools/rmch.mjs send <gameKey> gold.set '{"value":10000}'
node tools/rmch.mjs serve                # 独立 WS 服务器（调试用）
node tools/rmch.mjs token                # 打印本地令牌

# 测试 / 验收
npm test                                     # ws-server 合同 + bridge harness + GUI 预检
node tools/gui-check.mjs                     # 只跑 GUI 预检（模板编译 / store 引用 / vendor 校验）
node tools/m2-acceptance.mjs <gameRoot>      # M2 全链路验收（启动→连接→命令→退出）
```

GUI 六个面板：**游戏库**（扫描/添加/识别/启动）、**修改器**（作弊开关/倍率/金钱/战斗/场景与修复）、
**数据**（MTool 式主从页签：物品/装备/武器/开关/变量/角色/地图/公共事件/存档数据）、
**控制台**（远程 eval）、**存档**（列表/快速存读档/备份恢复）、**日志**。

### 「数据」页：对标 MTool 的主从编辑器

每个页签都是「左边可搜索列表 + 右边详情编辑器」：列表行首的勾选框**本身就是操作**
（物品/开关/变量 = 锁定，角色 = 在队伍中），行尾显示实时值（持有数量 / ON-OFF / 变量值），
详情里的数值都配 `-100 / -1 / +1 / +100` 快捷增减。

- **数据锁定**：勾上就锁住那个值 —— bridge 在 `SceneManager.updateMain` 里**每帧**把它写回，
  所以商店扣钱、事件消耗道具、脚本翻开关都会被立刻改回来。锁定集合存在
  `runtime/locks/<游戏名>.json`（「保存/读取锁定状态」），跨游戏重启可复用。
  锁活在 bridge 里而不是页面里，所以 GUI 刷新不会丢锁。
- **技能 / 状态选择器**：角色详情卡头点「技能」「状态」弹出可搜索勾选列表（勾上=学会/附加，
  取消=遗忘/解除），行内带游戏内图标（图标图集不可用时自动不渲染），带「只看已拥有」。
  窗口化渲染，1700 条技能也不卡。
- **存档数据（数据修改）**：`更新数据` 从运行中的游戏拉 `DataManager.makeSaveContents()`
  （JsonEx 序列化，实测 ~3MB），在 JSON 树里改，`应用至游戏` 交回 `extractSaveContents`
  并像读档一样重载地图。编辑器是 **vendored 的 jsoneditor 10（josdejong）**——和 MTool 的
  「数据修改」同一个库、同一套配置（zh-CN 语言包、`树/表单/视图/代码/文本/预览` 模式切换、
  代码模式带 ace 高亮、JMESPath 变换、排序弹窗、搜索 ‹› 跳转、拖拽移动节点），两个主按钮
  （`更新数据` / `应用至游戏`）通过 teleport 塞进 jsoneditor 自己的菜单栏——MTool 同款手法。
  行内编辑用 Tab 跳格、失焦提交；Ctrl+Z / Ctrl+Shift+Z 撤销重做（撤销回原始文档会自动
  清掉「有未应用的修改」标记）。改之前建议先在「存档」页备份 —— 增删键会改变存档结构，
  与游戏的类不匹配时可能读档才报错。
- 「修改器」页保留常用作弊的卡片总览，并新增**场景跳转**（`SceneManager.push` 打开游戏自己的
  物品/技能/装备/状态/菜单/存读档/设置界面；商店、改名这类必须由游戏事件 `prepare()` 传参的
  场景不提供——裸推必崩）和**修复错误**（清除当前事件 / 清除所有图片 /
  淡入屏幕 / 清除移动路由 / 转至地图 / 转至标题）。

### GUI 技术栈（Vue 3 + Naive UI，无构建步骤）

界面用 **Vue 3.5** + **Naive UI 2.35**，两个包以浏览器 bundle 形式 vendored 在
`app/gui/vendor/`（仍然零 npm 依赖、无构建步骤）：页面用普通 `<script>` 标签加载它们，
组件写在 `app/gui/ui/` 下、模板是字符串由 Vue 运行时编译。Naive UI 是 CSS-in-JS，
所以**没有手写的组件样式**——所有视觉 token 在 `app/gui/ui/theme.js`（深/浅双主题，
右上角切换、记在 localStorage）；`app/gui/styles.css` 只剩文档级排版（html/body、滚动条、
几个 flex 容器）。

三个必须知道的约束（细节见 `app/gui/vendor/README.md`）：

- **Naive UI 锁 2.35.0**：RMCH 借用的 NW.js 运行时是 0.54 = Chromium 91，2.36+ 的 bundle
  带 ES2022 的 class `static {}` 块，Chromium 91 直接 SyntaxError（整个窗口白屏）。
- **Naive UI 和 jsoneditor 都是 UMD**，而 NW.js 会把 `module`/`exports` 注入页面，会让它们走
  `require("vue")` 分支挂掉；`index.html` 在加载 vendor 期间临时屏蔽这几个全局变量。
- **jsoneditor 10.4.3（完整版，含 ace + ajv）** 也 vendored 在 `app/gui/vendor/jsoneditor/`
  （和 MTool 同一个库）；它自带真样式表和图标 sprite（`img/jsoneditor-icons.svg`，相对路径
  不能动），主题覆盖在 `app/gui/jsoneditor-theme.css`——那是「views 不写组件 CSS」规则唯一的
  例外，因为 Naive 的 CSS-in-JS 够不到第三方 DOM。

`node tools/gui-check.mjs` 会把这两条、"每个模板都能编译"、"标签成对"、"视图引用的 store
成员都存在" 一起卡住，跑在 `npm test` 里。调试实机界面用 `node tools/cdp.mjs`（零依赖 CDP
客户端，需要 `--remote-debugging-port=9222`）：

```powershell
node tools/cdp.mjs eval "window.RMCH.store.trainer.gameKey"
node tools/cdp.mjs click ".n-dropdown-option"   # 真实鼠标事件（Naive 的弹层不吃合成事件）
node tools/cdp.mjs key "ctrl+shift+z"           # 真实按键（jsoneditor 的撤销栈挂在 keydown 上）
node tools/cdp.mjs shot runtime/screenshots/library.png 1180 820
```

## 架构

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
  gui-bundle.cjs     core/*.mjs 的 CJS 打包（生成物，NW 窗口 require 不支持 ESM）
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
                 bake-icon.mjs（零依赖图标烘焙：SDF 栅格化 → app/gui/icon.png）
```

### bridge 的分片结构（改之前先读这段）

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

### 注入策略（均不改游戏原文件）

- **策略 A（extension）**：原版 Game.exe + `--load-extension=<bridge扩展>`（MV/MZ 默认）
- **策略 B（shadow）**：bg-script 启动链游戏专用 —— 影子目录（硬链接+Junction）+ 补丁版 bg-script +
  `process.cwd/execPath/nw.App.manifest` 环境伪装，对付检测/杀扩展的游戏（如 NWR）

### 通信

bridge 是 WS 客户端，连 GUI/serve 的 `127.0.0.1:47412`（URL 携带 `runtime/rmch.token`）。
断线指数退避重连；`runtime/bridge-state/<gameKey>/commands.jsonl` 文件队列作为兜底通道。
命令结构化返回 `{ok, payload|error}`；handler 可同步或异步（MV/MZ 均支持）。

### 目录数据（关键设计）

物品/技能/地图等**不靠解密数据文件**：L1/L2 游戏自己解密后，bridge 直接从内存
（`$dataItems` 等经 `TK.$` 别名表解析）读取。缓存按表长度自动失效——游戏加载完成前后查询都不会拿到脏数据。

## 功能清单（MTool 对标）

无敌 / 一击必杀 / 免技能消耗 / 锁HP·MP·TP（值+上限）/ 经验·金币·掉落倍率 / 移速加成 /
游戏加速（按住Ctrl）/ 穿墙 / 无遇敌 / 显示跟随者 / 常时奔跑 / 金钱增改 /
开关·变量编辑 / 队员信息·全队恢复 / 等级·经验·属性·技能修改 / 物品武器防具增改 /
战斗信息·全灭敌人·逃离战斗 / 地图列表·点击传送 / V8 控制台（eval）/ 存档槽操作（存/读/列表）/
自动存档备份（目录拷贝至 backups/）/ 新游戏·读档进入游戏。

per-game profiles（`runtime/bridge/profiles/`）：zs2（宝宝/天赋/称号/换装/挂机）等游戏专属命令，
通用核心不加载任何 profile 也能跑全功能。

## 约束

- 仅限本地单机游戏；不碰任何在线/排行榜/账号功能。
- 策略 A/B 均不修改游戏目录文件；hook 可回滚（originals 表）。
- 需要 Node ≥ 18 运行 CLI/构建；GUI 的 NW 运行时由用户提供（见「安装与首次运行」）。

## 许可证

[MIT](LICENSE)
