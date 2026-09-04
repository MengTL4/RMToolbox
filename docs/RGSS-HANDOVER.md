# RGSS 引擎支持 — 交接文档

RPG Maker XP / VX / VX Ace（RGSS1/2/3）支持的现状、已完成工作、遗留任务与待决事项。
面向接手开发的 agent，包含具体路径、行号和可直接复现的验证方式。

---

## 1. 项目背景

RMCH（RM 工具箱）是 Windows 平台的 RPG Maker 单机游戏**修改器**，MIT 开源。
原本只支持 **MV/MZ**（NW.js + Chromium），注入方式是 `--load-extension` 挂一个
Chrome 扩展，bridge 在游戏页面里 monkey-patch `$gameParty` 等全局对象。

本次工作为它增加了 **RGSS 系列**（XP / VX / VX Ace）支持，**含 GUI 接入**。
这两类引擎的注入机制**完全不同**，需要分开理解：

| | MV/MZ | RGSS |
|---|---|---|
| 运行时 | NW.js（Chromium） | Ruby（RGSS1/2 = 1.8.1，RGSS3 = 1.9.2） |
| 注入 | `--load-extension` 挂扩展 | 往脚本归档里插一个 Ruby 条目 |
| 通信 | WebSocket（ws-server） | append-only 文件对（详见 §5） |
| 入口 | `core/launcher.mjs` | `core/launcher.mjs` 分发到 `core/rgss-launcher.mjs` |
| 命令词汇 | `gold.set` / `party.info` / ... | **同一套**（bridge.rb 镜像实现，GUI 零改动） |

**项目原则**：绝不修改游戏安装目录里的任何文件；所有改动仅限内存或 shadow 副本。
（存档例外且是有意的：游戏在 shadow 里运行时写的存档，退出时同步回真实目录，见 §4.12。）

---

## 2. 已完成的工作

### 2.1 文件清单

| 文件 | 职责 |
|---|---|
| `core/rgss-marshal.mjs` | 最小 Ruby Marshal 读写。追加条目用**字节拼接**而非重序列化 |
| `core/rgss-archive.mjs` | RGSSAD v1/v3 归档的索引解析、提取、打补丁（v3 免重建；v1 字节流重写，已实测；v2 抛错） |
| `core/rgss-savecode.mjs` | tagged JSON 树 → Ruby 源码 codegen（`save.contents.apply` 用，bridge eval 重建对象） |
| `core/rgss.mjs` | 引擎识别（读 `Game.ini` 的 `Library` 字段）、shadow 构建、注入 |
| `core/rgss-launcher.mjs` | 文件轮询传输层 + 进程管理 + 会话注册表 + 存档回同步 |
| `core/scanner.mjs` | RGSS 分支返回 `RGSS1/2/3` + `result.rgss` 元数据 |
| `core/launcher.mjs` | `launchGame` 按引擎分发；re-export `getRgssSession`/`listRgssSessions` |
| `app/gui/host.cjs` | `send()` 按 gameKey 路由到 RgssSession；`listSessions()` 合并两类会话 |
| `runtime/rgss-bridge/bridge.rb` | 注入游戏内的 Ruby bridge，**镜像 MV/MZ 命令词汇**，必须兼容 Ruby 1.8.1 |
| `tools/rgss-probe.mjs` | 冒烟测试：注入→启动→连桥→读写数据 |
| `tools/test-rgss-hooks.mjs` | hook 包实测：options/锁/hook/无敌/一击必杀/倍率/战斗命令，全程真实战斗 |
| `tools/rgss-dump-scripts.mjs` | 从（加密）归档 dump 脚本到目录，用于核实 hook 方法名 |
| `tools/test-host-rgss.cjs` | host 层集成测试（无 NW）：launch→listSessions→send→state 推送 |
| `tools/test-rgss-marshal.mjs` | Marshal 字节级测试（含 Ruby 生成的黄金参考） |
| `tools/test-rgss-archive.mjs` | 归档读写与打补丁测试（v1 防护用合成归档，无样本也能跑） |
| `tools/test-rgss-contents.mjs` | 存档 JSON 树编辑实测：get→Node 改树→apply→`save.save`/`save.load` Marshal 往返 |
| `tools/fixtures/rgss-marshal.json` | 52 例字节级黄金参考，由真实 Ruby 生成 |
| `tools/winwatch.py` | 轮询可见顶层窗口、自动截屏新出现的弹窗（抓游戏错误对话框用，配合 `winshot.py`） |

`package.json` 已加：`npm run test:rgss`、`npm run rgss:probe`，
且 `npm test` 已串入两个新测试。**改完 core 后必须重建 GUI bundle**：
`node tools/gui-build.mjs`（NW 下 host.cjs 走的是 `app/gui/gui-bundle.cjs`，
模块清单在 `core/gui-bundler.mjs` 的 `MODULES`）。

### 2.2 已实现的能力

- 识别 XP / VX / VX Ace（按 `Game.ini` 的 `Library` 字段；DLL 不在根目录也能认，
  因为它可能装在 RTP 里）
- 明文 `Data/` 与加密归档（`Game.rgss3a`）两种形态都能处理
- 构建 shadow 副本（junction + hardlink，归档用副本），原游戏零改动
- 注入 bridge 并启动游戏，等待其连回
- **GUI 全流程**：游戏库识别 RGSS1/2/3 → 启动并注入 → 修改器/数据页签直接用
  （金钱、物品目录与数量、开关、变量、角色等级/HP/MP/经验/技能/状态、地图列表与传送）
- bridge 每秒推送 state（gold/map/party/inBattle/options），GUI 状态栏与 MV/MZ 一致
- **hook 包（§5.1 已完成）**：无敌、锁血/锁蓝/锁TP、一击必杀、免技能消耗、
  经验/金币/掉落倍率、穿墙、不遇敌、常时奔跑、移速加成、Ctrl 加速、
  值锁定（lock.*）、战斗命令（battle.info/enemy.setHp/killEnemies/escape）
- **存档包（§5.2 已完成）**：`save.list` / `save.save` / `save.load`，写穿真实目录，
  备份/恢复/删除走 host 既有路径
- **存档 JSON 树编辑（§5.2a 已完成）**：`save.contents.get/apply`，tagged JSON 全保真
  往返（含环路/共享节点/Table/Color/Tone/Rect），GUI 存档数据页签直接用
- **物品图标（RGSS2/3）**：`host.cjs iconSetImage()` 读 `Graphics/System/IconSet.png`，
  加密游戏从归档提取该条目；GUI 按引擎切 24px 格（XP 单图图标未做，见 §5.5）
- 游戏退出时把 shadow 里的 `SaveNN.*` 同步回真实游戏目录（含一层子目录，见 §4.12），
  同步后删除 shadow 副本；GUI 删档也连带清 shadow（防"删了又复活"，见 §4.22）

### 2.3 验证状态（真实游戏，非模拟）

| 引擎 | Ruby | 打包形态 | 实测结果 |
|---|---|---|---|
| RGSS1 XP（Knight Blade） | 1.8.1 | 明文 Data/ | PASS — 40 物品 / 8 角色 / 178 地图 |
| RGSS2 VX（Legionwood） | 1.8.1 | 明文 Data/ | PASS — 114 物品 / 20 角色 / 101 变量 |
| RGSS3 VX Ace（Homework Salesman） | 1.9.2 | **加密归档 111MB** | PASS — 500 物品 / 5 角色 / 200 变量+开关 |
| RGSS3 VX Ace（BLACK SOULS 1.1，ATB 战斗） | 1.9.2 | **加密归档 147MB** | PASS — 412 物品 / 35 角色 / 574 开关 / 147 地图 |
| RGSS3 VX Ace（BLACK SOULS II，LNX ATB 战斗） | 1.9.2 | **加密归档 700MB** | PASS — 390 物品 / 200 角色 / 1020 变量 / 1100 开关 / 410 地图 |
| 自制引擎 rgss1（武界风云传 1.63，RGSS103J） | **3.1.2** | **v1 归档 27.6MB（仅 Data/）+ loose 资源** | PASS — catalog/map/save/中文搜索；修复 super 递归钩子（§4.25）、save.load $game_temp（§4.26）、iconName 图标（§4.27）（2026-09-04 实机） |
| host 集成（VX Ace，无 NW） | — | — | PASS — launch/listSessions/send/state 推送/停止 |
| hook 包（三引擎逐一实测） | — | — | PASS — 每代 24 项检查全绿，详见 §5.1 |
| 存档包（三引擎逐一实测） | — | — | PASS — 每代 12 项检查全绿，详见 §5.2 |
| 存档 JSON 树编辑（三引擎逐一实测） | — | — | PASS — get/apply/Marshal 往返，详见 §5.2a |
| 物品图标（RGSS3 加密 + RGSS2 明文，GUI 实机截图） | — | — | PASS — 数据页图标列正确渲染，详见 §5.5 |

复现方式：

```powershell
# 单元测试（不依赖样本也能跑，只是归档 v3 段会 SKIP）
npm test

# 带真实样本（归档 13 项检查、marshal 66 项）
$env:RMCH_RGSS_SAMPLES = "E:\rmch-samples"
npm test

# 单个游戏冒烟测试
node tools/rgss-probe.mjs "E:\rmch-samples\hs"

# hook 包实测（真实开新档 + 真实战斗，样本见 §7）
node tools/test-rgss-hooks.mjs "E:\rmch-samples\hs"
node tools/test-rgss-hooks.mjs "E:\rmch-samples\leg-x\Legionwood Tale of the Two Swords"
node tools/test-rgss-hooks.mjs "E:\rmch-samples\knight-blade\KN_E"

# 存档包实测（真实开新档 → 存档 → 改数据 → 读档回滚，样本见 §7）
node tools/test-rgss-saves.mjs "E:\rmch-samples\hs"
node tools/test-rgss-saves.mjs "E:\rmch-samples\leg-x\Legionwood Tale of the Two Swords"
node tools/test-rgss-saves.mjs "E:\rmch-samples\knight-blade\KN_E"

# 存档 JSON 树编辑实测（get → 改树 → apply → 存档/读档往返验证）
node tools/test-rgss-contents.mjs "E:\rmch-samples\hs"
node tools/test-rgss-contents.mjs "E:\rmch-samples\leg-x\Legionwood Tale of the Two Swords"
node tools/test-rgss-contents.mjs "E:\rmch-samples\knight-blade\KN_E"

# host 层集成（不经 NW，直接驱动 app/gui/host.cjs）
node tools/test-host-rgss.cjs "E:\rmch-samples\hs"
```

---

## 3. 数据流向

```
detectRgss()            读 Game.ini → engine / scriptsRel / archivePath / rtp
      ↓
buildShadow()           junction 目录、hardlink 文件
      │                 Data/ 建为真实目录（注入目标），归档用 copyFileSync
      ↓
readScriptsArchive()    明文：直接读；加密：extractEntry() 解密提取
      ↓
insertScriptEntry()     Marshal 层：定位 rgss_main 所在条目，在它【之前】插入
      ↓
写回 shadow             明文：覆盖 Data/Scripts.*
                        加密：patchEntry() 末尾追加 + 覆写索引 12 字节
      ↓
spawn Game.exe          cwd = shadow 目录
      ↓
bridge.rb 首帧 connect()  建 rmch-cmd.jsonl / rmch-res.jsonl，发 hello + 首帧 state
      ↓
每帧 Scene_*#update()   RMCH.pump() 读新命令、执行、追加响应；每 60 帧推一次 state
      ↓
Node RgssSession        40ms 轮询 res 文件，按 id 匹配 Promise；state 帧转入 store
      ↓
host.cjs send()         gameKey 命中 RGSS 会话 → RgssSession.send()；否则 ws-server
游戏退出                child exit → syncSavesBack()（SaveNN.* 拷回真实目录）→ close
```

---

## 4. 踩过的坑（按重要性排序 — 接手前务必读完）

这些每条都是实机调试换来的，重复踩会浪费大量时间。

### 4.1 注入条目必须在 `rgss_main` / `Main` **之前**

`rgss_main` 进入主循环后**永不返回**，追加到数组末尾的脚本永远不会执行。
症状是"注入成功、verify=true，但游戏毫无反应"，极易误判为别的问题。

Homework Salesman 的 Main 只有一行 `rgss_main { SceneManager.run }`，位于 403 条目中的
index 393；Legionwood 的 Main 在 index 136/138。

`findMainEntryIndex()` 已处理：先按内容找 `rgss_main`，找不到再按名字找 `Main`。

### 4.2 hook 点只能选 Ruby 层方法

- `Graphics.update` 是 **C 函数**，Ruby 层 `alias_method` 被引擎绕过，拦不住。❌
- `SceneManager.run` 在 `DataManager.init` **之前**执行，`$data_items` 还是 nil。❌
- **`Scene_Base#update`**（VX/Ace）✅ —— 纯 Ruby、每帧调用、数据已就绪。
- **XP 没有 Scene_Base**：遍历 `ObjectSpace.each_object(Class)`，hook 所有
  直接定义了 `update` 的 `Scene_*` 类（继承的 update 会落到已 hook 的父类，天然去重）。
  只 hook Scene_Title 的话，进游戏后 bridge 就死了。

### 4.3 loose 文件覆盖不生效

往 `Data/Scripts.rvdata2` 塞 3KB 垃圾数据，游戏照常启动。
**RGSS 只读归档，完全忽略 loose 文件**。加密游戏必须改归档本身。

打补丁**不要重建归档**：把新数据追加到文件末尾，再覆写索引里该条目的
`offset / size / fileKey` 三个 u32（共 12 字节），旧数据区变死字节。
111MB 的归档只增大 428KB，实测游戏正常读取。

### 4.4 归档格式的三个反直觉细节

- 版本号在头部**偏移 7**（不是 6：`RGSSAD` + `\0` + `version`）
- 初始 key = `stored_u32 * 9 + 3` —— **乘法**，不是网上到处写的 XOR `0xDEADCAFE`
- 载荷用 fileKey 的 4 字节循环 XOR，且**每 4 字节滚动一次** `k = k*7+3`
- 索引项的 u32 用归档 key 做**固定** XOR（不滚动）

JS 实现注意：位运算结果是有符号的，每步都要 `>>> 0` 归一化；乘法用 `Math.imul`。

**v1（加密 XP）已验证**（2026-09-04，武界风云传 27.6MB 样本）：索引链 key
按字段滚动，载荷从 size 之后的链上 key 起按 4 字节滚动 XOR（§5.3）。
**v2（加密 VX）只有索引读取是按格式文档写的，未经真实样本验证**；
`extractEntry`/`patchEntry` 对 v2 直接抛错。要支持需先找加密 VX 样本。

### 4.5 Ruby 1.8.1 与 1.9.2 的 Marshal 差异

- **RGSS1/2（1.8.1）**：字符串无 encoding ivar → `22 <len> <bytes>`
- **RGSS3（1.9.2）**：字符串带 `:E => true`（意为 UTF-8）→ `49 22 <len> <bytes> 06 3a 06 45 54`

**但 zlib 载荷有时带 ivar 有时不带**，不能靠版本推断，必须**从字节自动检测**
（`readString()` 已实现）。RGSS3 里重复出现的 symbol 还会写成 symlink `3b <idx>`。

### 4.6 Ruby 1.8.1 的 `instance_methods` 返回 String 不是 Symbol

`instance_methods.include?(:main)` 在 1.8.1 上**永远 false**。
比较必须用 `map { |m| m.to_s }.include?("main")`。这个坑曾导致误判"类没有方法"。

### 4.7 shadow 的 `Data/` 不能是 junction

把 `Data` 建成 junction 后，注入直接**写穿到源样本**（游戏原文件）。
这与 v0.2.1 修过的 bg-script 是同一个坑，只是这次在目录级。

`buildShadow()` 已按"沿替换路径重建真实目录 + 逐文件 hardlink + 排除目标文件"实现，
并带一道断言：若目标目录是链接就抛错。

### 4.8 RGSS 没有 socket 库（但 Winsock 可行，见 §6.1）

`require "socket"` 三个版本都失败（1.8.1 报 NoMethodError / 1.9.2 报 LoadError）。
所以传输层用文件，不用 TCP。

### 4.9 RGSS1 在标题画面不创建 `$game_party`

VX/Ace 会提前创建，XP 要等开新档/读档。所有 party 相关命令必须 nil 保护，
否则 `$game_party.gold` 直接 NoMethodError。`party!()` 已统一处理。

### 4.10 引擎访问器内部可以再炸一层

`respond_to?` 通过 ≠ 调用安全。VX Ace 的 `Game_Map#display_name` / `#width`
内部访问 `@map`（RPG::Map 数据），**标题画面 @map 是 nil** →
`undefined method 'display_name' for nil:NilClass`。state 推送因此全灭过。
凡是引擎方法都走 `try_send()`（respond_to? + 调用 + rescue 三段）。

### 4.11 游戏识别不能只靠 DLL 文件

加密游戏的根目录常常**没有 RGSS DLL**（装在 RTP 里）。扫 `Game.ini` 的
`Library=` 字段才是权威的；`detectRgss()` 为主，DLL 文件名只做兜底。

### 4.12 游戏在 shadow 里写存档，必须回同步

cwd = shadow，所以 `Save01.rxdata` 之类落在 shadow 里。已存在的存档文件是
hardlink（原地写会同步到真实文件），但**新建的槽位只存在于 shadow**，
下次重建 shadow 就丢。`syncSavesBack()` 在游戏退出时把 `SaveNN.*` 拷回真实目录；
`launchRgssGame` 重建 shadow 前也会先抢救一遍（防上次异常退出）。
自定义存档系统可能用子目录（hs 是 `SaveData/`）：shadow 里的子目录若是
junction 则写入直接穿透到真实目录；若是真实目录（真实侧原本没有该目录、
游戏自己 mkdir 出来的），`syncSavesBack()` 会往下走一层同步。bridge 的
`save.save` 写完会立即把文件写穿到真实目录，不等退出（§5.2）。

### 4.13 调试前先杀干净残留 Game.exe

样本游戏（至少 Homework Salesman）有单实例行为：旧实例没死透时新实例
直接退出，症状是"注入成功但永远没有 hello"。probe 的 `stop()` 只杀它 spawn 的
子进程；手动 `Game.exe &` 起的进程会变成僵尸。**连抓两次 hello 失败，先
`taskkill //F //IM Game.exe` 再排查。**

### 4.14 XP 缺 RTP 时游戏走不到主循环

实测卡在 `Audio/BGM/012-Theme01` 加载失败，`Scene_Title#main` 抛 `Errno::ENOENT`。
补一个 26 字节静音 MIDI 占位即可通过。**真实用户缺 RTP 时 bridge 永不启动** ——
现在连接超时错误会带上 Game.ini 声明的 RTP 名和官方下载地址
（`rpgmakerweb.com/run-time-package`），不再是静默超时。

### 4.15 Marshal 不走 `const_missing`

离线解析 `.rxdata` 前必须预定义全部 `RPG::*` stub 类，否则报
"undefined class/module"。参考 `E:\rmch-samples\probe.rb`。

### 4.16 pump 挂在场景 `update` 上，等待循环会把 bridge 饿死

bridge 每帧干活靠的是 hook 场景类的 `update`。**但三代的战斗消息等待
（`wait_for_message`/`update_for_wait`/`wait(n)`）都是 `update_basic` 自旋，
不经过 `update`**——等待期间 bridge 完全不响应命令。真实游玩无感（玩家按个键
就结束了），但自动化测试会被卡死。测试侧用"自动确认垫片"解决：包住
`Input.triggered?`/`Input.trigger?`，在 `$game_message.visible` 时让
`:C`/`Input::C` 返回 true。**门控是必要的**：无条件的 C 会被战斗指令窗口的
ok-handler 收到，战斗已结束而窗口还开着时直接崩
（hs 实测：`Scene_Battle#command_attack` 对 nil subject 调 `set_attack`）。
注意有的游戏（KGC ExtTextbox 之于 Legionwood）连战斗开始的 Emerge 消息都要按键，
不装垫片连战斗都进不去。若未来要根治，可研究把 pump 加挂到 `Graphics.update`
（文件头注释说 alias 不生效，未再验证）。

**垫片的两道门控 + 取消注入**（2026-08-29 随 BLACK SOULS 实测定型）：
C 注入除了 `$game_message.visible` 外，还要求当前场景没有
「active && open && 绑了 `:ok` handler && 当前选中项无效（`item` 为 nil 或
调用即抛错）」的窗口——否则 C 会打进目标选择窗口，BLACK SOULS 的 ATB 在胜利
消息弹出时敌人窗口还开着且选区已空，原版 `on_enemy_ok` 直接
`nil.index` 崩掉游戏。发现这种窗口时不能只挡 C：ATB 开着选择窗口会暂停
AP 增长，战斗流程卡死（bridge 饿死、命令超时）——所以同时注入 **B 取消**
（cancel handler 只是关窗口，对 nil 状态安全）。反面教材：门控做成
「有任何 active 窗口就不按 C」会把 hs 卡死——它的 `Window_BattleVictory`
是激活状态的纯展示窗口（没绑 `:ok` handler），胜利等待正需要这个 C 来确认。
窗口 handler 的 ivar 名各游戏不同：原版脚本 `@handlers`，BLACK SOULS 的
魔改底层脚本是 `@handler`（单数）——两个名字都要查。另外 BLACK SOULS 的
`Window_Selectable#process_handling` 走的是 `Input.trigger?` 而非
`triggered?`（同 §4.20 的改名一类），垫片的方法名探测必须两个都认。

**命令窗口的 handler 键不是 `:ok`**（2026-08-29 随 BLACK SOULS II 实测定型）：
门控 2 原本只查 `hh[:ok]`，但 `Window_Command` 系的 `call_ok_handler` 按
`current_symbol` 派发——BLACK SOULS II 的 `Window_ActorCommand` handler 键是
`:attack/:skill/...`（没有 `:ok`），胜利消息弹出时它仍处于激活态（LNX ATB
在指令输入阶段被杀敌打断）。旧门控漏掉它，注入的 C 触发 `command_attack` →
`select_enemy_selection`，敌人全死后「敵選択点滅」脚本对
`nil.sprite_effect_type=` 抛错，**游戏弹窗冻结**（winwatch 抓 `#32770`
对话框类窗口实证）。修法：消息可见分支里，凡会消费 C 的窗口——数据窗看
`hh[:ok]`，命令窗看 `hh[current_symbol]`——一律 `w.deactivate` 并挡掉本次
注入，下一帧扫描干净后 C 才放行到消息等待；无 handler 的纯展示窗（hs 的
`Window_BattleVictory`）照旧不挡。另注意该作的
`Scene_Battle#update_message_open` 在消息 busy 且状态窗未关时会把消息窗
openness 拍 0——「消息在显示」必须以 `$game_message.visible` 为准，不能看
openness。

### 4.17 合成进战斗必须复刻完整入口路径

裸 `BattleManager.setup` + `SceneManager.call(Scene_Battle)` 会在胜利时崩
（`process_victory → replay_bgm_and_bgs` 的 `@map_bgm` 为 nil——正常流程靠
`Scene_Map#pre_battle_scene` 存 BGM）。Ace 的可靠序列：
`title_bgm.play if RPG::BGM.last.nil?` → `setup` → `on_encounter` →
`save_bgm_and_bgs` → `play_battle_bgm` → `$game_temp.entering_battle = true`
（**hs 的自定义 Scene_BattleTransition 没有它就直接 `SceneManager.return` 弹回去**）
→ 有自定义转场场景就 call 它，否则 call `Scene_Battle`。
VX：`$game_troop.setup(id)` + `$game_temp.next_scene = 'battle'`。
XP：直接 `$scene = Scene_Battle.new`（先设好 `battle_troop_id` 等），
比 `$game_temp.battle_calling` 可靠——后者被 `message_window_showing` 门控，
开场演出没放完就永远进不去。

### 4.18 杀敌计数要看 HP，不能看死亡状态

`battle.killEnemies` 最初用 `dead?`/`exist?` 复核，hs 实测 killed=0：
**自定义 refresh 可能把死亡状态的施加推迟到下一帧**，同一 tick 内 dead? 仍为 false。
改成按 `hp <= 0` 统计即可，三代通用。同理 `exp_total`/`gold_total` 只统计
dead_members——活着读必为 0，不是 hook 坏了。

### 4.19 eval 里定义类/模块必须带 `::` 前缀

`console.eval` 的 cref 是匿名类：`class Scene_Base` 会在匿名类下**新建**
嵌套常量，之后同上下文里的裸 `SceneManager`/`BattleManager` 引用可能解析到
嵌套空壳上（报 `undefined method 'setup' for #<Class:0x...>::BattleManager`）。
调试/测试里凡是 `class X` / `module X` 一律写 `class ::X` / `module ::X`。

### 4.20 定制运行时可能改名 Input 方法

hs 的 TRGSSX.dll 把 Ace 的 `Input.triggered?` 改名成了 `trigger?`（符号参数不变）。
bridge 里读键盘只有 `Input.press?(Input::CTRL)` 且有 `defined?` 保护，会优雅退化；
测试/脚本侧要用 `method_defined?` 探测后自适应。另外 KN_E 的开场 autorun 清不掉
（清了下一帧自动重启，因为自开关没机会翻），只能等它放完或直接 `$scene = Scene_Battle.new` 绕过。

### 4.21 shadow ↔ 真实目录互拷存档：二进制读 + 先读后写

`IO.read` 在 Windows 上是文本模式（CRLF→LF），会把 Marshal 存档里的 `0D 0A`
改坏——`load_game` 因此返回 false，且坏文件已经写穿了。必须
`File.open(src, "rb") { |f| f.read }`。另外 shadow 根目录的文件是真实目录的
hardlink、hs 的 `SaveData/` 子目录是 junction，**源和目标可能是同一个底层文件**：
流式边读边写会先把自己的源截断。所以 `safe_copy` 先把源整个读进内存（关闭句柄）
再开目标写——同一文件时退化成无害的原地重写。

### 4.22 删存档后"复活"：同步必须带走 shadow 副本

`syncSavesBack` 只在游戏退出时跑，把 shadow 里的 `SaveNN.*` 拷回真实目录。
早先版本拷完**不删** shadow 里的副本：用户在 GUI 删掉一个存档（只删了真实目录
那份），下次启动游戏时 shadow 重建前的"存档抢救"又把它拷回来——删了复活。
现在 `syncSaveDir`/`syncSavesBack` 带 `{removeSynced}`，同步完即删 shadow 副本
（junction 子目录不进这函数，安全）；`host.cjs deleteSaveFile` 也连带删
`runtime/rgss-shadow/<gameKey>/` 根目录和一层子目录里的同名文件。

### 4.23 存档 JSON 树 dump 的 RGSS 地雷集（save.contents.*）

- **真环路**：leg-x 的自定义 `Game_BattleAction#@battler` ↔ `Game_Actor#@action`
  互相引用——dumper 必须两遍扫描（先 `jd_count` 计引用），共享/环路节点打
  `@id`/`@ref`，否则无限递归。
- **自定义脚本可能覆写 `#class`** 返回 `RPG::Class` 实例之类——取真实类用
  `Object.instance_method(:class).bind(obj).call`。
- **1D Table 存在**（如 `$data_system.passages`）：三元索引遍历会炸。`jd_table`
  先探测维度写 `"d"` 字段，codegen 按 d 生成对应元数的循环。
- **live Fiber/Proc/Thread/IO**（进行中事件的 `@fiber`）Marshal 本来也 dump 不了：
  打 `@dead` → nil。apply 后进行中事件会重放，与 vanilla 读档行为一致。
- **对象里引用具名类/模块常量**（如 `Game_BaseItem#@class` 里的 `RPG::Weapon`）：
  打 `@cref`，apply 时 `Object.const_get` 还原。
- **`Game_Actors#@data` 在 VX 是数组不是 hash**（各代结构不一致，别假设）。
- 大 payload 下 `unescape` 用 index 扫描重写；原始行提取用 escape-aware 的
  `extract_string_field`，别用 brace_body（payload 里的花括号会误计数）。

### 4.24 bridge 数值选项钳在 ±9999

`set_options` 把 NUM_OPTIONS（`lockHpVal`/`lockMpVal`/`lockTpVal`/
`moveSpeedAdd`/`gameSpeedMulti`）钳在 ±9999（`bridge.rb` 的 NUM_OPTIONS
钳制段，与 MV/MZ 桥同范围）。BLACK SOULS II 主角 mhp=269973
（param_base 9999 被巨大 param_rate 放大），锁血写 mhp-1=269972 会被钳成
9999——不是游戏 bug。测试侧按 `min(max(1, mhp-1), 9999)` 造期望值即可
（`test-rgss-hooks.mjs` 的 lockHp 检查就是这么断言的）。

### 4.25 `wrap_method` 别名标记必须带类名

原实现别名是 `rmch_orig_<method>`：同一方法在父子类各包一层时（如 XP 的
`Game_Battler#skill_can_use?` + `Game_Actor#skill_can_use?`），父类包装里的
`method(marker)` 在 actor 实例上解析到**最派生**的别名——子类 override 若调
`super`（武界风云传 `Game_Actor#扩展` 就是这么写的），就变成 子类别名 → super →
父类包装 → 子类别名 的无限递归，`SystemStackError` 直接带走游戏（实测：游戏内
打开技能菜单即闪退）。Knight Blade 没炸只是因为它的 override 不调 super。
修复：标记改为 `rmch_orig_<ClassName>_<method>`（bridge.rb `wrap_method`）。
教训：**凡在同一继承链上包两层的方法，都要用"会调 super 的 override"回归一遍**。

### 4.26 自制/现代引擎（RGD，Ruby 3.1.2）的两个新坑

武界风云传 1.63 是 RGD 自制引擎（rgss1 API + Ruby 3.1.2，D3D11 渲染）：

- **`save.load` 必须重建 `$game_temp`**：vanilla `Scene_Load#initialize` 会
  `$game_temp = Game_Temp.new`，bridge 的 `after_load_legacy` 漏了它——这个游戏
  的 tips 系统（XdRs_PCTips）在 Scene_Map update 第一帧就 `$game_temp.has_tip`，
  nil 直接 NoMethodError 弹窗退出。已在 rgss1 分支补上重建。
- **目录搜索要按字节比**：现代编辑器写出的 `.rxdata` 字符串带 UTF-8 标记，而
  文件通道读进来的查询串是 ASCII-8BIT 裸字节——`String#include?` 跨编码直接
  `Encoding::CompatibilityError`（GUI 搜索框输中文必现）。`catalog_query` 改为
  `unpack("C*").pack("C*")` 后比较（1.8.1 也安全，不引用 Encoding 常量）。

### 4.27 图标：RGSS1 没有 IconSet，走 `icon_name` 单图管线

XP 系条目（item/weapon/armor/skill）只有 `icon_name`，图标是
`Graphics/Icons/<name>.png` 单图。管线：bridge `catalog.query` 带 `iconName`
→ `host.cjs iconFileImage(root, name)` 依次试 `.png/.jpg/.jpeg/.webp/.bmp`
（RGD 游戏实测有 jpg 图标；Windows 大小写不敏感覆盖 .PNG）→ 加密游戏再从
归档提取（v1 已支持）→ GUI `iconset.js tileByName` 同步缓存，`rm-game-icon`
加 `icon-name` prop（sheet 失败不影响按名渲染）。武界风云传图标是 loose 文件
（归档只含 Data/），1101 个图标实机渲染验证。

---

## 5. 未完成的工作（按优先级）

### 5.1 ~~命令集扩充：无敌 / 锁血 / 倍率 / 战斗~~（已完成，2026-06 实测）

`runtime/rgss-bridge/bridge.rb`（VERSION 0.2.0）已实现完整 hook 包，
命令词汇与 MV/MZ 的 `40-hooks.js` 对齐。hook 点全部来自三代默认脚本 dump
实证（`.agent/rgss-scripts/{xp,vx,ace}/` 可用 `tools/rgss-dump-scripts.mjs` 重新导出）：

- vitals：`hp=`/`mp=`/`sp=`/`tp=` 包装（无敌战斗中拒绝降血；锁血 floor 语义）
- action：XP/VX 包 `attack_effect`/`skill_effect`，Ace 包 `item_apply`
  （**`Game_Action#apply` 是 MV 独有，Ace 不存在**）；无敌做快照恢复，一击必杀
  在动作结算后 `hp = 0`
- 技能消耗：Ace 包 `skill_mp_cost`/`skill_tp_cost`→0；VX 包 `calc_mp_cost`→0；
  XP 包 `skill_can_use?`→true 且 `sp=` 拒绝降值（注意 XP `Game_Actor` 覆写
  `skill_can_use?`，要单独包）
- 奖励：VX/Ace 包 `Game_Troop#exp_total`/`gold_total`；Ace `drop_item_rate`；
  VX `make_drop_items` 重掷；XP 包 `Game_Enemy#exp`/`gold`/`treasure_prob`
- 世界：dash? hook（VX/Ace）；逐帧强制穿墙 `@through` / 不遇敌
  `encounter_disabled` / 移速（跟踪基准值）/ `Graphics.frame_rate × gameSpeedMulti`
  （按住 Ctrl 时）
- 值锁定 `lock.*`：直写 `@gold`/`@items`/`@data`；`lock.replace` 吃嵌套 JSON
- 战斗命令：`battle.info` / `battle.enemy.setHp` / `battle.killEnemies` /
  `battle.escape`。杀敌统一 `hp = 0`（Ace 的 `die()` 只清状态不加死亡状态，
  refresh 里 `@hp == 0 → add_state(death)` 才对）
- `in_battle?` 三路：Ace 查 `$game_party.in_battle`，XP/VX 查 `$game_temp`

实测（`tools/test-rgss-hooks.mjs`，每代 24 项检查，真实开新档 + 真实战斗）：

| 样本 | 引擎 | 结果 |
|---|---|---|
| Homework Salesman（自定义战斗系统+自定义 SceneManager+TRGSSX 运行时） | RGSS3 | PASS |
| Legionwood（SBS 侧视战斗+KGC 扩展） | RGSS2 | PASS（含 exp 5→10 实证） |
| KNight-Blade（开场自动演出+RTP 依赖） | RGSS1 | PASS（exp 检查为 inert：该游戏全部敌人 exp=0，无经验体系） |
| BLACK SOULS（LNX ATB 战斗系统+魔改底层脚本+steam_api 成就） | RGSS3 | PASS（2026-08-29，随垫片门控修正，见 §4.16） |
| BLACK SOULS II（LNX ATB，加密归档 700MB） | RGSS3 | PASS（2026-08-29，门控 2 补 `current_symbol` 分支，见 §4.16；lockHp 钳制见 §4.24） |

相关坑见 §4.16–§4.20。**剩余差距**：存档 JSON 树编辑已随 §5.2a 完成。

### 5.2 ~~存档读写~~（已完成，2026-06 实测）

`runtime/rgss-bridge/bridge.rb`（VERSION 0.3.0）实现 `save.list` / `save.save` /
`save.load`，槽位 id 1-based，与 MV/MZ bridge 同 payload 形状，GUI 存档页签直接用。
实现要点：

- **RGSS3 走游戏自己的 `DataManager`**（`make_filename`/`save_game`/`load_game`），
  自定义存档系统自动生效——hs 把存档放进 `SaveData/` 子目录、6 槽、附带
  `$game_stats`，全程零特判通过。读档后 `Patch.patch`（若定义）+
  `$game_system.on_after_load` + `SceneManager.goto(Scene_Map)`。
- **XP/VX 没有 DataManager**，内联 vanilla 写/读序列（XP `078_Scene_Save.rb` /
  `079_Scene_Load.rb`，VX `083_Scene_File.rb`），写完 `$scene = Scene_Map.new` 并
  按各代惯例恢复 BGM/BGS。整体替换掉存档系统的 XP/VX 游戏可能不兼容（已知限制）。
- **写穿**：`save.save` 写完立即 `safe_copy` 到真实游戏目录（坑见 §4.21）；
  `save.load` 以真实目录为准，先回拷 shadow 再读。
- **saveDir**：注入时新增 `__RMCH_REALDIR__` 占位符（`core/rgss.mjs` 传真实
  gameRoot）；state 推送的 `saveDir` = `File.dirname(DataManager.make_filename(0))`
  对应的真实目录（vanilla 即游戏根，hs 即 `SaveData/`）。host 侧
  `saveDirOf`/备份/恢复/删除零感知；`backupSaves` 加了存档扩展名过滤
  （否则 RGSS 的 saveDir 是游戏根时会把 Game.exe/归档一起拷进备份；对 MV/MZ
  是无变化 no-op，那个目录里本来就只有存档扩展名的文件）。
- scanner 的 RGSS 分支补了离线 `saveDir` 探测（有 `SaveData/` 用它，否则根目录
  有 `SaveN.*` 时用根），游戏不在跑时也能备份/删除。
- GUI `views/saves.js` 的 `slotOf()` 增加 `/^save(\d+)\.(rxdata|rvdata|rvdata2)$/i`，
  零填充与非零填充都认；QuickSave/AutoSave 之类的额外文件落"系统文件"只读区。
- 游戏内手动存的档：vanilla 布局下运行期间只在 shadow 可见（退出时回同步），
  GUI 里暂时看不到——已知取舍；junction 穿透的子目录布局（hs）无此问题。

实测（`tools/test-rgss-saves.mjs`，每代 12 项检查：state.saveDir → 开新档 →
存档 → 改金钱/开关 → 读档 → 验证回滚 → 缺槽报错 → bridge 存活）：
hs（RGSS3）/ Legionwood（RGSS2）/ KN_E（RGSS1）全 PASS，新增文件已写穿真实目录。
BLACK SOULS（RGSS3）亦全 PASS（2026-08-29）。
BLACK SOULS II（RGSS3）亦全 PASS（2026-08-29，Save03.rvdata2 43751B 写穿真实目录验证）。

**剩余差距**：无存档 JSON 树编辑遗留——已完成，见 §5.2a。

### 5.2a ~~存档 JSON 树编辑（save.contents.*）~~（已完成，2026-08 实测）

走的是 **bridge 内 Ruby dumper + Node 侧 codegen** 路线，没有给 rgss-marshal
补 reader（Ruby 自己遍历对象树最保真，1.8.1 也没有可用的 JSON 库）：

- `bridge.rb`（VERSION 0.4.0）新增 tagged-JSON dumper（`jd_*` 一族）+
  `save_contents_get` / `save_contents_apply`；dispatch 加
  `save.contents.get` / `save.contents.apply`（apply 吃 `line` 参数，与
  `lock.replace` 同款大 payload 通道）。
- tag 格式：`@b64`（非 UTF-8 字节串 base64）、`@sym`、`@i`（>2^53 整数）、
  `@f`（NaN/Infinity）、`@hash`（[[k,v]] 保 key 类型）、`@table`（含维度 d，
  data 按 x 最快序）、`@color`/`@tone`/`@rect`、`@cls`+`@iv`（通用对象）、
  共享/环路 `@id`+`@ref`、`@cref`（具名类/模块常量）、`@dead`→nil
  （Fiber/Proc/Thread/IO 等 Marshal 本来也 dump 不了的）。
- `core/rgss-savecode.mjs` 把 tagged JSON 树编译成 Ruby 源码，bridge eval 重建
  对象图；`RgssSession.send` 拦截 `{json}` → `{code, reload}` 翻译，**GUI 零改动**
  （保持 MV/MZ 词汇）；apply 超时提到 120s。
- RGSS3 走 `DataManager.make_save_contents/extract_save_contents`（key 转 symbol，
  hs 的自定义 `:stats` 键直通）；XP/VX 用 legacy 键表，未知键进响应的 `skipped`。
- update hook 加 rescue → `RMCH.report_game_error` → re-raise（game-error event，
  去重）。
- 坑全在 §4.23（环路两遍扫描、`#class` 覆写、1D Table、`@dead` Fiber、
  `@cref`、`Game_Actors` 数组 vs hash、escape-aware 行提取）。

实测（`tools/test-rgss-contents.mjs`：开新档 → get → Node 改树（gold/switch/
UTF-8 名/未知键）→ apply 验证 → `save.save`/`save.load` Marshal 往返验证）：
hs（RGSS3）/ Legionwood（RGSS2）/ KN_E（RGSS1）全 PASS。
BLACK SOULS（RGSS3）亦全 PASS（2026-08-29，contents.get 97KB / 11 个顶层键全认）。
BLACK SOULS II（RGSS3）亦全 PASS（2026-08-29，contents.get 100KB / 11 个顶层键全认）。

### 5.3 ~~加密 v1/v2 归档~~（v1 已完成，2026-09-04 武界风云传实测）

真实加密 XP 样本（武界风云传1.63，`Game.rgssad` 27.6MB / 570 条目，自制
RGSS103J 引擎）到手后完成了格式验证与实现：

- **v1 载荷密钥推导实测**（推翻部分网传文档）：索引链 key 按字段滚动
  （nameLen → 名字每字节 → size），**载荷从 size 字段之后的链上 key 开始**
  按 4 字节滚动 XOR——不是「每个文件重置为 0xDEADCAFE」。端到端验证：
  提取的 Scripts.rxdata（568KB）能被 `parseScripts` 完整解析（164 条目），
  `findMainEntryIndex` 找到 Main。
- `extractEntry` v1 开放（`payloadKey` 随索引记录）；v2 仍拒绝（无样本）。
- `patchEntry` v1 开放：条目内联布局没有 offset 表，替换 = **重写字节流**。
  索引链只按字段序列滚动、与内容无关，所以其它条目原样字节拷贝，仅目标
  条目的 size 字段与载荷重新加密写出。
- `detectRgss` 的 DLL 模式补 `[ej]?` 后缀：日版/自制引擎的 RGSS103J 等
  J 后缀 DLL 此前直接判 null（扫描器只剩 medium 兜底）。
- `tools/test-rgss-archive.mjs` 的 v1 段改为真实方案合成夹具（两条目、
  非 4 对齐长度），覆盖提取往返、异长替换、旁条目完好；v2 拒绝保留。

遗留：v2（.rgss2a）提取/打补丁仍需真实加密 VX 样本验证。明文 Data/ 的
XP/VX 不受影响。

### 5.4 ~~XP/VX 进游戏后的 hook 覆盖待实测~~（已随 §5.1 实测覆盖）

`test-rgss-hooks.mjs` 会真实开新档、进地图、进战斗，三代的场景 hook
在地图/战斗/菜单全程存活已实机确认（含进出战斗后的 lock 持续生效）。

### 5.5 其他（低优先级）

- 图标/美术：**RGSS2/3 的 IconSet sheet 与 RGSS1 的单图图标均已支持**——VX/Ace 是
  `Graphics/System/IconSet.png` 24px 格，bridge catalog 把 `icon_index`
  带成 `iconIndex`；XP 由 catalog 带 `iconName`，`host.cjs iconFileImage()`
  读 `Graphics/Icons/<name>.png`（含 jpg 等扩展名，加密游戏走归档提取，§4.27）。
  hs（加密 RGSS3）、leg-x（明文 RGSS2）、武界风云传（RGD/RGSS1）均已实机验证。
  **未做**：游戏自身不带图标资源而依赖 RTP 时（crysalis-x）没有 RTP 路径
  解析，图标列为空——优雅退化，不留空列
- `tools/rmch.mjs` CLI 加 `rgss` 子命令（目前只有 `rgss-probe.mjs` 独立脚本）
- VX 标题画面 `$data_mapinfos` 为 nil（Legionwood 实测），`map.list` 在标题期不可用

---

## 6. 已拍板/待决事项

### 6.1 传输层：已定 —— 保持文件轮询，统一在命令词汇层

结论：**不换 TCP，不做 WebSocket**。理由：

- 修改器场景 50ms 延迟无感知；文件轮询的最坏情况是"命令不到达、游戏照跑"，
  而 TCP 的 recv 阻塞会冻结游戏主循环。健壮性 > 延迟。
- GUI 统一靠的是 **bridge.rb 镜像 MV/MZ 命令词汇**（同名同 payload 形状），
  与传输层无关；host.cjs 按 gameKey 路由即可，前端零改动。
- WebSocket 握手要 SHA1 + Base64，RGSS 精简 Ruby 未必有这两个库，纯负担。

将来若做实时数据流（变量面板持续刷新、战斗实时 HP），再考虑 Winsock TCP
（非阻塞必须，`ioctlsocket FIONBIO`），已实测三版本可行，关键参数见 git 历史
或 `E:\rmch-samples\ws-probe-run.mjs`。

### 6.2 shadow 每次启动重建

重建前先把旧 shadow 里的存档抢救回真实目录（§4.12）。归档补丁采用
"末尾追加 + 覆写索引"，每次重建都是干净的一份，不会累积。

### 6.3 不支持重新打包加密归档

只读提取 + 脚本条目追加。改数据库（Items 等）不在范围内；loose 覆盖已证伪（§4.3）。

### 6.4 其他引擎评估结论（不做除非有新理由）

- **Wolf RPG Editor**：价值高但难度最大（原生 Win32 + DX Archive 加密 + 自研 VM）
- **RM 2000/2003**：EasyRPG 有现成方案，成本中等
- **TyranoBuilder / Kirikiri / Ren'Py**：视觉小说无 RPG 数值，对修改器价值低
- **Unity**：MTool 官方都放弃了，别做

### 6.5 代码状态

全部改动（含本文档）已随 **v0.3.0** 提交并发布。`npm test` 全绿。
工作记忆与参考脚本 dump 在 `.agent/`（不入库，旧名 `.workbuddy/`）。

---

## 7. 环境与样本

### 测试样本：`E:\rmch-samples\`（项目外，不入库）

| 目录 | 引擎 | 说明 |
|---|---|---|
| `knight-blade/KN_E/` | RGSS1 XP | 明文 Data/，**需 XP RTP**；已补 `Audio/BGM/012-Theme01.mid` 静音占位；XP RTP 已装到注册表指向的 `E:\rgss-test\rtp\xp`（用 `E:\rmch-samples\xp_rtp.exe //VERYSILENT //DIR=...` 可重装） |
| `leg-x/Legionwood.../` | RGSS2 VX | 明文 Data/，无 RTP 依赖；从自解压 exe 用 7-Zip 按 Cab 提取 |
| `crysalis-x/` | RGSS3 VX Ace | 明文 Data/，需 VX Ace RTP；同样是 InstallShield 自解压 |
| `hs/` | RGSS3 VX Ace | **`Game.rgss3a` 加密归档 111MB**，无 RTP 依赖 —— 主要测试目标 |

均为 rpgmakerweb.com 官方免费发布的完整游戏（Free Game Bundles）。

另有临时样本（用户本机，不保证存在）：`D:\Downloads\[RPG]BLA\BLACK SOULS` ——
BLACK SOULS 1.1，RGSS3 加密归档 147MB，LNX ATB 战斗系统 + 魔改底层脚本
（`@handler` 单数、`Input.trigger?`），是 §4.16 垫片门控的定型样本。
`D:\Downloads\[RPG]BLA\BLACK SOULS II` —— RGSS3 加密归档 700MB，同系 LNX ATB，
是 §4.16 命令窗口 `current_symbol` 门控与 §4.24 数值钳的定型样本（脚本已 dump
在 `.agent/rgss-scripts/bs2/`，239 个）。

### 分析脚本（在 samples 目录，未进项目）

`probe.rb`（Marshal 解析）、`rgss-inject.rb`（脚本注入）、`rgss3a.py`（归档读取）、
`rgss-patch.py`（归档打补丁）、`build-shadow.ps1`（shadow 构建）、
`gen-fixtures.rb`（生成黄金参考）、`ws-probe-run.mjs`（Winsock 可行性探测）。

### 环境依赖

- Windows + Node 22（项目要求 ≥18）
- **运行时不依赖 Ruby**。Ruby 4.0.2（本机有）仅用于生成 fixture 和离线分析
- 7-Zip 在 `C:\Program Files\7-Zip\7z.exe`（解自解压包用）

