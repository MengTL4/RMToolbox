# 重装归途 0.1.33 适配验收（2026-09-08）

## 样本与隔离

- 原目录：`D:/Downloads/RPG/重装归途-0.1.33`。
- 入口：`重装归途.exe`，40,861,696 字节，x64；SHA-256 `0ce495b32931ea3095bd819081c04a9966c02fcb4249496f731c1c738247ac68`。
- 外壳确认是 Tauri / WebView2，资源目录为 `arc_img`、`arc_audio`、`arc_movies`。未发现 Themida / WinLicense / Oreans 字符串或对应 PE 节；不能仅由标记缺失证明绝对没有保护，但没有触发用户指定的 Themida 排除条件。
- 实际引擎由运行时确认：RPG Maker **MV 1.6.1**，不是扫描器此前假定的 MZ。
- 完整复制到 `tmp/homecoming-0133-isolated` 后测试。设置独立 `WEBVIEW2_USER_DATA_FOLDER`，并通过进程命令行确认全部 WebView2 子进程的 `--user-data-dir` 指向该目录下 `webview-test-profile/EBWebView`。
- 测试只操作副本与其浏览器存储；原安装和用户存档未修改。存档 3 是正常推进开场后地图 19 的自由行动检查点，存档 4 用于往返验证。

## 适配中的真实缺口

1. 引擎重命名：`ThGem_*` / `ThSce_*` / `ThWin_*`，`ThBtData`，`$thNewGm*` / `$thNewDt*`；`SceneManager.thNewGoto/thNewPush/thNewPop`。需要动态别名，确保新游戏和读档替换单例后仍取最新对象。
2. MV 使用 WebStorage，实际键是 `RPG File1` 至 `RPG File4` 与 `RPG Global`，`maxSavefiles() = 4`。不能伪造磁盘目录或仅扫 `.rmmzsave`。
3. 金币、变量等使用编码值。直接写数字 `_gold` 会调用游戏自己的异常处理并关闭 WebView2。真实库存由 TH_ItemCore 改为角色 `_newItemList` 和仓库 `_tkCkItem`，旧 `_items` / `numItems` 已不代表背包。专用适配器读取真实背包，新增逐件调用公开 `newGetItem`，移除调用原生带 owner 的 `gainItem`；仓库移除采用原生仓库界面的 splice 操作。不能向旧容器写入数字制造假库存。
4. 游戏的 `addParam(paramId,value)` 实际只调用 `refresh()`，不执行加点；`paramPlus` 由自定义战车/装备规则计算。工具箱应明确报告这次修改没有生效，不杜撰一套战车数值规则。
5. 读档/数据树应用会重建场景，重建时保留旧选择消息可能造成 `ThWin_ChoiceList` 初始化访问不存在的 `contents.bitmap`。成功读档应丢弃旧临时消息；数据树应用遇到正在进行的对话/选项则在修改前拒绝，要求等待交互结束。
6. 敌人 `die()` 将 HP 编码为零但会清空状态，单独调用后 `isAlive()` 仍然为真。击杀逻辑需要使用游戏的死亡状态流程并验证结果。

## 已验证能力

最终版本的两套专项实机回归分别通过 **9 / 9**（真实库存、锁与含独立装备的存档）和 **11 / 11**（地图、菜单、真实战斗与倍率）。较早的广泛检查用于发现兼容缺口；最终结论以原生数据读回和实际游戏行为为准，不把空旧库存或选项往返当作功能完成。

| 能力 | 实测结果 |
| --- | --- |
| 扫描、连接、运行时、场景 | MV 1.6.1；38 个 hook；标题/地图/菜单正常 |
| 金币、物品、目录 | 金币 set/add；真实回复胶囊5→7→9，原生newNumItem读回9；普通物品300、技能550、状态57、角色150、敌人380、敌群235，装备目录随实例装备生成变化 |
| 角色与队伍 | 等级、经验、HP/TP、恢复、名字/昵称、技能/状态增删、队伍增删/恢复 |
| 基础属性加点 | 原生入口无效，明确错误，不报告成功 |
| 开关、变量 | 原生入口写入及读回 |
| 世界 | 674 地图；地图19有18个事件；网格324格；真实事件1读取3条；同地图传送；菜单 push/pop |
| 移动 | 穿墙原生 `isThrough()`；不遇敌原生 `encounterProgressValue() = 0`；移速及其他选项往返 |
| 值锁 | 金币500→消费后400→恢复500；金币999999封顶和超限锁保持编码值；物品消费后真实背包恢复3；变量/开关原生写入后被锁恢复 |
| 独立装备 | 基础弹弓/草帽通过原生入口生成真实实例；实际实例可精确删除；基础装备减量和实例复制受保护，不误删改造数据 |
| 原生战斗 | 场景启动、2个敌人；HP命令；无敌令HP伤害10后仍80；完整Game_Action.apply触发一击必杀且isDead=true；清敌后remaining=0；战斗结束正常回地图 |
| 倍率/消耗/生命锁 | 战斗上下文原生金币/经验10变20，掉落率2；技能MP消耗0；原生HP/TP setter后HP满、TP30 |
| 存档 | 槽4包含3个胶囊、武器实例2002、防具实例2003；存读档及浏览器备份恢复保持实际数量、实例ID/baseItemId/name/description/params；真实槽位/时间列表 |
| 数据树 | 含独立装备数据约94KB，get/apply 后背包/动态装备数据库/单例保持一致，reloaded=true，地图继续运行 |
| 图标/控制台 | 512×640图标图集；console.eval |
| 事件执行 | 内存临时公共事件交给真实解释器单步执行，变量5原生读回777且状态completed；等待步骤stop最终状态stopped |

最终回到地图19，`SceneManager._stopped=false`，原生背包为 `["I1","I1","I1","W2002","A2003"]`。所有测试实例与诊断服务随后关闭，保留隔离存档3/4供复查。

## 明确限制

- 基础属性加点：游戏原生方法是空实现，工具箱明确报未生效；不重写战车/改造系统。
- 炮弹：使用独立弹仓，普通库存增删/数量锁不支持，并明确拒绝。
- 装备数量锁：独立实例不能安全复制或任意删改，禁止装备数量锁。新增请选择基础装备，删除请在当前物品中选具体实例。
- 每次最多修改1000件；背包/仓库容量或原生规则使部分操作未完成时，立即停止并报告实际数量。
- 正在进行对话/选择时，数据树应用在修改之前拒绝。等待交互结束后可以应用；读档按正常语义丢弃原来的临时消息。

## 存档回归与证据

`tools/test-webstorage-saves.mjs` 覆盖桥命令及 host 的真实临时备份目录：列表、导出、备份、删除、恢复、删备份；异步保存拒绝/失败/void成功；读档失败不清消息；数据树应用在消息忙时不修改内容；非法键、重复键、越界键、错误备份类型、压缩数据结构检查、配额错误回滚。

WebStorage 备份使用 `backups/<gameKey>/<timestamp>/webstorage.json`，包含压缩原始键值与游戏标题。恢复仅接受该游戏由 StorageManager 确定的存档和全局索引键；不涉及其他浏览器设置。浏览器存档的备份、恢复和删除需要保持游戏连接；「打开存档目录」不可用，因为没有对应的游戏目录文件。

`tools/test-th-inventory.mjs` 另行覆盖去重角色/搭乘者、背包与仓库、原生方法、容量/部分成功、独立装备保护和删除后的数据库注销；`tools/test-inventory-locks.mjs` 覆盖锁预验证及批量替换不产生部分提交。

诊断脚本：`tools/debug/homecoming-session.mjs`、`tools/debug/homecoming-acceptance.mjs`、`tools/debug/homecoming-combat-events.mjs`、`tools/debug/homecoming-inventory-saves.mjs`。最终专项结果：`tmp/homecoming-inventory-saves.json`、`tmp/homecoming-combat-events.json`；最终画面：`tmp/homecoming-final-map.png`。

脚本没有本机盘符硬编码。会话脚本接受隔离目录参数（默认项目 `tmp/homecoming-0133-isolated`），可用 `RMCH_TEST_PORT` 指定诊断端口。测试目录必须是完整副本，且人工创建 `.rmch-isolated-test` 标记；脚本拒绝未标记的安装目录。请保留存档3作为已结束开场对话的自由地图检查点，存档4专门用于往返测试。

截图来自游戏自身 WebGL 渲染，先调用 renderer.render 再在同一次求值取 canvas，避免默认帧缓冲被清空后得到黑图。原生画面已检查为地图 19 的可行动场景。
