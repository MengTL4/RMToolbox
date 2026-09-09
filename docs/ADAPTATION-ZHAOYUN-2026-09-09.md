# 赵云传之龙魂再起 0.0.5 适配记录

路径：`D:\Downloads\RPG\赵云传之龙魂再起-0.0.5`

## 扫描结果

- 引擎：MV（运行时报告 `1.6.1`）
- 容器：Tauri/WebView2
- 启动路线：`tauri-cdp`
- 原始 EXE：`赵云传之龙魂再起.exe`
- 影子目录和 DLL 注入不适用于此容器，不能强行套用普通 NW.js 路线。

Tauri 路线会复制 EXE 为同目录的 `.rmch-cdp.exe`，只在副本中写入 CDP 参数，原始 EXE 不改。

## 实机只读烟测

源目录启动和 GUI bundle 启动各完成一次，均通过：

- CDP 启动副本和页面目标发现
- bridge hello 与唯一会话建立
- `ping`
- `runtime.info`
- `catalog.query(skill)`：825 条
- `catalog.query(item/weapon/armor/actor/state/commonEvent)`：600/341/741/90/200/135 条
- `scene.info`：标题场景及 10 个原生场景可见
- `party.info`：赵云队伍对象可读
- `save.list`：WebStorage 2 条
- `save.webstorage.export`：2 条
- `save.contents.get`：34,524 字节
- 结束进程后会话正常关闭

本轮只读验证没有改动游戏数值或存档。该游戏没有普通 `save` 目录，存档走 WebStorage，工具箱应使用浏览器存档备份/恢复入口。

## 编码库存修复与回归

该版本的 `_items/_weapons/_armors` 使用 `thTyZhNum*` 编码，底层 `gainItem` 还要求临时设置 `_GITHGT`；未设置时会静默不写入，旧适配器因此误报“没有应用目标物品数量”。库存适配器现在会识别这组接口，只在引擎调用期间打开门控标志，随后恢复原值，并通过 `numItems` 验证实际结果。

加载原有 WebStorage 槽位 1 后，实机完成 `item.set` 3→7、`item.add` -2、`item.set` 0，以及每一步的 `item.list` 回读；结果分别为 3、7、5、0，桥接命令全部成功，门控标志最终恢复为空。测试只在运行内存中操作，未调用保存写回。

同一轮还验证了基础武器和防具的添加、列表回读、按基础 ID 删除。游戏生成的独立实例会在列表中显示实际实例 ID，删除时由适配器调用游戏原生方法清理实例。
