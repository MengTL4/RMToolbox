# RM 工具箱（RM Toolbox）

免费开源的 RPG Maker 单机游戏修改器，Windows 平台。自带图形界面，
不改游戏目录里的任何文件：启动游戏时把修改功能一起带进去，关掉就没了。

支持 **MV / MZ** 和 **XP / VX / VX Ace**（RGSS 系列）：修改器、数据读写、
存档编辑等核心功能两边基本一致；个别能力因引擎本身差异略有出入
（RGSS 没有自开关、XP 没有物品图标表、部分角色操作仅 VX Ace 可用）。
另外支持两类特殊打包的 MZ 游戏：用 **Tauri / WebView2 壳**发行的
（如「YanBin RPG Maker Builder」系列，《魔物召唤森林》等）——内核是完整的
MZ，工具箱通过浏览器的 DevTools 协议接入，功能与原生 MZ 基本一致；
以及**引擎整体混淆加密的「sealed 启动器」游戏**（如《停不下来的轮回》）——
引擎藏在混淆的 game.js 里、页面上没有任何引擎对象，工具箱启动游戏时
会通过 DevTools 协议做一次内存扫描，把引擎对象重新发布出来，之后与
原生 MZ 一致。这两类都不支持「附加到运行中」（只能从工具箱启动）。

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
3. 连上之后用左侧页签操作：

- **修改器**：无敌、锁血、倍率、金钱、战斗操作，还有游戏卡死时的急救按钮
  （清除事件、淡入屏幕、回到地图等）。
- **数据**：物品/装备/开关/变量/角色/地图的列表编辑。列表里勾选 = 锁定那个值
  （商店扣钱、事件消耗道具都会被立刻改回来）；角色页签可以学技能、附加状态，
  带游戏内图标；「存档数据」页签能直接编辑整份存档（JSON 树）。
- **存档**：存档槽位列表、快速存读档、备份与恢复。改存档前建议先备份。
- **控制台**：直接在运行中的游戏里执行代码（MV/MZ 执行 JavaScript，XP/VX/Ace 执行 Ruby）。

## 功能一览

- 战斗：无敌、一击必杀、锁 HP/MP/TP（值和上限）、免技能消耗、全灭敌人、逃离战斗
- 角色：等级/经验/属性修改、技能学习、全队恢复
- 资源：经验/金币/掉落倍率、金钱修改、移速加成、游戏加速（按住 Ctrl）
- 数据：物品/武器/防具/开关/变量编辑与锁定
- 跑图：穿墙、不遇敌、常时奔跑、地图点击传送
- 存档：存读档、自动备份、存档数据树编辑
- 杂项：游戏内界面跳转、卡死修复、控制台（MV/MZ 为 V8，RGSS 为 Ruby）

## 安全说明

- 只适用于本地单机游戏，请勿用于任何带在线排行、联机或账号系统的游戏。
- 不修改游戏安装目录里的文件；所有改动都在内存里，重启游戏即还原（存档除外）。
  唯一的例外：Tauri 壳游戏会在游戏目录生成一个 `*.rmch-cdp.exe` 副本
  （原 exe 一个字节都不动，副本只改了一行浏览器启动参数，Steam 校验不受影响）。
- 「附加到运行中」使用 DLL 注入（`runtime/inject/bin/` 下的预置二进制，源码与构建脚本在
  `runtime/inject/src/` + `tools/build-inject.mjs`）。部分杀毒软件对注入器一律误报，
  如遇拦截请自行核对源码后加白名单。
- 「存档数据」编辑会改变存档结构，改之前请先在「存档」页备份。

## 从源码运行

想自己改代码或跟进开发版：

- 需要 **Node.js ≥ 18** 和一份 **NW.js 0.54 运行时**（[nwjs.io/downloads](https://nwjs.io/downloads/)，
  sdk 或 normal 版均可，解压到仓库根的 `nwjs/` 目录；也可以在 `config.local.json` 里写
  `{ "nwRuntimeDonor": "D:\\path\\to\\nw-runtime" }` 指定位置）。
- 启动 GUI：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\launch-gui.ps1`
  （首次会自动链接 NW 运行时并构建，然后开窗）。
- 测试：`npm test`。

命令行工具（无需 GUI）：

```powershell
node tools/rmch.mjs scan                 # 扫描 Steam 库，识别引擎
node tools/rmch.mjs launch <gameRoot>    # 注入并启动游戏
node tools/rmch.mjs attach <gameRoot>    # 附加到已在运行的游戏（DLL 注入）
node tools/rmch.mjs send <gameKey> gold.set '{"value":10000}'
```

## 参与开发

架构、bridge 分片结构、GUI 技术栈约束、打包 Release 等见
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。四个游戏的验收记录见
[docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。

## 许可证

[MIT](LICENSE)
