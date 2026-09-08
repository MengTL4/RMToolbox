var RMCH = (window.RMCH = window.RMCH || {});

var store = RMCH.store;

var trainer = store.trainer;

var h = Vue.h;

var ref = Vue.ref;

var computed = Vue.computed;

var NButton = naive.NButton;

var NInputNumber = naive.NInputNumber;

var NFlex = naive.NFlex;

var BOOL_OPTIONS = [
    ["invincible", "无敌"],
    ["oneHitKill", "一击必杀"],
    ["noSkillCost", "免技能消耗"],
    ["throughWalls", "穿墙"],
    ["noEncounter", "无遇敌"],
    ["showFollowers", "显示跟随者"],
    ["alwaysDash", "常时奔跑"],
    ["speedHoldCtrl", "按住 Ctrl 加速"],
    ["lockHp", "锁 HP", "上帝模式钩子：角色掉血后立即补回锁定值。与「数据」页对存档数据的逐帧锁定是两套机制，互不影响"],
    ["lockHpMax", "锁 HP 上限", "上帝模式钩子：锁 HP 时以上限值为补回目标"],
    ["lockMp", "锁 MP", "上帝模式钩子：技能耗蓝后立即补回锁定值"],
    ["lockTp", "锁 TP", "上帝模式钩子：TP 变化后立即补回锁定值"]
  ];

var NUM_OPTIONS = [
    ["expRate", "经验倍率", 0, 0.1],
    ["goldRate", "金币倍率", 0, 0.1],
    ["dropRate", "掉落倍率", 0, 0.1],
    ["moveSpeedAdd", "移速加成", 0, 1],
    ["gameSpeedMulti", "加速倍率", 1, 1],
    ["lockHpVal", "锁 HP 值", 0, 1, "「锁 HP」开启时掉血补回到这个数值"],
    ["lockMpVal", "锁 MP 值", 0, 1, "「锁 MP」开启时耗蓝补回到这个数值"],
    ["lockTpVal", "锁 TP 值", 0, 1, "「锁 TP」开启时 TP 补回到这个数值"]
  ];

var QUICK_ACTIONS = [
    { label: "全队恢复", type: "party.recover", icon: "heart", kind: "success" },
    { label: "刷新队伍", type: "party.info", icon: "users" },
    { label: "快速存档 (槽1)", type: "save.save", args: { id: 1 }, icon: "save" },
    { label: "读档 (槽1)", type: "save.load", args: { id: 1 }, icon: "archive" },
    { label: "新游戏", type: "game.newGame", icon: "power", confirm: "开始新游戏？未保存的进度会丢失。" },
    { label: "刷新选项", type: "trainer.options.get", icon: "refresh" }
  ];

export { RMCH, store, trainer, h, ref, computed, NButton, NInputNumber, NFlex, BOOL_OPTIONS, NUM_OPTIONS, QUICK_ACTIONS };
