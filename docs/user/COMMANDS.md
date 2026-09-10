# 桥接命令参考

由 `node tools/commands-doc.mjs` 从 `runtime/bridge/src/parts/*-commands-*.js`
生成，请勿手改；分片里的注释就是本文件里每个命令的说明。

```powershell
node tools/rmch.mjs send <gameKey> <命令名> '<JSON 参数>'
```

参数是一个 JSON 对象。命令名同时适用于 MV/MZ 与 XP/VX/VX Ace——RGSS 桥接
镜像同一套命令名，引擎本身做不到的命令会明确报错，而不是静默失败。
在游戏里也可以直接执行代码：MV/MZ 用 `console.eval`，RGSS 用工具箱控制台。

共 **69** 条命令。

## 目录

- [core / diagnostics](#core-diagnostics)（5）
- [gold](#gold)（2）
- [catalogs](#catalogs)（1）
- [inventory](#inventory)（3）
- [party](#party)（4）
- [actors](#actors)（13）
- [switches / variables](#switches-variables)（4）
- [self switches](#self-switches)（2）
- [maps / movement](#maps-movement)（6）
- [map events](#map-events)（3）
- [battle](#battle)（4）
- [save slots](#save-slots)（15）
- [decoded game assets](#decoded-game-assets)（1）
- [scenes](#scenes)（6）

## core / diagnostics

| 命令 | 说明 |
| --- | --- |
| `runtime.info` | 桥接自检：版本、识别到的引擎、游戏标识、已加载的游戏配置与打上的钩子。 |
| `trainer.options.get` | 读取当前修改器开关（无敌、倍率、穿墙等）。 |
| `trainer.options.set` | Accepts either {options:{...}} or the option map directly, because the CLI sends the flat form and the GUI sends the wrapped one. |
| `trainer.hooks.info` | — |
| `console.eval` | Runs in the page's own realm. Note that on some bundled games the game's globals are not visible to a bare eval (they live in a module scope) — reach them through TK.$ or use the dedicated commands instead. |

## gold

| 命令 | 说明 |
| --- | --- |
| `gold.add` | 增加金币；负数为扣除。倍率在内部被抑制，所以加多少就是多少。 |
| `gold.set` | 把金币设成指定数量（最小 0）。按差值走引擎自身的接口，保留游戏的上限与提示。 |

## catalogs

| 命令 | 说明 |
| --- | --- |
| `catalog.query` | 按名字或 ID 搜索物品/武器/防具/技能/状态等目录，用于找到要改的 ID。 |

## inventory

| 命令 | 说明 |
| --- | --- |
| `item.add` | 增加道具。amount 可负；结果为 0 时从背包移除。 |
| `item.list` | MTool-style inventory view: everything the party currently owns, with counts. |
| `item.set` | 把某件道具的数量设为固定值（0 表示移除）。 |

## party

| 命令 | 说明 |
| --- | --- |
| `party.info` | 队伍总览：金币、同行成员、参战成员与最大参战人数。 |
| `party.recover` | 全队恢复到满 HP / MP / TP 并清除状态。 |
| `party.addActor` | 把某角色加入队伍；id 是 $dataActors 里的角色 ID。 |
| `party.removeActor` | 把某角色移出队伍（不影响角色自身数据）。 |

## actors

| 命令 | 说明 |
| --- | --- |
| `actor.info` | 单个角色的详细状态：等级、经验、HP/MP/TP、属性、技能与状态。 |
| `actor.recover` | 单个角色回满。注意部分游戏的原生 recoverAll 不含 MP，这里会一并补上。 |
| `actor.level.set` | 设置等级（上限取角色 maxLevel，默认 999），经验与属性按引擎规则重算。 |
| `actor.exp.add` | 增加经验值，允许因此升级（不会降级）。 |
| `actor.vitals.set` | 设置 HP / MP / TP；只处理传入的字段，数值自动夹在 0..上限 之间。 |
| `actor.param.add` | 给基础属性加点：paramId 0..7 依次为 最大HP/最大MP/攻击/防御/魔攻/魔防/敏捷/幸运。 |
| `actor.name.set` | 改名。 |
| `actor.nickname.set` | 设置称号（仅带称号系统的游戏有效）。 |
| `actor.class.set` | 转职；keepExp 默认 true 保留当前经验。原生规则决定职业的游戏会明确拒绝。 |
| `actor.skill.learn` | 学会技能；skillId 必须是 $dataSkills 里存在的技能。 |
| `actor.skill.forget` | 遗忘技能。 |
| `actor.state.add` | 附加状态；stateId 是 $dataStates 里的 ID。 |
| `actor.state.remove` | 解除状态。 |

## switches / variables

| 命令 | 说明 |
| --- | --- |
| `switch.set` | — |
| `switch.list` | — |
| `variable.set` | — |
| `variable.list` | — |

## self switches

| 命令 | 说明 |
| --- | --- |
| `selfSwitch.set` | Keyed by [mapId, eventId, letter] and stored sparsely: only switches that have ever been set exist, so the list is "what this map has touched", not "every event on this map". |
| `selfSwitch.list` | — |

## maps / movement

| 命令 | 说明 |
| --- | --- |
| `map.info` | — |
| `map.list` | — |
| `map.transfer` | — |
| `map.through.set` | — |
| `map.through.toggle` | — |
| `player.location` | — |

## map events

| 命令 | 说明 |
| --- | --- |
| `map.events.list` | — |
| `map.transferToEvent` | — |
| `commonEvent.run` | — |

## battle

| 命令 | 说明 |
| --- | --- |
| `battle.info` | — |
| `battle.enemy.setHp` | — |
| `battle.killEnemies` | — |
| `battle.escape` | — |

## save slots

| 命令 | 说明 |
| --- | --- |
| `save.list` | — |
| `save.save` | — |
| `save.webstorage.export` | — |
| `save.native.export` | — |
| `save.native.import` | — |
| `save.native.delete` | — |
| `save.webstorage.import` | — |
| `save.webstorage.delete` | — |
| `save.load` | — |
| `save.contents.get` | — |
| `save.contents.apply` | — |
| `lock.list` | — |
| `lock.set` | — |
| `lock.clear` | — |
| `lock.replace` | Bulk restore, used when the GUI reconnects and replays a saved lock set. |

## decoded game assets

| 命令 | 说明 |
| --- | --- |
| `assets.iconset` | Pull the decoded IconSet sheet as a data URL. Async: the image may still be decoding when loadSystem returns, so poll isReady() on a deadline. |

## scenes

| 命令 | 说明 |
| --- | --- |
| `scene.info` | — |
| `scene.push` | — |
| `scene.pop` | — |
| `game.repair` | — |
| `game.newGame` | — |
| `system.rebootCapture` | Closure-sealed shells only: the launch flow's catalog dance (attach.mjs ensureSealedCatalog) asks the bridge to reload the page so the boot-time database load flows through the JSON tap with the bridge guaranteed present. The attach layer re-injects into the new context — without it this command would simply kill the bridge, so it is never exposed to the GUI directly. |

## 说明

以下 38 条命令在源码里没有紧邻的注释，说明暂缺：

`trainer.hooks.info`、`switch.set`、`switch.list`、`variable.set`、`variable.list`、`selfSwitch.list`、`map.info`、`map.list`、`map.transfer`、`map.through.set`、`map.through.toggle`、`player.location`、`map.events.list`、`map.transferToEvent`、`commonEvent.run`、`battle.info`、`battle.enemy.setHp`、`battle.killEnemies`、`battle.escape`、`save.list`、`save.save`、`save.webstorage.export`、`save.native.export`、`save.native.import`、`save.native.delete`、`save.webstorage.import`、`save.webstorage.delete`、`save.load`、`save.contents.get`、`save.contents.apply`、`lock.list`、`lock.set`、`lock.clear`、`scene.info`、`scene.push`、`scene.pop`、`game.repair`、`game.newGame`

来源分片：`60-commands-core.js`、`62-commands-party.js`、`64-commands-world.js`、`66-commands-saves.js`、`67-commands-assets.js`、`68-commands-system.js`
