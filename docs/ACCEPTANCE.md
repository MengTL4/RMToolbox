# RMCH 验收记录

## v0.6.0：sealed 启动器 MZ 游戏落地（停不下来的轮回 v1.4 实测）（2026-09-02）

用户请求适配 `D:\Downloads\停不下来的轮回正式版v1.4.1`（国产放置轮回类，NW.js）。
这个游戏是第五种发行形态：**整个 MZ 引擎 + 游戏逻辑被 javascript-obfuscator 混进一个
4.3MB 的 IIFE（`game.js`）**，由 Vite 打包的启动器页在 md5 校验后用 `<script>` 注入执行；
MZ 的数据文件加密在 `game.data`（启动时解到 `window.Game.data` 用完置 null）。
后果：页面上**没有任何引擎全局**——无 `$gameParty`、无 `DataManager`、无 `SceneManager`，
连 `$data*` 表都不在 window 上。扩展注入本身工作正常（v0.5.0 时代用户实测 bridge 已注入、
state.json 已写出），但 resolver 全空、hook 60 秒后放弃（gameRoot 下那份
`RMCH/runtime/bridge-state/unknown/` 就是那次残留）。

### 方案：extension 通道不动，CDP 堆扫描做「引擎发布」

NW.js 游戏可以带 `--remote-debugging-port`，而 CDP 有 `Runtime.queryObjects`——
按原型全堆枚举。实测一次扫描 ~31 万个对象、数秒完成、游戏无感（Runtime.enable 安全，
Tauri 那套看门狗不适用于 NW.js）。流程（`core/sealed-seed.mjs` + `tools/seed-sealed.mjs`
detached 进程）：

1. launch 时给游戏进程加 seed 端口，并派一个 detached seeder；
2. seeder 轮询 CDP：启动器页可见且按钮文案是「开始游戏」时自动点掉（更新中不动）；
3. `__PIXI_APP__` 出现（游戏引导完成）后做堆扫描，按字段形状捞引擎对象并发布到 window：
   `$game*` 单例、`$data*` 表、`SceneManager/DataManager/ConfigManager/StorageManager`、
   以及从实例 `.constructor` 反发布的 `Game_*` 类；
4. 给每个单例的**原型 `initialize` 打补丁**：新游戏/读档会整体重建所有 `$game*`，
   包装器把新实例重新发布到 window，引用永久保鲜（真机验证：`fake.initialize()` 后
   `window.$gameParty` 立即跟随替换）。

### 扫描器踩过的形状坑（全部真机修正）

- **switches/vars 无法靠字段区分**：`Game_Switches` 与 `Game_Variables` 同形，且启动时
  `_data` 都是空数组（首版 seed 把两者混进一个桶、丢掉其一）。用越界读探针区分：
  `value(999999)` 强转布尔返回 `false`（开关）、返回 `0`（变量）。
- **数据表是自定义 schema**：物品表没有 `atypeId`（泄漏样本证实），首版
  `itypeId && atypeId` 匹配不上。改为 itypeId→物品、wtypeId→武器、atypeId→防具。
  另有**成对的模板副本表**（物品/武器/防具各两份 2001 行，轮回重置用的克隆）——内容
  相同，取第一个无害（单例桶重复仍告警）。
- **Game_Screen 被改**：无 `fadeOut` 方法（按 `_brightness + _flashColor` 识别）；
  **Game_Troop 无 `_units`**（按 `_troopId` 且无 `_phase` 识别，与 BattleManager 区分）。
- **BattleManager/JsonEx/ImageManager 找不到的真正原因**（第二轮真机修正）：这三个在本游戏
  里和 SceneManager 一样是**带静态方法的函数**，而种子函数的「对象形状分支」前面有个
  `typeof x === "function"` 早退分支把它们直接跳过了。函数分支补上
  `startBattle+isBattleTest`（BattleManager）、`maxDepth+_encode+stringify`（JsonEx）、
  `loadSystem+loadFace`（ImageManager）后全部命中。

### 当天补强（第二轮真机）：图标 / 战斗 / 存档树编辑器全部解锁

用户追问三件事，逐一落地：

- **列表图标**：GUI 的图标子系统（`entry-list` + `assets.iconset`）本来就是现成的，
  卡壳点只是种子没发布 `ImageManager`。补上后 `assets.iconset` 实测返回解码好的
  IconSet（512×768 dataUrl）——游戏 img 目录是明文，解码走游戏自己的加载管线。
- **存档数据树编辑器**：此前验收结论「无法离线解析」是**错的**——`save.contents.get`
  走的是**内存路径**（`DataManager.makeSaveContents` + `JsonEx.stringify`），跟加密的
  存档文件无关。发布 `JsonEx` 后实测返回 60KB 完整树（system/screen/timer/switches/
  variables/selfSwitches/actors/party/map/player 十键）。
- **战斗功能**：BattleManager 发布后，bridge 的 sealed 慢重试自动补装 hook（27→29：
  `BattleManager.makeRewards/gainRewards`），倍率/一击必杀路径就绪。
- **活集合判定（重要）**：堆里发现同一单例有**多代副本**（轮回快照/存档预览解码遗留，
  3 个 party 候选里只有一个是活的——步数在涨那一个）。形状猜「第一个」不可靠，改为
  **优先调 `DataManager.makeSaveContents()`**：它返回的就是闭包活引用集合，实测发布后
  `window.$gameParty === makeSaveContents().party`。新鲜度补丁同步调整：`JsonEx._decode`
  包装（第一版方案）会**误伤存档预览解码**——预览也解码完整对象树，会把 window 引用
  换成预览副本——改为包装 **`DataManager.extractSaveContents`**（只在真读档时触发，
  读完后重新发布 makeSaveContents 活集合），同时覆盖游戏自带读档和 save.contents.apply
  两条路径。

### 实测结果（真机，WS 通道 = GUI 同路径）

launch → seed 全自动：**2.5 秒自动点掉启动器、8 秒完成发布、37 个对象、0 警告、
hook 安装 27 个**（gainExp/gainGold/setHp/setMp/setTp/canPaySkillCost/skillMpCost/…，
含 window.Game_* 原型与 runtime 原型链双路）。命令实测：`gold.set` 999999、
`item.add/set/list`（怪物图鉴 ×3）、`switch.set`、`variable.set`、`actor.level.set`
21→50、`actor.vitals.set`、`trainer.options.set`（invincible/goldRate）、`save.list`
（加密 .rmmzsave 正常列出）、`party.info`、`runtime.info`（title 读到「停不下来的轮回」）。
测试后状态已复原（gold 0 / Lv21 / hp396 / mp418 / 物品清空 / 开关变量复位）。

### 全量功能实测（tools/e2e-sealed.mjs，49/49 通过）

回应「功能都测试一遍」：新写 `tools/e2e-sealed.mjs`（对齐 e2e-tauri.mjs 惯例的真机
冒烟脚本，连 ws /client 通道，49 项检查、每项变更后自动恢复状态）。覆盖：ping/runtime
信息、hook 数量、trainer 选项往返、金币 set/add、物品 set/list、物品/技能/状态目录
（含 iconIndex）、角色 exp/param/vitals/recover/name/nickname/skill learn+forget/
state add+remove、队伍加减人/recover、开关/变量列表与写入、地图列表/信息/事件、穿墙
开关、战斗命令（非战斗期优雅空转）、**值锁（金币锁定 1.3s 内把 999 拉回 500）**、
存档槽列表、真存档（file20 落盘后清理）、存档数据树 get/apply（apply 后活引用恒等）、
console.eval、IconSet 图集。git 状态：49/49。

**测出一个真 bug 并修复**：这游戏完全自建主循环——实测 `SceneManager.update` 2 秒内
被调用 **0 次**（MZ 标准循环根本没跑），导致「数据锁定」依赖 updateMain 包装器的
每帧重申路径全部失效（金币锁不生效）。修复：bridge 的 100ms 心跳定时器同时跑
`applyValueLocks()`（无锁时空转，与帧路径幂等），任何游戏循环形态下锁都生效。
注意：`gameSpeedMulti`（按住 Ctrl 加速）依赖 updateMain 帧差，在自建循环游戏上
仍不可用——本作是放置游戏无影响，已记录为限制。

### 顺带修复与新能力

- **scanner**：新增 sealed 指纹（game.js/game.data/game.version/game.md5 四件套 +
  js/libs MZ 库或 .rmmzsave 存档）→ engine=MZ(medium)、container=`nwjs-sealed`；
  exe 解析增加「manifest 名.exe → 根目录唯一 exe」兜底（Nightmare without return
  原本报找不到 exe，现在也能解析到）。
- **bridge 90-startup**：`RMCH_SEALED=1` 时 hook 重试不封顶——先快速重试到首次稳定，
  之后降为 5 秒永久慢重试（读档后才会出现的类也能补上 hook；patchMethod 幂等）。
- **attach**：sealed 游戏显式拒绝并给出原因（发布引擎对象必须有 CDP 端口，只能工具箱启动）。
- **gameSpeedMulti（按住 Ctrl 加速）依赖 MZ 标准主循环，自建循环的游戏（本作）不可用**；值锁已有 100ms 时钟兜底，不受影响。
- 存档**文件**为自定义加密（熵 7.99），离线解析存档文件不可行；但「存档数据」树编辑器
  走内存路径不受影响（见上）。存档槽位列表/备份正常。`save.load`/`save.contents.apply`
  已由 extractSaveContents 包装保障引用保鲜，未做破坏性实测。

## v0.4.3：RGSS 附加真机落地（BLACK SOULS Ⅰ/Ⅱ 实测）（2026-08-30 凌晨）

RGSS 附加此前从未真机验证过——用户拿 BLACK SOULS Ⅰ/Ⅱ（VX Ace / RGSS3）一测就挂。
连修三层：

### ① ruby-symbols-missing：RGSS3 压根不导出 Ruby C API

rgsshook 原来按名字找 `rb_eval_string_protect`——但 RGSS3 的 DLL（RGSS300.dll 等）
只导出 27 个**引擎 API**（RGSSEval / RGSSGameMain / RGSSInitialize3 / …），Ruby C API
一个都不导出。修复：resolveRuby 先试引擎官方导出 **RGSSEval**（RGSS1/2/3 三代同名），
`rb_eval_string_protect` / `rb_eval_string+rb_protect` 留作 RGSS1/2 时代 DLL 的回退。

### ② RGSSEval 的 eval 上下文 cref 不是 Object：顶层 def 悬空

eval 跑通了但 bridge 起不来：bridge.rb 顶层 `def rmch_pump` / `def rmch_hook_update`
在 RGSSEval 的 cref 下**不落在 Object 上**（探针实测：self 是 main、Object 方法表里
却没有），随后 `rmch_hook_update(Scene_Base)` 直接 NoMethodError（靠 bootstrap 的
rescue 写 attach-error.log 才看见）。修复：这两个方法改用
`Object.send(:define_method)` 显式挂到 Object（块内 `return` 换 `next`）。

### ③ Scene_Base 捷径被子类绕过

钩子装上了但泵不转：VX/Ace 分支只 alias `Scene_Base#update`，而自定义引擎
（BLACK SOULS 的场景框架）**子类重写 update 且从不 super**。修复：Scene_Base 之外，
把所有定义了自己 `update` 的 Scene_Base 后代也逐个 hook（调 super 的子类至多一帧
多泵一次，connect/pump 幂等、offset 自卫，无害）。

### ④ alias 链遇 super 无限递归（RGSS2 真机暴露，VxAce 同样隐患）

RGSS1/2 真机首测（见下）又炸出一层：Scene hook 用 `alias_method` + 按名调用
`rmch_update_orig`，当**父类和子类都被 hook、且子类 update 里调 `super`** 时，
父类包装器里的按名调用会以 self 的真实类重新解析——又落回子类别名，两个包装器
互踢直到 `SystemStackError: stack level too deep`（Star Stealing Prince 的
Paradog 自定义 Scene_Title#update 第一帧就 super，100% 复现；VX 默认库里
Scene_Map/Menu/Battle 等十几处 update 都带 super，BLACK SOULS 没踩中纯粹因为
它的场景从不 super）。修复：hook 时把当前 update 捕获成 **UnboundMethod**，
包装器 `orig.bind(self).call(*args)` 直接调捕获体，不再按名查找，从根上断环；
`rmch_update_orig` 别名仅留作「已 hook」标记。

### 实机验证

- BLACK SOULS：附加 → `party.info` / `save.list` 正常应答（GUI 路由 RGSS 会话）。
- BLACK SOULS II（干净进程）：一次 attach 直接上线。
- 两款内嵌的都是魔改 RGSS300.dll（内嵌 Ruby 1.9.2）。
- 注意：BLACK SOULS **失焦会暂停主循环**（Graphics.frame_count 冻结），此时命令无
  响应、激活窗口即恢复——游戏自身行为，不是工具箱故障。
- **RGSS2（VX）**：Star Stealing Prince 3.4（RGSS202E.dll，Ruby 1.8.1）——修复④后
  附加全程稳定（修复前 5~9 秒必崩）；hello/state 推流正常，`party.info` /
  `save.list` / `item.list` / `gold.set` 全部应答正确（gold 经独立探针复核落点），
  标题→Scene_Map 场景切换正常、游戏画面可玩。
- **RGSS1（XP）**：Last Scenario v1.22（RGSS104E.dll，Ruby 1.8.1）——附加稳定，
  标题态 `party.info` 正确报「no save loaded yet」守卫错误，开新档进自定义
  Scene_Intro 后 `party.info` 读到 gold=20、`gold.set` 77777 写入经探针复核生效。
- RGSSEval 三代同名已逐代证实（RGSS104E/202E/300 均只有此引擎导出，无 Ruby C API）。

## v0.4.2：附加注入存活率 + 物品数量整数化（2026-08-30 凌晨）

用户报告两件事：①物品/武器/防具数量出现小数；②「附加到运行中」对三个带保护的
游戏（Nightmare without return / 再刷一把 PlayAgain / 三国志潜龙在渊）会导致闪退或
卡死（MTool 的附加同样挂，其主动注入正常）。逐项排查结果：

### ① 数量小数 —— 游戏侧数据，工具箱读写两端已收口

桥接全部写入路径（item.add / item.set / 锁定值）本来就逐个 `Math.floor`；
小数来自游戏自身：倍率/增幅类插件会在容器里存 2.5 这样的分数。顺藤摸瓜还发现
**再刷一把把 `Game_Party.prototype.gainItem` 换成了 native 空操作桩**——旧的
item.set 走 gainItem 等于什么都没写。修复（bridge 侧，`62-commands-party.js`）：

- item.set / item.add：先正常调 gainItem（能吃插件簿记的游戏不受影响），随后
  **校验结果并对不上就直接写容器**（等效 gainItem 本体：写槽位 + map.requestRefresh），
  空操作桩和放大插件都被钉回精确值。
- item.list：数量**显示层取整**（`Math.round`），不动内存原值；RGSS 侧本来就 `.to_i`。
- GUI 数量/锁定值输入框 `precision=0`，输不进小数。

实机验证：再刷一把附加后 item.set 5018 号防具 1→5→(+3)→8→复原 1，全部精确；
harness 新增两条断言（分数显示取整、桩 gainItem 下 set/add 落点精确）。

### ② 附加注入闪退/卡死 —— 游戏反篡改扫描撞见常驻 DLL，已修

实机复现：附加本身成功（eval state=1、bridge 注入、WS 连上），但 40~70 秒后游戏
进程组整体消失，`Crashpad/reports` 留下新 dump——异常码 **0xE0000008**（自定义
代码 + ntdll 地址），是游戏**周期性完整性扫描发现常驻的 rmch-mvhook.dll 后主动
崩溃**，不是注入失败。对照实验：同一游戏走启动注入（扩展路径，零外来原生代码）
挂同样的 bridge/hooks 长时间存活——它们只查原生残留，不查 JS。

修复（两条都在 `runtime/inject/` + `core/attach.mjs`）：

- **mvhook.dll 评估完立即自卸载**（FreeLibraryAndExitThread；失败路径同样卸载），
  顺带释放 bootstrap 缓冲。外来模块暴露窗口从「永久」缩到几秒。
- **attach 逐个渲染器尝试、成功即停**（原来不管成败全部注一遍）；普通渲染器优先，
  `--extension-process` 排后（再刷一把/梦魇无归这类游戏本体就是 chrome-extension
  页面，只有 extension 渲染器，排后但不跳过）。

### ③ 连带发现：潜龙在渊附加后工具箱「找不到游戏」—— WS 被拦，已修

这个游戏（新版 x64 NW，扩展页形态）页面里的 `new WebSocket("ws://127.0.0.1:47412")`
**根本连不上**（扩展页 CSP / Private-Network-Access；x86 老 NW 的那两个不受限），
bridge 静默退回 commands.jsonl/events.jsonl 文件通道——而服务器原先只认 WS 会话，
于是 GUI/CLI 全看不到它。修复：`BridgeServer` 新增 `stateDir` 选项，**收养文件通道
会话**（state.json 每秒重写即心跳；命令写 commands.jsonl、从 events.jsonl 按
commandId 收结果；WS 会话优先；state.json 陈旧即摘除）。host.cjs / serve.mjs 均已传入。

### ④ 再连带：潜龙在渊的僵尸 WS 会话（pong 通、命令不通），已修

GUI 重启后出现更刁钻的状态：潜龙在渊重连上了 WS（会话显示 alive、传输层 ping/pong
正常），但**应用层命令全部 20 秒超时**——同一时刻它的文件通道明明活着（state.json
每秒更新，手动往 commands.jsonl 追加命令 65ms 内执行并回结果）。即「半死 WS 会话」
挡住了文件通道的收养（WS 优先规则），游戏在工具箱里看得见、用不了。修复
（`core/ws-server.mjs`）：

- **命令超时即剔除会话**：WS 会话的 cmd 超时后主动 drop，让文件收养或 bridge 自重连
  接管，不再僵死占座。
- **先探测后顶替**：某游戏已有新鲜文件会话时，新 WS 连接必须先用应用层 `ping` 命令
  自证（8 秒），应答才转正替换；不应答的僵尸连接安静丢弃，永不顶掉可用的文件会话。

实机验证（v0.4.2 全部本机真游戏跑过）：

- 三个保护游戏：附加 → bridge 可用 → **长时间存活不闪退**（再刷一把顺带验证 item.set
  精确写）；潜龙在渊经收养的文件会话正常应答 party.info 等命令。
- 僵尸会话修复后：5 个测试游戏（含潜龙在渊）console.eval 全部即时应答。
- 回归：三国真龙传（NW 0.29 x86，3 hooks）、大千世界2 Demo（x64）附加一切正常。
- `npm test` 全绿（含 ws-server / bridge-harness 新断言 / gui-check 哨兵）。

注意：RGSS（XP/VX/VX Ace）的「附加到运行中」依然没有真机验证过——本机没有这类游戏。

## v0.4.1：GUI 内嵌 Node 16.1 兼容热修（2026-08-29 深夜）

用户报告两个「启动并注入」问题，排查结论一真一假：

### ① 再刷一把 PlayAgain（L3 shadow）GUI 启动报 "cpSync is not a function" —— 真 bug，已修

GUI 的内嵌运行时（借用的 NW 0.54）Node 版本是 **16.1.0**（CDP 实测 `process.version`），
而 `fs.cpSync` 要 **16.7** 才有；CLI 走系统 Node 所以同样的启动在命令行完全正常。
连环挖出两个同类坑，都在 shadow 重建路径上：

- `shadow-launcher.mjs` 三处 `cpSync`（全是单文件拷贝）→ 换 `copyFileSync`。
- **Node 16.1 删不掉 junction**：`rmSync(junction, {force:true})` 抛 `ERR_FS_EISDIR`
  （junction 是 mount point，fs.rm 的 unlink 路径不吃；新版 Node 才自动改走 rmdir）。
  实测 16.1 上 `rmSync(junction, {recursive:true, force:true})` 正常且**不穿透**——
  只删链接本身，目标目录内容完好。`junctionDir` / bg-script 抠除 / `linkOrCopyFile`
  三处统一成 recursive rm。这是「第二次启动 shadow 游戏必挂」的根因：首次建影子
  （全量 junction）成功，重建时逐个删不掉旧 junction。
- 防回归：`gui-check.mjs` 新增对 gui-bundle 全部模块 + host.cjs 的「Node 16.1 没有的
  API」扫描（`MODULES` 从 gui-bundler 导出）；已知超新 API（`.at()`、`structuredClone`
  等）grep 确认全仓库零使用。

实机验证（GUI 内 CDP 驱动真实 `server.launch`）：再刷一把 PlayAgain shadow 启动成功、
bridge 连上、23 hooks、MV 1.6.1 识别正常。

### ② 真龙传（MV 1.6.1 / NW 0.29 x86）启动后修改器找不到游戏 —— 打包竞争，非代码 bug

用户环境里游戏能起、bridge-state 连「bridge injected」都没有——注入压根没发生。
逐变量隔离实验（同一游戏、同一 profile，只换 `--load-extension` 路径）发现：

- 仓库的 `runtime/bridge` 注入正常；staging 的 `output/release/RMToolbox/runtime/bridge`
  必败——尽管两边文件 md5 逐字节相同、无 ADS、非 junction。
- 同一目录改个名（`bridge-cursed`）就正常；改回 `bridge` 也正常了——**目录内容无辜，
  是当时的状态不对**。

真相：用户是从 `output/release/RMToolbox/`（pack-release 的 staging 目录）运行的工具箱，
而两次「找不到游戏」都发生在打包进行中——`pack-release.mjs` 先 `rmSync(staging)` 再重建，
游戏进程恰好在 bridge 目录被删到一半时启动，扩展加载静默失败（老 NW 对坏扩展零提示）。
游戏窗口正常是因为 app 本体在用户自己的目录里，不受影响。

结论与对策：**staging 是构建中间产物，每次打包都被整个清掉重建，不能当安装目录用**。
对用户：运行解压后的 release zip（或仓库 dev GUI），别碰 `output/release/`。launcher
不需要改：extension/shadow 两条路径都只在游戏启动瞬间读 bridge 文件，release zip 使用
方式下不存在这个竞争窗口。

## v0.4.0：附加到运行中（MTool 式 DLL 注入，2026-08-29）

用户要求：游戏已经自己开起来了，RMCH 也能连上去（对标 MTool 的附加方式），
只覆盖 RPG Maker 系列。新增 `core/attach.mjs` + `runtime/inject/` 原生层
（injector + mvhook/rgsshook 两个 DLL + vendored MinHook），GUI 游戏库卡片新增
「附加到运行中」按钮，CLI 新增 `rmch.mjs attach <gameRoot>`。

### 机制（均不改游戏文件，游戏退出即还原）

- **MV/MZ**：CreateRemoteThread 把 `rmch-mvhook.dll` 送进渲染进程 → 解析 nw.dll
  导出表里的 v8 C++ 符号（mangled 前缀匹配）→ MinHook detour `v8::Function::Call`
  → 在自然的 V8 调用点 `Script::Compile+Run` bootstrap（设 RMCH_* env + eval
  page-bridge.js）→ bridge 走既有 WS 通道连上。结果经命名管道
  `\\.\pipe\rmch-attach-<pid>`（u32le 分帧 JSON）回报给 Node 侧。
- **RGSS**：SetWindowsHookEx 把 `rmch-rgsshook.dll` 挂进游戏主线程 →
  `rb_eval_string_protect` 执行渲染后的 bridge.rb → 文件通道落在
  `runtime/rgss-attach/<gameKey>/`（不污染游戏目录）。

### 过程中攻克的真机问题

1. **x86/x64 的 v8 ABI 都走隐藏 out 指针**：`Local<T>`/`MaybeLocal<T>` 带用户构造
   函数，不满足寄存器返回条件——x86 下 out 指针是静态函数第一个栈参（成员函数在
   this(ECX) 之后），x64 下是 RCX 之后的 RDX；而**按值传参**的 Local 是原始句柄值
   直接压栈。两条结论都来自对 nw.dll 的反汇编验证（`Function::Call` 序言/尾声、
   `Run` 的 `and (%ecx)` 单次解引用）。
2. **RequestInterrupt 回调里 Compile 必崩**（NW 0.29 x86 整树消失、无 WER 记录）→
   eval 改在 detour 内做（与 MTool 的 mzHook32.dll 同思路）。
3. **NewFromUtf8 在静态标题画面约 17 秒才调一次** → 主触发器换成 Blink 每帧 rAF
   必经的 `v8::Function::Call`（约 30ms 内触发）。
4. **NW 渲染进程有多个 V8 context**（先捕到的常是扩展背景页）→ bootstrap 判定
   非游戏页即 throw，DLL 见空结果释放 claim、400ms 限频重试下一个 context。

### 验证

- `npm test` 全绿，新增：`tools/test-attach.mjs`（PE 解析 / bootstrap 组装与语法
  校验 / 管道分帧回环含拆分写入，17 项）与 `tools/test-inject-selftest.mjs`
  （注入器 CRT+WH 两种模式对自测目标进程的真机回路，win32+x64 各 7 项）。
- **真机（MV/MZ）**：真龙传（MV 1.6.1 / NW 0.29 / **x86**）与 刷啊刷（MV 1.6.1 /
  **x64**）各自双击启动后 attach → WS 桥接连上、`trainer.options.get` 返回 36 个
  hooks、游戏全程存活。重复 attach 幂等（DLL 引用计数 + bootstrap 自检）。
- **RGSS attach 代码就绪但未经真机**：rb_eval_string_protect 链路只做了静态审阅，
  本机没有 XP/VX/VX Ace 游戏可验。首个 RGSS 真机 attach 通过前，此能力视为实验性。

## 用户反馈三连：绿头（MZ）无窗口 / L3 打不开 / 有声音无画面（2026-08-28）

用户反馈：黑色图标的引擎能开，绿色图标的打不开——「进程在任务管理器里、工具能列出
游戏物品，但游戏界面不出现」；另有「部分 L3 启动保护游戏打不开」「部分游戏只有声音
没有画面」。三个症状指向同一个机制：

### 诊断

1. **保护类游戏普遍隐藏窗口启动。** 本机 L3 游戏（梦魇：无归、再刷一把）的
   `package.json` 都是 `"window": {"show": false}`，靠启动链跑完后自己调
   `nw.Window.get().show()`。启动链中途卡死时：页面照样跑（bridge 活着、物品能列）、
   音频照样放（BGM），但窗口永不显示——三个症状全部吻合。
2. **共享 Chromium profile 的单实例杀。** 大量 MV/MZ 游戏 manifest 都叫 `rmmz-game`
   （本机 刷啊刷[MV]、大千世界2、再刷一把2 全是）。策略 A 原来不传 `--user-data-dir`，
   所有游戏挤同一个 profile：一个游戏活着（或有僵尸进程），下一个同 profile 游戏被
   单实例检测直接杀掉（M2 已知限制实测过：4 秒退出）；profile 被新版 NW 写过之后
   旧版游戏启动还报 "database is too new"。这解释「A 能开 B 打不开」类反馈。
3. **shadow 对子目录 bg-script 会写穿 junction。** `setupShadowApp` 原来按顶层条目
   链接，再 `writeFileSync(appDir/<bgScript>)`：bg-script 若在子目录（如
   `bg_script/boot.js`），写入隔着 junction **直接改掉游戏原文件**（且随后启动必挂）。
   这是「部分 L3 打不开」+ 原文件完整性两个 bug。

### 修复（v0.2.1 / bridge 0.3.1）

- **`90-startup.js` 窗口显示看门狗**：窗口从未可见期间（`document.visibilityState`
  为 `hidden`）每 1.5s 补一次 `nw.Window.get().show()`；见过一次 `visible` 永久撤防，
  30s 后定时器自停——不与用户最小化、游戏主动隐藏打架。正常游戏零影响
  （本机四次启动无一误触发）。
- **策略 A 加私有 `--user-data-dir=runtime/profiles/<gameKey>`**（持久不擦除，
  保住落在 `nw.App.dataPath` 的插件数据），与策略 B 同款隔离。
- **shadow 子目录 bg-script 抠除**：`linkShadowEntry` 递归处理 bg-script 路径——
  无关目录照常 junction，bg-script 所在目录在影子内重建为真实目录再写入补丁；
  原游戏文件逐字节不动。

### 验证

- `npm test` 全绿：harness **32 组**（新增第 32 组看门狗：hidden 时必须补 show、
  变 visible 后必须撤防不再补）；新增 `tools/test-shadow-launcher.mjs`（假游戏目录
  验证 junction/抠除/补丁/原文件不变 + 根级 bg-script 回归），已进 `npm test`。
- **实机**：再刷一把2（MZ，extension）+ 刷啊刷（MV，extension，同 `rmmz-game`
  profile）**同时运行、各自有窗口、bridge 均连上**——此前第二个必被单实例杀掉。
- 梦魇：无归（L3，shadow）照常启动出窗、bridge 0.3.1 连上；大千世界2（L3
  node-main，extension）此前已验证。

## 存档数据编辑器换成 MTool 同款 jsoneditor 原生树（2026-08-27 晚）

「数据 › 存档数据」的手写树（`ui/parts/json-tree.js` 509 行 + 可逆操作层 `json-ops.js`）
整体替换为 **vendored 的 jsoneditor 10.4.3 完整版**（josdejoin，含 ace + ajv，zh-CN 语言包）
——逆向 MTool 的 `loader.bin` V8 字节码确认它的「数据修改」就是这个库、这套配置。
两个主按钮（`更新数据` / `应用至游戏`）用 teleport 塞进 jsoneditor 自己的菜单栏
（MTool 的 `#jsoneditor-search-updateDataB` 同款手法）；模式切换会重建菜单栏，
壳在 `onModeChange` 里 re-resolve teleport 目标。主题覆盖在 `app/gui/jsoneditor-theme.css`
（深/浅双主题，挂 `body.rm-dark` / `body.rm-light`）。`tools/gui-check.mjs` 新增 vendor
断言：sprite 路径可落盘、bundle 走 UMD 全局分支、zh-CN 语言包在。

### 实机验证（刷啊刷，MV L1，策略 extension，全程 CDP 驱动）

- **载入**：`更新数据` 拉 2.6MB 存档，`setText` 实测 754ms（jsoneditor 每个值建一个
  Node 对象，DOM 才是懒渲染；`maxVisibleChilds: 100` 压住宽数组）。
- **动作菜单五件套**：复制（dup 行出现、dirty 置位）/ 移除 / 改类型（number→string，
  value class 切换）/ 追加（父对象**最后一个子项**的菜单里才有——v10 源码行为，MTool 同款）
  / 插入（落在目标行之前）。行内编辑是 **Tab 跳格、失焦提交**——Enter 在字段格不推进
  （v10 的 Enter 只作用于值格的 URL 场景），自动化时别按 Enter 当 Tab。
- **撤销重做**：Ctrl+Z / Ctrl+Shift+Z 走 `cdp.mjs` 新增的 `key` 命令（真实
  `Input.dispatchKeyEvent`，jsoneditor 的历史栈挂在容器 keydown 上）。连续撤销到
  历史耗尽，树内容、行数、undo 按钮禁用态全部回到 pristine。
- **搜索**：`_hang` 3 个结果，‹› 顺序走、wrap 回第一个、prev 回退正确
  （结果计数文案 "N results" 是库里硬编码英文、不走 i18n——MTool 同款，非 bug）。
- **排序 / 变换弹窗**：菜单栏按钮打开正常（变换 = JMESPath 查询 + 预览 + 向导；
  弹窗里的英文说明同样是库内硬编码）。
- **六模式切换**：树/表单/视图/代码/文本/预览逐一切过，teleport 的两个按钮全程存活。
  代码模式 **ace 高亮确认**（`ace_variable` / `ace_paren` 语法 span 在文本层里）——
  之前「ace 只有一行空行」的疑点是**窗口被遮挡时 rAF 冻结、ace 增量渲染停在半截**，
  窗口可见即正常。文本模式的 textarea 是 10.4MB：2.6MB 紧凑源的美化排版展开（4×），
  模式切换重就是这个体量。
- **回写往返**（上一会话）：改 `party._gold` → `应用至游戏` → 游戏内读回新值。
- **dirty 语义修复**（本轮发现并修）：原来 onChange 只置位不清位，全部撤销后
  「有未应用的修改」tag 还在、`更新数据` 会误弹确认框。现在 onChange 后 400ms 防抖
  对比 `editor.getText()` 与源文本，相等则清标记（`load`/unmount 清定时器）。
  修复后重启 GUI + 重启游戏全链路复验：复制 → dirty=true → Ctrl+Z → dirty=false、
  行数恢复、undo 耗尽。
- 截图：`runtime/screenshots/data-tree-jsoneditor.png`（深色）、`-light.png`（浅色）。

### 顺带

- `cdp.mjs` 新增 `key <combo>` 命令（修饰键位掩码 + vk 映射，真实 keyDown/keyUp），
  补上「撤销重做要真实按键」的空档；顺手修了报错路径不关 websocket、进程挂到超时的问题
  （`session.close()` 挪进 `finally`）。
- vendor README 里 Naive UI 版本写错成 2.40.4，实际 bundle 是 2.35.0（已核对修正）。

## runtime/ 重整：bridge 拆分 + 构建期校验（2026-08-27 上午）

上一轮整理了 `app/gui/`，这一轮对 `runtime/` 做同样的事：文件命名、结构、死代码。

### 出发点：三个结构性问题

1. **`page-bridge.js` 是 8 个文件拼出来的 2552 行，任何一个都不是合法 JS。**
   `00-bootstrap.js` 打开 `(function () {`，`90-startup.js` 才闭合，中间全部靠 2 空格缩进
   活在这个函数体里。后果：单个 part 无法 `node --check`、无法 lint，拼出来的语法错误
   表现为「游戏启动了但没有 bridge、也没有任何提示」。
2. **文件名不说明内容。** `00-bootstrap.js` 里有 200 行引擎解析器（跟 bootstrap 无关）；
   `10-runtime-data.js` 自己的注释写的是「Small helpers shared across all bridge parts」；
   `60-command-router.js` 889 行塞了 15 个领域，靠 `// --- gold ---` 这种横幅注释当结构。
3. **`runtime/` 把源码和垃圾混在一起。** 唯一的手写代码 `bridge/src/` 旁边堆着 188MB
   的 shadow-apps/profiles、11 张调试截图（两套命名 `gui-screenshot-*` 和 `gui-shot-*`）、
   日志、token。其中 `shadow-profiles/`（8.5MB Chromium profile）和截图都没进 .gitignore。

### bridge 拆分：8 个文件 → 19 个

排序前缀保留（它就是 concat 顺序），但每个文件现在只干一件事：

| 新文件 | 内容 | 来自 |
|---|---|---|
| `00-prelude.js` | IIFE 开头 + `bridge` 状态对象 | 00-bootstrap |
| `05-node-io.js` | require/fs/path、路径、log/event 写入 | 00-bootstrap |
| `10-engine.js` | `TK.$` 别名解析、`$game*`/`$data*`、钩子目标 | 00-bootstrap |
| `20-values.js` | 数值强转、参数守卫、抑制作用域、统计 | 10-runtime-data |
| `25-battlers.js` | battler/队伍/敌群访问、`actorInfo` | 10-runtime-data |
| `30-catalogs.js` | 目录缓存、背包槽位、地图数据 | 10-runtime-data |
| `40-hooks.js` | `patchMethod` + 倍率/遇敌/移速/技能消耗 | 30-hooks |
| `45-vitals-locks.js` | 上帝模式：HP/MP/TP 锁 | 30-hooks |
| `50-value-locks.js` | 数据锁定：逐帧回写 | 30-hooks |
| `55-transport.js` | WS 客户端 + JSONL 兜底队列 | 40-transport |
| `58-state.js` | state.json 快照 | 50-state |
| `60-commands-core.js` | ping / runtime.info / 修改器选项 / console | 60-command-router |
| `62-commands-party.js` | 金钱、背包、队伍、角色 | 同上 |
| `64-commands-world.js` | 开关、变量、地图、事件、战斗 | 同上 |
| `66-commands-saves.js` | 存档槽、存档树、数据锁定 | 同上 |
| `68-commands-system.js` | 场景 push/pop、修复错误、新游戏 | 同上 |
| `69-router.js` | 冻结命令表 + `execute()` | 同上 |
| `70-profiles.js` | per-game profile 加载器（未动，只补注释） | — |
| `90-startup.js` | 定时器、启动、IIFE 闭合 | — |

命令表改成和 GUI 的 store 一样的切片模式：`00-prelude.js` 建 `commandHandlers`，
每个 `6x-commands-*.js` 用 `Object.assign` 挂自己的领域，`69-router.js` 冻结它。
顺带把命令按亲缘关系放回一起 —— `actor.nickname.set` / `actor.class.set` /
`actor.state.*` 原来被追加在文件底部的「actor extras」，离其他 actor 命令 500 行远，
`game.newGame` 卡在「map events」小节中间。这就是史山的成因：新功能往末尾追加。

`core/bridge-build.mjs` → **`core/bridge-bundler.mjs`**（和 `core/gui-bundler.mjs` 对称；
CLI 子命令 `bridge-build` 不变）。

### 构建期校验：让拼接错误在构建时报出文件名

`bridge-bundler.mjs` 现在拒绝写出它无法证明能解析的产物：

1. **PARTS 列表 vs 目录必须完全一致** —— 防「文件建了但没进列表，测试全绿、功能不存在」。
2. **每个 part 单独解析**：中间的 part 包一层合成函数；首尾两个各自补上真 IIFE 的另一半。
   失败信息直接是 `bridge part 30-catalogs.js has a syntax error: ...`。
3. **拼接后整体解析**，并把报错行号映射回所属 part。
4. **IIFE 标记配对**：`@rmch-iife-open` 只能在第一个 part、`@rmch-iife-close` 只能在最后一个。
5. 产物开头加 GENERATED 横幅（校验在加横幅前做，行号才对得上）。

**自测（故意破坏 → 确认报错 → 恢复）**：

- 中间 part 加半个花括号 → `bridge part 30-catalogs.js has a syntax error: Unexpected token ')'`
- 建 `99-orphan.js` 不进 PARTS → `on disk but not in PARTS: 99-orphan.js`
- 删掉 `@rmch-iife-close` → `exactly one part must carry @rmch-iife-close and it must be 90-startup.js`
- 两个 part 各声明一次 `const SHARED_HELPER`（**各自单独解析都通过**）→
  `assembled page-bridge.js does not parse — around 64-commands-world.js:247: Identifier 'SHARED_HELPER' has already been declared`
  ← 这条正是切片架构最现实的风险。

### 修掉的真 bug

1. **`battle.info` 必然抛 ReferenceError。** 它调用 `enemyNameOf(enemy)`，而这个函数
   **全项目没有定义**。只要敌群非空（也就是任何真实战斗）这条命令就崩。之前没暴露是因为
   harness 的 `$gameTroop.members()` 返回空数组，`.map` 从不执行。
   已实现 `enemyNameOf`：`name()` → `enemy().name` → `$dataEnemies[id].name` 三级回退。
2. **`withNoCostSuppressed` 是个空操作。** 它增减 `bridge.suppressNoCost`，但四个免技能
   消耗的钩子**从不读这个计数器**，所以 profile API 里暴露的这个作用域什么也不做
   （对比：`withInvincibleSuppressed` 的计数器确实被 `shouldBlockHpDecrease` 读了）。
   已让 `patchSkillCost` honour 它。
3. **`gui-bundler.mjs` 丢弃 export 别名。** `export { A as B }` 会被转成
   `module_exports.A = A`，导入方 `import { B }` 拿到 undefined。当时没有别名导出所以没炸；
   已修成正确产出别名。

### 删掉的死代码（grep 确认零调用点）

`withRateContext`、`invalidateCatalogs`、`preserveNoCostResources`（返回
`{restored: 0}` 的空壳，返回值在调用点被丢弃）、`bridge.noCostDepth`（从未被读）。

### 去重

| 重复 | 处理 |
|---|---|
| 5 个 `withXxxSuppressed` 逐字相同（只差计数器名） | `suppressionScope(counter)` 工厂 |
| `applyLockHp/Mp/Tp` 三份同形逻辑 | `enforceVital(...)` 一份 |
| `preserveLocksTick` 里 MP/TP 两段复制粘贴 | `GUARDED_VITALS` 表驱动 |
| `_items`/`_weapons`/`_armors` 映射 3 处硬编码 | `INVENTORY_SLOTS` + `inventorySlot()` |
| `resolveData` 两张平行的 kind→名字表（会漂移） | 单张 `DATA_TABLES` |
| 玩家原型目标列表 2 处 | `playerPrototypeTargets()` |
| WS 与 JSONL 各一份 promise 结算逻辑 | `settleResult(type, args, reply)` |
| `lock.set` / `lock.replace` 两套锁值强转（且不一致） | `coerceLockValue(kind, value)` |
| 20+ 处 `const p = resolveParty(); if (!p) throw ...` | `requireParty/Player/Map/...` 守卫族 |
| `patchTrainerHooks` 166 行巨型函数 | 拆成 8 个具名安装器，主函数只剩清单 |
| `game.repair` 的 switch | `REPAIR_ACTIONS` 表；错误信息现在会列出支持的动作 |

一处行为修正：`actor.vitals.set` 原来把 `hp: null` 当「有值」，`Number(null)` = 0 →
**把 HP 设成 0**。现在 `null` 和 `""` 一样视为未提供。

### runtime/ 目录卫生

- 11 张调试截图 → `runtime/screenshots/`，统一命名（去掉 `gui-` 前缀，`gui-shot-*` 与
  `gui-screenshot-*` 两套合并，删掉 2 张被取代的重复）。
- `.gitignore` 重写成分组带注释，补上漏掉的 `runtime/shadow-profiles/`（8.5MB）和
  `runtime/screenshots/`。

### 测试

`npm test` 全绿：ws-server 合同、bridge harness **31 组**（新增 2 组）、json-ops 15 组、
GUI 预检（32 脚本 / 67 store 成员 / 23 模板）。

新增两组都做了「注入 bug → 断言失败 → 恢复」验证：

- 第 30 组 `battle.info` + 非空敌群（mock 现在有两个敌人，第二个不实现 `name()`，走
  `$dataEnemies` 回退）。移除 `enemyNameOf` → `AssertionError: battle.info must not throw`。
- 第 31 组 `suppressNoCost`。把守卫改成恒真 → `AssertionError: suppressNoCost must restore
  the real cost, 0 !== 5`。

### 实机验证（刷啊刷，L1，extension 策略）

`bridge injected` → `hook install finished {"patched":true,"count":23,"retries":1}`。

| 命令 | 结果 |
|---|---|
| `ping` / `runtime.info` | MV 1.6.1，hooks patched，profile 无 |
| `game.newGame` → `map.info` | 进图 mapId 20 (17×13)，位置 8,12 |
| `gold.set 12345` → `item.set item#1=77` → `item.list` | 12345 / 77（名字「妖族血脉升级丹」） |
| 锁金钱 999 + 锁 item#1 = 5，再用命令强改成 50000 / 500 | 2 秒后读回 **999 / 5** —— 逐帧回写赢了 |
| 锁 switch#1=true + variable#1=4242，再强改成 false / 0 | 读回 **true / 4242** |
| `save.contents.get` | 2,697,752 字节，15+ 顶层键（含插件键 `phwarehouse`） |
| `game.repair {"action":"nope"}` | 报错并列出 6 个支持的动作 |
| `game.repair fadeIn` | done |
| `lock.list` | 线上协议形状未变（`bridge.locks` → `bridge.valueLocks` 只是内部改名）；`lockStats.applied: 3100, errors: 0` |

收尾：`lock.clear`、只杀测试游戏进程（按 ExecutablePath 区分，GUI 未动）、
`runtime/locks/` 无残留文件。

## 存档树可编辑 + 目录/命名重整（2026-08-27 清晨）

三件事：把 MTool 数据修改的结构编辑能力补齐（12.png / 13.png 的右键菜单）、按职责重排文件、
清掉上一轮留下的死代码。

### 存档树：插入 / 复制 / 移除 / 改类型 / 重命名 + 撤销重做

- 右键任意节点 → **插入同级**、**插入子项**（自动 · 数组 · 对象 · 字符串 · 数字 · 布尔）、
  **改类型**、**重命名键**、**复制**、**移除**；键名双击也能改；工具栏加了**撤销 / 重做**。
  上一轮写的"只能改现有值"限制取消了 —— 风险改为在 UI 上写明并靠撤销兜底。
- 编辑操作抽到 `ui/parts/json-ops.js`：**纯函数、不碰 Vue/DOM、每个操作都可逆**
  （`set` / `rename` / `insert` / `remove` 各有 `invert`），撤销栈只存操作而不是 3MB 快照。
  对象的插入/删除/重命名都**保持键顺序**，并且复用父对象引用（不换 reference，否则 Vue 丢响应）。
- 新增 `tools/test-json-ops.mjs`（15 组，已进 `npm test`）：类型推断、`uniqueKey` 防撞、
  键顺序、数组 splice、深拷贝独立性、撤销栈上限，以及"一串混合编辑全部撤销后与原文档逐字节相同"。
- **实机验证**（大千世界2，2982116 字节存档树）：右键 `party._gold` → 复制 → 出现
  `_gold_copy` 且 `party` 从 {30} 变 {31}、脏标记亮起；撤销 → 回 {30}；重做 → 回 {31}；
  移除 → 回 {30}；插入同级 › 数字 → `newKey` 落在 `_gold` 之后；重命名键 → 行内输入框出现；
  连点撤销直到按钮禁用 → 树回到原始状态。全程没点「应用至游戏」，游戏本体未被改动。
- `tools/cdp.mjs` 新增 `click` / `rclick <selector>`：**Naive UI 的弹层不响应页面内合成的
  MouseEvent**，必须用 CDP `Input.dispatchMouseEvent` 发真实事件 —— 一开始用 `.click()` 测
  右键菜单，菜单能弹出但点选项毫无反应，白查了一轮才想到这点。

### 文件命名与目录

| 原 | 现 | 原因 |
|---|---|---|
| `app/gui/gui-server.cjs` | `app/gui/host.cjs` | 它不是服务器，是页面的 Node 上下文宿主；在 `app/gui/` 下再叫 `gui-` 也冗余 |
| `core/gui-bundle.mjs` | `core/gui-bundler.mjs` | 和生成物 `app/gui/gui-bundle.cjs` 同名，一直分不清哪个是构建器 |
| `ui/store.js`（750 行） | `ui/store/{core,trainer,data,locks,library,saves}.js` | 一个文件同时管 库/会话/修改器/数据页/锁/存档，典型 god module |
| `ui/parts/master-detail.js` | `ui/parts/{virtual-list,entry-list,picker,delta}.js` | 名字只覆盖其中两个组件；拆开后 `virtual-list` 必须在 `picker` 之前加载的依赖也显式了 |
| `ui/views/trainer-cheats.js` 等 | `ui/panels/trainer-*.js` | 它们注册的是 `RMCH.parts.*`（修改器卡片）而非 `RMCH.views.*`，放 `views/` 名不副实 |
| `ui/views/trainer-actors.js` | `ui/panels/trainer-gold.js` | 角色部分搬走后只剩金钱面板，旧名字在骗人 |

store 切片的约定：`core.js` 建出 `RMCH.store`，其余切片 `Object.assign` 挂自己那部分，跨切片
调用一律走 `store.x()`（运行时解析），所以加载顺序只需保证 core 在最前。

### 死代码与回归

- 上一轮把数据编辑搬到「数据」页后，`trainer` 里的 `catalog` / `sv` / `inventory` / `invQuery` /
  `rosterQuery` / `actorOpen`，以及 `loadCatalog` / `loadInventory` / `loadSv` 已经没有任何视图
  引用（grep 确认 0 处），全部删除；`ui/views/trainer-data.js` 整个文件也删了。
- **修掉一个我上一轮造成的回归**：`独立开关`（selfSwitch）随旧面板一起消失了 ——
  `loadSelfSwitches` 还留在 store 里但没有任何入口。现在放回 数据 › 地图（它本来就是按地图存的），
  带「当前地图」快捷按钮和行内切换。
- `data-flags.js` / `data-events.js` 原来各自 `onMounted` 拉自己的数据，与 `data-items.js`
  走 store 的做法不一致；统一成 store 的 `primeData` 一次性预热、视图只读。
- GUI 预检新增 **store 引用检查**：扫所有页面脚本里的 `store.xxx`，逐个断言存在于装配好的
  store 上。这次改名就是靠它一次列出全部漏改（`loadDataCatalog` / `loadDataCounts` /
  `loadEvents`）—— 这类错误以前只有用户点到那个按钮时才会暴露。
- 预检的脚本清单不再手写，直接从 `index.html` 的 `<script>` 顺序推导，两边不可能再漂移。
- 截图：`runtime/screenshots/tree-menu.png`（右键菜单 + 撤销重做 + 面包屑）。

## M2 全链路验收（2026-08-26，GUI 全栈实测）

驱动：`node tools/m2-acceptance.mjs <gameRoot>` —— 与 GUI 完全相同的代码路径
（`launcher.launchGame` 启动注入 → bridge 连 GUI 的 WS 服务器 → /client 通道发命令 → 校验结果 → 停游戏验证会话关闭）。
每游戏 18 项检查：连接、数据层就绪、状态快照、runtime.info、选项读写、目录查询、
开关列表、地图列表、存档列表、eval、进入游戏（新游戏/读档）、队伍、金钱、物品、
角色 vitals、开关写入、实时状态反映、停止后会话关闭。

| 游戏 | 引擎 | 保护 | 注入策略 | profile | 结果 |
|---|---|---|---|---|---|
| 刷啊刷 | MV 1.6.1 | L1 数据加密 | extension | — | **18/18** |
| 大千世界2 Demo | MV 1.6.1 | L3 启动保护 | extension | — | **18/18** |
| 再刷一把2：金色传说 | MV/MZ | L2 字节码 | extension | zs2 ✅ | **18/18** |
| Nightmare without return（梦魇：无归） | MV 1.6.1 | L3 启动保护 | **shadow (B)** | nwr ✅ | **18/18** |

GUI 本体验收：NW 0.54 窗口启动、内嵌 WS 服务器监听 47412、库扫描 6 游戏、
外部 /client 客户端协议冒烟（welcome/list）通过。

### 过程中发现并修复的问题

1. **NW 0.54 混合上下文 dynamic import 硬崩溃**：`import()` .mjs 文件直接杀死渲染进程
   （无异常）。修复：构建期把 ESM core 打包成 `app/gui/gui-bundle.cjs`
   （`core/gui-bundler.mjs`，正则转换 + registry），host.cjs 在 NW 下 require bundle，
   纯 Node 环境仍走原生 dynamic import。launch-gui.ps1 每次启动前自动重建。
2. **catalog 缓存永不过期**：`invalidateCatalogs()` 从未被调用，游戏数据加载完成前查询
   会把空目录缓存到重启。修复：缓存记录表长度，长度变化或空结果自动重建。
   （该函数在 2026-08-27 runtime 重整时已删除 —— 长度失效机制取代了手动失效。）
3. **GUI 启动失败只显示在页面上**：init 失败现在同步写入 `runtime/gui.log`（含堆栈）。
4. **残留 serve 进程占用 47412**：GUI 与独立 serve 冲突表现为 EADDRINUSE（此前无日志可查，由 3 解决）。
5. **传输层不支持异步 handler**：MZ 的 `DataManager.loadGame` 返回 Promise，会被同步
   `JSON.stringify` 成 `{}`。修复：WS 与 JSONL 两条通道均支持 Promise 返回（成功/失败都回包）。
6. **新增 bridge 命令** `game.newGame` / `save.load`：经 `TK.$` 别名表解析
   DataManager/SceneManager/Scene_Map，TK 系游戏（globals 被清洗）也能进游戏；GUI 修改器
   面板新增「读档(槽1)」「新游戏」按钮。
7. **launch-gui.ps1 调用已被废弃的 setup-gui.ps1**（中文路径在 PowerShell 5.1 下乱码选错
   donor）：改调 Node 版 setup-gui.mjs，删除 ps1。
8. **GUI 从不显示已连接会话**（真实使用中抓到，验收驱动没覆盖到——它直连 /client 通道，
   不经过 gui-server 的会话映射）：`BridgeSession.describe()` 返回扁平结构
   `{...info, alive, state}`，而 host.cjs 按嵌套读 `session.info.bridgeVersion`，
   一有会话就抛 TypeError，被 `refresh()` 的 catch 吞掉 → 下拉框永远空、库卡片无
   「桥接已连接」徽章。修复为扁平映射。

## MTool 对齐第二轮（2026-08-26 晚）

**新增 bridge 命令**：`item.list`（背包清单含数量）、`item.set`（数量设定/清零，走 gainItem
差值以尊重游戏自身背包逻辑，返回真实结果数量）。harness 新增 4b 用例覆盖；并在用户运行中的
大千世界2（TK 系）上以 console.eval 等价逻辑实测（+5→5.0006——游戏自身插件给获取量带倍率，
恢复→0，正常）。

**GUI MTool 化**：
- 开关/变量列表**行内编辑**：开关行内 ON/OFF 切换、变量行内改值点设定
- 新增**独立开关**模式（selfSwitch.list/set，按地图列出已设置的事件开关，行内切换；
  地图 ID 自动带入当前地图）
- **背包/物品数量**面板：列出持有物、行内改数量/清零（MTool 物品数量编辑）
- **队员管理**：队伍列表每行「离队」、角色编辑器「加入/移出队伍」（party.addActor/removeActor）
- **战斗敌人编辑**：战斗信息渲染敌人列表，行内改 HP / 秒杀（battle.enemy.setHp）
- 目录点击扩展：**公共事件=确认后运行**（commonEvent.run）；目录类型补齐敌人组/地图/公共事件
- 传送面板「当前坐标」按钮（player.location 一键填 X/Y）；搜索框回车；类型切换自动重搜

## MTool 对齐第三轮：全列表化（2026-08-26 晚）

- **角色管理**改为 MTool 式全角色花名册：在队成员（带等级/HP/MP）在前，其余角色（未入队标记）
  在后，每行「编辑 / 入队(离队)」按钮；**按名称/ID 实时过滤** + 计数徽标；独立可滚动容器
  （实测大千世界2：320 角色列出，过滤"小明"→1 行）
- **全列表自动加载**：选中游戏后 开关列表（500 行 + 行内切换）、背包、角色花名册 与原有的
  目录/地图/队伍 一样自动出现（数据未就绪自动重试；背包需进游戏后才有内容）
- 读档/新游戏后自动刷新 开关/变量值 和背包
- 实测：sv 列表 500 行 500 个切换按钮自动渲染；花名册滚动容器 11219/288px

## 对标 MTool：主从布局 + 数据锁定 + 运行时存档树（2026-08-27 凌晨）

参照 MTool（E:\MTool）的界面与交互重做数据编辑部分。MTool 的三条核心设计被搬过来了：
**每种数据一个页签的左列表右详情**、**列表行首的勾选框本身就是操作**、**数值一律配 ±快捷键**。

### 布局：修改器（卡片总览）+ 数据（主从页签）

- 「修改器」= 常用作弊的卡片总览（作弊开关 / 倍率 / 金钱 / 战斗 / 快捷操作 / **场景与修复**），
  列数按实测宽度自适应（每列 ≥420px，最多 3 列）。
- 「数据」= 9 个 MTool 式主从页签：物品 / 装备 / 武器 / 开关 / 变量 / 角色 / 地图 / 公共事件 /
  存档数据。原来塞在修改器里的 目录浏览 / 开关变量 / 传送 / 背包 / 角色花名册 五张卡片被这些
  页签取代（`ui/views/trainer-data.js` 与角色抽屉已删除）。
- 复用件：`ui/parts/master-detail.js` 提供 `RmEntryList`（可搜索虚拟列表 + 语义化勾选框 +
  行尾实时值）、`RmPicker`（窗口化勾选覆盖层）、`RmDelta`（数值 + −100/−1/+1/+100）、
  `RmVirtual`（固定行高窗口化列表 —— naive-ui 2.35 不导出 `NVirtualList`，2.36 才公开）。

### 数据锁定（MTool 数据锁定）

- bridge 新增 `lock.set / lock.list / lock.clear / lock.replace`，锁集合放在 `bridge.valueLocks`
  （2026-08-27 由 `bridge.locks` 改名，与上帝模式的 `options.lockHp/Mp/Tp` 区分；线上协议未变），
  在已有的 `SceneManager.updateMain` 钩子里**每帧**回写（直接写 `_items` / `_data` 槽位，
  不走 gainItem/setValue，避免每帧重入游戏自己的钩子；无锁时立即 return）。
  支持 物品 / 武器 / 防具 数量、开关、变量、金钱。
- 持久化在 GUI 侧：`runtime/locks/<gameKey>.json`（`host.cjs` 的 `saveLocks/loadLocks/hasLocks`），
  「读取锁定状态」用 `lock.replace` 一次性灌回 bridge。锁活在 bridge 里，**GUI 刷新不丢锁**（实测）。
- **实测**（大千世界2）：物品 #1 锁 999 → 用 `item.set` 改成 3（走游戏自己的 gainItem，返回
  3.00036）→ 几帧后读回 **999**；`lockStats` 显示回写 37727 帧、错误 0。清空 / 存盘 / 读盘往返正常。

### 存档数据（MTool 数据修改）

- bridge 新增 `save.contents.get` / `save.contents.apply`：`DataManager.makeSaveContents()` 经
  JsonEx 序列化成字符串（JsonEx 输出仍是合法 JSON，所以前端能直接当树编辑），回写走
  `extractSaveContents` + 像 Scene_Load 一样 `reserveTransfer` + `requestMapReload` +
  `goto(Scene_Map)`（可关掉重载）。`limitBytes` 默认 12MB，超了明确报错而不是把编辑器撑死。
- 前端 `ui/parts/json-tree.js`：窗口化树（展开两层/四层/全部折叠、搜索键名或值并自动展开祖先、
  面包屑、按类型内联编辑 —— 数字用 number 框、布尔用勾选框、字符串用文本框）。
  **只改现有值，不增删键**（增删会让存档结构与游戏类不匹配，读档时才炸）。
- **实测**（大千世界2）：拉取 2982144 字节 / 23 个顶层键（含插件键 `_PTCount` `_randomGet` 等）；
  把 `party._gold` 从 0 改成 54321 → `应用至游戏`（不重载）→ 游戏内 `gold.add 0` 读回 **54321**。

### 技能 / 状态选择器 + 角色详情

- 角色详情用 MTool 的排布：职业/等级/经验/HP/MP/TP 概览 + 名称·昵称 + 等级·追加经验 +
  HP/MP/TP + **8 项属性加值**（当前值 → 加值框 → ±100/±1 → 应用）。
- 「技能」「状态」弹窗化勾选（勾上=学会/附加，取消=遗忘/解除），带「只看已拥有」。
  1700 条技能窗口化后**只渲染 24 行**（改之前是一次渲染 1700 个勾选框，截图都会超时）。
- bridge 新增 `actor.nickname.set` / `actor.class.set` / `actor.state.add` / `actor.state.remove`，
  `actorInfo` 补上 nickname / classId / className / params[8] / states / maxLevel / nextLevelExp / maxTp。
  顺带修掉一个旧 bug：`safeCall(actor.currentExp)` 传的是未绑定方法，`exp` 一直是 null。

### 场景跳转 + 修复错误 + 地图事件

- `scene.info / scene.push / scene.pop`：只列出该游戏真的定义了的场景（实测大千世界2 没有
  `Scene_Item/Scene_Skill/Scene_Equip`，过滤后剩 状态/菜单/保存/读取/设置/调试/商店/改名/结束）。
- `game.repair`：clearCurrentEvent / clearPictures / fadeIn / clearMoveRoute / gotoMap / gotoTitle。
- `map.events.list` / `map.transferToEvent`：列出玩家所在地图的事件（ID/名称/坐标/生效页/指令数），
  可「走过去」。公共事件搬进 数据 › 公共事件（带备份提醒）。

### 验证

- `npm test`：ws-server 合同 + bridge harness **29 组**（新增 9 组覆盖锁定回写、存档树往返、
  scene push/pop、repair、地图事件、角色 states/nickname/params）+ GUI 预检。
- GUI 预检新增**标签配对检查**：Vue 的 HTML 解析器会静默自动闭合 `<a>…</b>`，模板照样编译通过，
  然后在运行时把插槽挂到错误的组件上炸掉 —— 本轮就踩了这个（`<n-virtual-list>…</rm-virtual>`），
  靠 `ui/boot-guard.js` 画到窗口里才定位到。检查已自测过（故意改坏 → FAIL，改回 → OK）。
- `tools/cdp.mjs` 修了两个坑：`/json/list` 按 Content-Length 收尾（DevTools 不理 `Connection: close`）、
  截图前先 `Page.bringToFront`（窗口被遮挡时合成器暂停，`captureScreenshot` 会返回旧帧 —— 本轮
  一开始就被这个骗了两次）。
- 截图：`runtime/screenshots/data-items.png`（物品主从 + 锁定）、`data-actor.png`（角色详情 +
  属性加值）、`-data-tree.png`（存档数据树）、`-picker.png`（技能选择器）。
- 测试用的锁和 `runtime/locks/*.json` 已清理，测试游戏已关闭。

### 没做的 MTool 功能（明确留白）

- **事件解释器**（把事件指令码反编译成可读文本）——MTool 的 `事件解释器` 按钮，工作量单独一块。
- 敌人 / 敌人组 目录浏览（原 catalog 卡片支持过，本轮的 9 个页签没收；状态已由选择器覆盖）。
- 自动存档定时器、存档备份库 UI、翻译、MCenter、事件迷你地图、按键设定。
- 上帝模式的「锁定值/最大」三行仍在 修改器 › 作弊开关 里（lockHp/lockMp/lockTp 选项），
  没有并进新的锁定体系。

## UI 重构：Vue 3 + Naive UI 组件库（2026-08-27 凌晨）

上一轮的深色主题是手写 CSS（styles.css 约 700 行 + gui-core.js 1239 行 DOM 拼字符串）。
本轮改成组件库驱动，**不再手写组件样式**：

- **技术栈**：Vue 3.5.13 + Naive UI 2.35.0，两个浏览器 bundle vendored 到 `app/gui/vendor/`，
  普通 `<script>` 标签加载，无构建步骤、仍然零 npm 依赖。前端拆成
  `app/gui/ui/{theme,icons,store,compat,app,main}.js` + `ui/views/*.js`（模板是字符串，
  由 Vue 运行时编译）。`gui-core.js` 删除。
- **视觉**：左侧 sider 导航（可折叠）+ 顶栏状态区（已连接游戏数 / 服务器端口 / 主题切换）；
  深浅双主题，token 全在 `ui/theme.js`，选择记在 localStorage。`styles.css` 缩到 ~120 行，
  只剩文档级排版（html/body、滚动条、flex 容器、boot 错误面板）。
- **修改器布局**：10 张卡片（作弊开关/倍率/快捷/战斗/金钱/角色/目录/开关变量/传送/背包），
  列数由 `ResizeObserver` 按实测宽度算（每列 ≥430px，最多 3 列），卡片轮转分配到各列 ——
  避免 flex-wrap 在中间宽度下把最后一列拉成整宽。1180px 默认窗口 = 2 列 × 462px。
- **表格**：全部换成 `n-data-table` + `virtual-scroll`，去掉原来的手写 `<table>` 字符串拼接、
  20 行分页器和 300/500 行截断 —— 目录 1400 项、开关 900 项、地图 395 张一次性可滚动浏览。
- **交互**：`prompt()`/`confirm()` 换成 n-modal / n-dialog；操作反馈从"只写日志"变成
  toast（`useMessage`）+ 日志双写；角色编辑从内联 HTML 换成右侧 `n-drawer`。
- **代码收敛**：原来 5 个几乎重复的 `autoLoadX(attempt)` 递归重试函数收敛成 store 里一个
  `retryLoad(gen, key, run, isEmpty)`，用 generation 计数器在切换游戏时作废在途重试。

### 两个 Chromium 91 兼容坑（已卡进 CI）

- **Naive UI 必须 ≤ 2.35.0**：2.36+ 的 bundle 含 ES2022 class `static {}` 块（来自其打包的
  qrcodegen），NW 0.54 = Chromium 91 直接 `SyntaxError: Unexpected token '{'` → 整窗白屏。
  2.35.0 是最后一个不含该语法的版本；它没有 `NFlex`（2.36 才加），由 `ui/compat.js` 补一个
  同 API 的 20 行 flex 组件。
- **Naive UI 是 UMD**，NW.js 又把 `module`/`exports` 注入页面 → 它会走 `require("vue")` 分支
  报 module not found。`index.html` 在 vendor 加载期间临时屏蔽这三个全局变量再恢复。

### 验证

- `node tools/gui-check.mjs`（已加入 `npm test`）：在 vm 沙箱里按 index.html 的顺序加载全部
  页面脚本，再用 vendored 的 Vue 编译器编译**每一个**模板 —— 17 个模板全通过、2 个
  render-function 组件跳过；另外校验 vendor bundle 无 Chromium-91 不支持的语法、46 个必需的
  naive-ui 导出齐全、index.html 的 script 顺序与预检一致。
- `tools/cdp.mjs`（新增，零依赖 CDP 客户端：RFC6455 握手/掩码帧 + Runtime.evaluate +
  Page.captureScreenshot）用于实机验证。
- **实机联动**（大千世界2，从 GUI 里点「启动并注入」，策略 extension，pid 5952）：桥接 0.5 秒
  内连上；队伍 1 人、花名册 320 角色、开关 900 条、地图 395 张、目录 1400 项全部自动加载；
  切换「无敌」开关 → 选项回写 true；点「编辑」→ 角色抽屉显示 #1 小明 Lv.1 HP 400/400
  MP 200/200 + 已学技能；浅色主题切换正常；关掉游戏后桥接断开 → 修改器自动回到空状态。
- **失败可诊断**：新增 `ui/boot-guard.js`，页面未捕获错误会同时画到窗口里并写进
  `runtime/gui.log`（`host.cjs` 新增 `log()` 导出）。上面那个 Chromium 91 SyntaxError
  就是靠它一行定位的。
- 截图存档：`runtime/screenshots/library.png`（游戏库）、`trainer.png`（修改器全景）、
  `actor.png`（角色抽屉）、`light-theme.png`（浅色主题）。

## UI 深色主题重设计（2026-08-26 晚，已被上一节取代）

对标 MTool 修改器风格的全套深色主题（styles.css 重写）：深色底（#16171b/#1f2127/#262932 三层）、
蓝色强调色、iOS 风格滑动开关（作弊选项 12 项）、圆角卡片、悬停高亮列表行、样式化滚动条、
分区标题带强调条、运行中游戏卡片绿色描边、顶栏 pill 标签页。验证方式：NW `--remote-debugging-port`
+ CDP —— 样式探针确认主题应用、五面板零溢出、trainer 三列 371px 布局、开关 32×18 渲染正确；
实机联动验证（用户运行中的大千世界2）：选游戏后队伍/金钱/状态/目录（20行分页 1400 项）/地图
（395 张）全部自动加载。截图存档：runtime/screenshots/library.png（游戏库）、
runtime/screenshots/trainer.png（修改器）。

### 已知限制（不阻塞 M2）

- **NW 单实例锁**：多个 RPG Maker 游戏共享 NW 用户数据目录（如 `rmmz-game`），一个游戏运行时
  启动同家族的另一个游戏会被单实例检测直接退出（实测：大千世界2 运行中启动刷啊刷 4 秒内退出，
  报"已经运行的程序在会话中打开"）。后续可在 launcher 里研究按游戏隔离 user-data-dir。
  （这不是 RMCH 引入的问题——直接双击 Game.exe 同样退出。）
- `battle.*` 与 `actor.level/param/skill.*` 本轮未在 M2 驱动里逐项重测（需要触发战斗/多步
  UI）；M1 已在四游戏上验收，且与本轮验证的命令走完全相同的请求-响应路径。
- 部分 YEP 插件重的游戏（刷啊刷）`DataManager.setupNewGame()` 直接开新游戏会因插件读取
  未初始化数据报错 —— 验收驱动自动回退到读存档（`save.load`），GUI 用户建议用「读档」按钮。
- ~~NWR 影子目录下 `save.list` 指向影子应用的 save 目录（策略 B 的隔离设计，存档在影子目录内）。~~
  **2026-08-28 已修复**：影子的 `save/` 固定 junction 回真实游戏根（www 布局经 www junction 天然直通），
  游戏读写存档直达真实目录；旧版本残留在影子里的分歧存档会在重建影子时按「mtime 较新者胜」合并回真实
  目录后再建链接（`core/shadow-launcher.mjs` `mergeSaveFiles`）。

## M0/M1 验收（zcode 会话，2026-08-26 早些时候）

- M0：四游戏引擎与保护等级全部正确识别（另加 TheWorld / 再刷一把 两个非目标游戏也识别正常）。
- M1：通用 bridge 剥离、WS 协议、extension/shadow 双策略注入、CLI、zs2 profile 命令在
  四游戏上跑通；合同测试 `tools/test-ws-server.mjs` + bridge harness（20 组）通过。
