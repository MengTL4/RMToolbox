# RM 工具箱（RM Toolbox）

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![GitHub release](https://img.shields.io/github/v/release/MengTL4/RMToolbox)](https://github.com/MengTL4/RMToolbox/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-blue)]()

免费开源的 RPG Maker 单机游戏修改器，Windows 平台，自带图形界面。
不碰游戏目录里的任何文件：启动游戏时把修改功能一起带进去，关掉游戏就没了。

## 支持哪些游戏

- **RPG Maker MV / MZ**（NW.js 打包）——功能最全。
- **RPG Maker XP / VX / VX Ace**（RGSS 系列）——修改器、数据读写、存档编辑等
  核心能力与 MV/MZ 基本一致；个别能力因引擎本身差异略有出入
  （RGSS 没有自开关、XP 没有物品图标表、部分角色操作仅 VX Ace 可用）。
- **Tauri / WebView2 壳的 MV/MZ 游戏**（如「YanBin RPG Maker Builder」系列，
  《魔物召唤森林》《重装归途》等）——内核仍是 MV/MZ，工具箱通过浏览器的
  DevTools 协议接入，功能与原生 MZ 基本一致。
- **sealed 启动器游戏**（如《停不下来的轮回》）——引擎整体混淆进 game.js，
  页面上没有任何引擎对象。工具箱启动游戏时会通过 DevTools 协议做一次内存
  扫描，把引擎对象重新发布出来，之后与原生 MZ 一致。
- **合体单脚本打包的游戏**（引擎合并进一个大闭包脚本，如《命运II离线版》）——
  工具箱从影子副本启动游戏（原文件不动），在闭包内部把引擎对象发布出来后
  与原生一致。
- **nwjc 字节码 + Grover 验证壳的游戏**（《傲世修仙录》定制版家族）——壳用
  已从 Windows 11 移除的 wmic 做祖先链校验，原生双击也会被杀。工具箱经
  裸启动 + DLL 注入绕开自杀路径后走标准桥接（该家族适配仍在进行中，
  详见 [docs/GROVER-FINDINGS.md](docs/GROVER-FINDINGS.md)）。

注意：Tauri 壳与 sealed 启动器这两类不支持「附加到运行中」，只能从工具箱启动。

## 已做专门适配的游戏

- **《重装归途》0.1.33**：已适配角色背包、仓库、独立装备和浏览器存档，
  并实测修改器、战斗、地图与事件工具。浏览器存档的备份/恢复需要保持游戏连接。
  该游戏的基础属性加点接口无效；独立弹仓不按普通物品修改，独立装备不支持数量锁。
  新增装备请选择基础装备目录，删除时请选择当前物品中的具体实例。
- **《末日风暴》1.9.6**：已接入其 FT 重命名引擎和原生金币、经验接口，
  并针对高刷新率屏幕自动限制为 60 FPS，保留游戏作者设定的逻辑速度。
  该游戏不支持工具箱的额外加速选项，开启时会明确提示；原生结算文字仍显示
  基础奖励，倍率已作用于实际入账。

两款游戏的验收和限制详见 [适配记录](docs/NEW-GAMES-ADAPTATION.md)。

![游戏库](docs/screenshots/library.png)
![修改器](docs/screenshots/trainer.png)
![数据页](docs/screenshots/data-items.png)

## 下载

到 [Releases](https://github.com/MengTL4/RMToolbox/releases) 下载最新的
`RMToolbox-vX.Y.Z-win-x64.zip`，解压后双击文件夹里的 `RMToolbox.cmd` 就能用
（也可以进 `app/gui` 目录双击 `RMToolbox.exe`）。
不需要安装 Node.js 或任何运行环境。

## 怎么用

1. 首次打开「游戏库」是空的——点「添加游戏目录」选择游戏的安装目录
   （里面有 Game.exe 的那一层），可以添加多个；加错了点卡片上的垃圾桶
   图标移除，不会动游戏文件。
2. 选中游戏点**启动并注入**，工具会把游戏跑起来并连上修改功能。
   游戏已经在运行的话，也可以点**附加到运行中**直接连上（DLL 注入，不改任何文件，
   关掉游戏即还原）；MV/MZ 与 XP/VX/VX Ace 都支持。
3. 连上之后用左侧菜单操作（界面支持深色 / 浅色主题切换）：

- **修改器**：无敌、锁血、倍率、金钱、战斗操作，还有游戏卡死时的急救按钮
  （清除事件、淡入屏幕、回到地图等）。
- **数据**：物品/装备/武器/开关/变量/角色/地图/公共事件的列表编辑。列表里
  勾选 = 锁定那个值（商店扣钱、事件消耗道具都会被立刻改回来）；角色页签可以
  学技能、附加状态，带游戏内图标；「运行中数据」页签能直接编辑整份运行中的
  存档对象（JSON 树）。
- **存档**：存档槽位列表、快速存读档、备份与恢复。改存档前建议先备份。
- **控制台 / 日志**（高级工具）：直接在运行中的游戏里执行代码（MV/MZ 执行
  JavaScript，XP/VX/Ace 执行 Ruby）；日志页可查看桥接与操作的运行记录。

## 功能一览

- 战斗：无敌、一击必杀、锁 HP/MP/TP（值和上限）、免技能消耗、全灭敌人、逃离战斗
- 角色：等级/经验/属性修改、技能学习、全队恢复
- 资源：经验/金币/掉落倍率、金钱修改、移速加成、游戏加速（按住 Ctrl）
- 数据：物品/武器/防具/开关/变量编辑与锁定
- 跑图：穿墙、不遇敌、常时奔跑、地图点击传送
- 地图工具：当前事件搜索、事件旁传送、需确认的强制坐标传送，以及可缩放/拖动/跟随玩家的网格迷你地图
- 事件解释器：在公共事件详情内展开，支持运行整个事件或选中完整步骤执行，以及停止后续指令；地图事件共用只读面板，保留条件、原文、搜索、执行位置及快照过期提示
- 存档：存读档、自动备份、运行中存档数据树编辑
- 杂项：游戏内界面跳转、卡死修复、控制台（MV/MZ 为 JavaScript，RGSS 为 Ruby）

## 安全说明

- 只适用于本地单机游戏，请勿用于任何带在线排行、联机或账号系统的游戏。
- 不修改游戏安装目录里的文件；所有改动都在内存里，重启游戏即还原（存档除外）。
  唯一的例外：Tauri 壳游戏会在游戏目录生成一个 `*.rmch-cdp.exe` 副本
  （原 exe 一个字节都不动，副本只改了一行浏览器启动参数，Steam 校验不受影响）。
- 「附加到运行中」使用 DLL 注入（`runtime/inject/bin/` 下的预置二进制，源码与构建脚本在
  `runtime/inject/src/` + `tools/build-inject.mjs`）。部分杀毒软件对注入器一律误报，
  如遇拦截请自行核对源码后加白名单。
- 「运行中数据」编辑会改变存档结构，改之前请先在「存档」页备份。

## 从源码运行

想自己改代码或跟进开发版：

- 需要 **Node.js ≥ 22.12**，首次执行 `npm ci` 安装锁定版本的构建依赖。
- 启动 GUI：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-gui.ps1`
  （自动下载并校验 `nw-runtime.lock.json` 指定的官方 NW.js，再构建和开窗）。
- 测试：`npm test`（自动构建前端并运行类型检查和回归）。
  地图/事件协议包含 MV/MZ 和三代 RGSS 夹具；后者需要本机 Ruby。另用
  `npm run test:ui-browser` 检查浏览器交互，`npm run test:gui-runtime` 检查实际 NW.js 桌面运行。
- 本地 Release 打包：`npm run build`，生成 `output/RMToolbox-v<版本>-win-x64.zip`
  和 `.zip.sha256` 校验文件。解压后双击根目录 `RMToolbox.cmd`，程序在 `app/gui/RMToolbox.exe`。

工具箱使用 NW.js 0.115.0；游戏自身的运行时保持原样。打包不再读取 `nwRuntimeDonor`，
下载缓存位于 `.cache/nwjs/`，有有效缓存时可以离线构建。

命令行工具（无需 GUI）：

```powershell
node tools/rmch.mjs scan                 # 扫描 Steam 库，识别引擎
node tools/rmch.mjs launch <gameRoot>    # 注入并启动游戏
node tools/rmch.mjs attach <gameRoot>    # 附加到已在运行的游戏（DLL 注入）
node tools/rmch.mjs send <gameKey> gold.set '{"value":10000}'
```

## 参与开发

架构、bridge 分片结构、GUI 技术栈约束、打包 Release 等见
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。各游戏的验收记录见
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。欢迎提交 Issue 和 Pull Request。

## 许可证

[MIT](LICENSE)
