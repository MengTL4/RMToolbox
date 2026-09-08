# 末日风暴 1.9.6 适配记录

## 验收完成

正式完整桥的基础可变验收 **14/14 通过**，真实地图、事件与战斗验收 **10/10 通过**，10 类目录与图标读取通过。多次独立冷启动及 95 秒全前台稳定采样通过，首次帧率警告不再出现。额外游戏倍速 / Ctrl 加速及原生胜利文案的限制见下文，均未以无效设置冒充支持。

检查日期：2026-09-08。原目录：`D:/Downloads/RPG/末日风暴-1.9.6`。
实测使用完整独立副本 `tmp/storm-196-isolated`，不向原存档写入测试进度。

## 引擎与入口

- NW.js win32，RPG Maker MV 1.6.1；核心 `rpg_core.js` 为 nwjc 字节码（`03 04 DE C0`）。
- manifest：`name=mrfb`、`main=www/loading.html`、`bg-script=loading`。
- 实际入口为 `末日风暴.exe`。附带 `notification_helper.exe` 导致旧 scanner 认为入口不唯一；现通用排除 NW 辅助进程。
- 根目录全部 EXE/DLL 的 PE 节表为常规结构，未发现 Themida/WinLicense/Oreans 特征文本，无 `.node` 插件。没有 Themida 正向证据；保护形式符合 Grover/nwjc，未按 Themida 排除。

## 原版启动故障与对照

1. 独立副本无注入裸启动，约 15 秒自行退出，发生在工具箱原来的 60 秒等待期内。
2. 原目录无注入裸启动同样约 15 秒自行退出。原目录只有游戏自身新增日志，不保存测试进度。
3. 仅前置已有 wmic shim 的副本对照仍退出。
4. 提前附加后的调用栈表明 `Timeout.modulesMmt` 调用 `nw.App.quit`、`nw.App.crashRenderer`。
   字节码插件 `www/js/plugins/TH-QianC.js` 含 `modulesMmt`、`sharedObjects`、`Suspect Module =>`。
5. 原版未注入进程已加载 Sangfor VPN/安全组件：安装目录 `Program Files (x86)/Sangfor/SSL` 下的
   `SangforUDProtectEx_202591913857893.dll`、`sangforvpnlibcrypto-1_1.dll`、`SangforTcp.dll`、`5_SangforNsp.dll`。
6. 仅拦截 modulesMmt 的退出调用会导致同步自旋，不能作为修复。
7. 只在游戏查询的 `process.report.getReport().sharedObjects` 中排除上述已知安装路径，保持安全组件运行，轻量启动对照成功到 `Scene_Title`：
   `hidden=false`、数据库已加载、帧计数连续增长，超过原来的退出时间。

提前安装完整桥曾出现隐藏页面/启动循环停滞。曾把完整桥源码嵌入早期兼容脚本两次，使所谓轻量脚本达到约 435 KB；现提前写入单独文件，早期脚本仅持有路径，在真实游戏场景就绪后读取。普通 Grover 的 60 秒等待保持不变；定向兼容在数据库已加载、已离开 Boot 的真实场景中立即读取完整桥文件，再等待真实 file hello，避免固定等待期先积累过高帧数。最终路线已多次冷启动复验。
轻量诊断脚本必须保持启动作业存活：短脚本退出会导致测试进程生命周期变化，不可把该情况作为游戏自行退出的证据。

## 实现边界

- scanner 仅在已有 Grover 指纹且 `TH-QianC.js` 同时包含三个模块监控标记时增加 `grover-module-monitor`。
- 启动时用与游戏位数一致的进程模块查询核实 Sangfor；无实际匹配保持旧启动路线。实际模块列表传入轻量脚本，避免早期同步生成昂贵的完整进程报告；游戏原本调用 `getReport` 时才过滤已核实路径。
- 路径必须位于系统 `ProgramFiles(x86)/Sangfor/SSL`，子目录和文件名仅允许本次确认的四种组件；未知模块、系统 DLL、工具箱 DLL 保持可见。
- 不停止、卸载或修改 Sangfor，不修改游戏源文件；状态记录于工具箱 `runtime/bridge-state/<gameKey>/grover-compat.json`。
- 启动按裸启动 → 核实实际模块并恢复新主进程的原生游戏窗口 → 轻量模块兼容 → 真实场景就绪后读取完整桥文件的顺序执行。原生 DLL 只投递一次，由 Node 定时器延迟安装完整桥；优先使用已捕获的游戏页，关闭后才枚举 NW 窗口回退。场景必须加载数据库且已离开 Boot；等待真实 file hello 后复用。超时不二次注入，不执行丢失兼容层的目录重载；NW 枚举不回调也有独立超时。
- 冷启动在任何桥启动前清理该 gameKey 的旧文件命令、结果和状态，避免旧 ID 与旧 hello 污染；附加现有会话保持文件通道。独立修复 FileSession 重连命令 ID 碰撞。
- loader 可能在进程发现与投递之间更换 renderer；仅在 `OpenProcess 87` 明确尚未打开进程、未装载 DLL 时，允许一次刷新 PID 并重新核实模块。成功或超时投递均不重复注入。
- `test-nw-attachment.mjs` 的模拟回归覆盖路径边界、无匹配时不改报告、准备失败和启动时序。

## 实机验收

验证均在完整独立副本的正式生产启动路线完成；没有以仅标题存活代替功能验收。最终副本停在自由地图 4：无对话、无事件执行、非战斗、默认选项、空锁定；5 号存档保留该检查点。

### 原生窗口与帧率证据

- 原生 NW `show/restore/focus` 后仍 `SceneManager._scene=null`、`_nextScene=Scene_Boot`、数据库未加载、`document.hidden=true`；仅对本次启动主 PID 的 HWND 执行 Win32 Restore/foreground 后，立即到 `Scene_Title`、数据库加载、帧计数增长。生产使用 EnumWindows 限定新主 PID、Chromium 有标题顶层窗口，包含初始隐藏窗并排除 message-only 窗口，记录原可见/最小化状态与前台结果。
- 随后干净生产实例正常进入 `Scene_Map` / 地图 6“序章”。读写命令曾停止响应，用户截图明确为同步原生 alert“请勿使用变速软件！屏幕帧数率高于60hz时请将游戏帧数调整至60。”；关闭 alert 后立即恢复响应，不能据此归因为桥崩溃。
- TH-BaseSet 的字节码包含 `playtime/getTime/_olt/_oltB` 检测簇。运行时 `_olt/_oltB` 位于场景对象；`playtime` 来自 `Graphics.frameCount/60`。
- 游戏作者配置的 Drill_SpeedGear 初始齿轮速度为 `2.00`，实际 `_drill_speedgear_speed=2`、`SceneManager._deltaTime=1/120`；工具箱倍率为 1。TDDP_FluidTimestep 1.0.2 同时启用。直接改 delta 会改变作者原生逻辑速度，因此不能作为帧率修复。
- 前台实测 2001 ms 内，`Graphics.frameCount`、`SceneManager.update`、`requestUpdate` 均增加 284；原生 `_currentTime` 推进 2017.5 ms。确认 142 Hz 渲染驱动下原生逻辑按墙钟累积，应限制实际渲染调度而保留原生步长和检测。
- 正式完整桥安装定向限帧后，前台 2000 ms 内恰好增加 120 帧，`delta` 保持 `1/120`。该修复不吞 alert、不改时间读数、不关闭 TH 检测。曾保留 5 秒桥等待时首轮仍包含安装前高帧数，因此移除定向路线的盲等；最终冷启动已验证第一次警告也不再出现。

### 运行时数据与可变验收

- FT 族使用 `$ftGmPl/$ftGmPr/$ftGmAc/$ftGmSw/$ftGmVr` 及 `$newTk*/$thTk*` 数据库；标准全局名不存在，枚举还可能隐藏字段。动态别名按确切字段引用安装，存读档重建实例后仍指向原生对象。
- 正式全桥只读 10 类目录通过：物品 610、武器 750、防具 750、技能 400、状态 65、角色 31、敌人 175、敌群 159、地图信息 368、公共事件 80；IconSet 为 512 × 2400。
- 基础可变检查已通过原生别名、金币、物品增删、武器/防具库存、角色参数实际增加、等级与生命、技能状态、开关变量、移动修改器、地图读取、锁定。该游戏没有 Homecoming 的 `newGetItem/thTyZhNumGain/_tkCkItem` 协议，库存以原生 `numItems` 和容器核对。
- 文件存档保存、列表、读取及数据树导出/应用均已在自由地图通过，包含恢复后 FT 动态别名与原生对象同一性校验。对话期间拒绝数据树应用的既有条件保留。
- 状态命令的 `add → remove → add` 实测发现旧 `Game_ActionResult.removedStates` 会阻止重新添加。独立添加/移除命令先调用原生 `clearResult` 建立新动作边界，再走原生状态接口；完整重复操作复验通过，抗性与状态条件仍由引擎决定。
- 额外游戏倍速与 Ctrl 加速明确受限：真实 `SceneManager.updateMain` 调用的参数数量为 0，现有工具箱时间参数加速路线无法作用于该原生循环。针对同一 FT + TH-BaseSet + TDDP 指纹，设置倍速大于 1 或启用 Ctrl 加速会在任何选项写入前明确报错；不假报成功，也不修改作者的齿轮速度。其他族保持原来的倍速行为，其他修改选项仍可使用。
- 原生经验和金币接口均需要第二个真值参数：`gainExp(n,true)` 正常加经验，省略/false 分支抛异常；`gainGold(n,true)` 正常加金币，省略/false 分支静默无效。工具箱针对 FT 与 `thTyChangeExp/thNewGainGold` 方法签名补足该参数，经验/金币倍率钩子保持原调用参数透传；金币锁也使用同一原生适配。已知原生金币路线不以“数值无变化”认定接口失效，避免达到上限后落入直接覆盖容器的旧兜底。
- delay0 正式冷启动连续 95 秒稳定采样通过：19/19 样本为前台、无停止状态、全部命令响应，未出现首次帧率警告。后续真实验收在另一次完整冷启动桥中重复。

### 真实地图、战斗与结算

- 使用地图 18“破旧楼房 F1”的原生遭遇与实际存在的背景 14/20。通行网格、事件读取、原生解释器受控执行、传送、菜单、无消耗与生命锁、真实战斗、奖励倍率、一击击败、清敌共 10 项通过。
- 非战斗实验室地图 4 的默认 `Cobblestones3/SF_Hospital` 背景在原包中不存在。初期错误来自在该地图强行建战斗，已改为真实战斗地图并增加资源检查；没有补写占位图或绕过加载错误。
- FT 敌人可能拒绝普通死亡状态，且原生 `die/addNewState` 不同步清 HP。强制击败先走原生 `setHp(0)`，再用原生死亡状态操作；真实结果为 `hp=0/isDead=true`，清敌 `remaining=0`。
- 真正原生胜利结算：基础金币 30 / EXP 60，倍率 2 后 `_rewards` 为金币 60 / EXP 120；金币 1254 → 1314。经验 68 加 120 后跨级消耗 75 + 108，7 级余 5，证实实际入账且没有重复放大。
- **界面限制**：游戏自己的胜利文字仍显示基础金币 30 / EXP 60；实际到账为翻倍后的金币 60 / EXP 120。未重写加密的原生文案生成流程。

### 可复用证据

- `tmp/storm-readonly-acceptance.json`：10 类目录与图标。
- `tmp/storm-acceptance.json`：最终 14/14 基础与存档。
- `tmp/storm-world-acceptance.json`：最终 10/10 地图、事件、战斗。
- `tmp/storm-victory-acceptance.json`：真实胜利到账核对。
- `tmp/storm-stability.json`：95 秒、19 个全前台样本。
- `tools/test-nw-attachment.mjs`：47 个生产流程回归；`tools/test-frame-pacing.mjs`：刷新率、原生逻辑步长、速度限制、金币/EXP 协议、重复状态操作回归。
