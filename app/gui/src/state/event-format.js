// Independent labels for RPG Maker's serialized event codes. Parameters remain
// available verbatim, including commands introduced by games and plugins.
const names = {
  0: "结束",
  101: "显示文章",
  102: "显示选项",
  103: "输入数值",
  104: "选择物品 / 文章选项",
  105: "滚动文字 / 按键输入",
  106: "等待（XP）",
  108: "注释",
  111: "条件分支",
  112: "循环",
  113: "跳出循环",
  115: "结束事件处理",
  117: "调用公共事件",
  118: "标签",
  119: "跳转标签",
  121: "操作开关",
  122: "操作变量",
  123: "操作独立开关",
  124: "操作计时器",
  125: "增减金钱",
  126: "增减物品",
  127: "增减武器",
  128: "增减防具",
  129: "更改队伍成员",
  131: "更改窗口外观（XP）",
  132: "更改战斗 BGM",
  133: "更改胜利 ME",
  134: "更改存档许可",
  135: "更改菜单许可",
  136: "更改遇敌许可",
  137: "更改队列许可",
  138: "更改窗口颜色",
  139: "更改战败 ME",
  140: "更改载具 BGM",
  201: "场所移动",
  202: "设置载具 / 事件位置",
  203: "设置事件位置 / 地图滚动",
  204: "滚动地图 / 更改地图设置",
  205: "设置移动路线 / 雾色调",
  206: "载具乘降 / 雾不透明度",
  207: "显示动画",
  208: "更改透明状态",
  209: "设置移动路线（XP）",
  210: "等待移动结束（XP）",
  211: "更改透明状态（XP）",
  212: "显示动画",
  213: "显示气泡",
  214: "暂时消除事件",
  216: "更改队列显示",
  217: "集合队列",
  221: "淡出画面 / 准备转场",
  222: "淡入画面 / 执行转场",
  223: "更改画面色调",
  224: "闪烁画面",
  225: "震动画面",
  230: "等待",
  231: "显示图片",
  232: "移动图片",
  233: "旋转图片",
  234: "更改图片色调",
  235: "消除图片",
  236: "设置天气",
  241: "播放 BGM",
  242: "淡出 BGM",
  243: "保存 BGM",
  244: "重播 BGM",
  245: "播放 BGS",
  246: "淡出 BGS",
  247: "保存 BGM/BGS（XP）",
  248: "重播 BGM/BGS（XP）",
  249: "播放 ME",
  250: "播放 SE",
  251: "停止 SE",
  261: "播放影片",
  281: "更改地图名称显示",
  282: "更改图块组",
  283: "更改战斗背景",
  284: "更改远景",
  285: "获取位置信息",
  301: "战斗处理",
  302: "商店处理",
  303: "名字输入",
  311: "增减 HP",
  312: "增减 MP / SP",
  313: "增减状态",
  314: "完全恢复",
  315: "增减经验",
  316: "增减等级",
  317: "增减能力值",
  318: "增减技能",
  319: "更改装备",
  320: "更改名字",
  321: "更改职业",
  322: "更改角色图像",
  323: "更改载具图像",
  324: "更改昵称",
  325: "更改简介",
  326: "增减 TP",
  331: "增减敌人 HP",
  332: "增减敌人 MP / SP",
  333: "更改敌人状态",
  334: "敌人完全恢复",
  335: "敌人出现",
  336: "敌人变身",
  337: "显示战斗动画",
  339: "强制行动",
  340: "中止战斗",
  342: "增减敌人 TP",
  351: "打开菜单",
  352: "打开存档",
  353: "游戏结束",
  354: "返回标题",
  355: "脚本",
  356: "插件命令",
  357: "插件命令（MZ）",
  401: "文章内容",
  402: "选项分支",
  403: "取消分支",
  404: "选项结束",
  405: "滚动文字内容",
  408: "注释续行",
  411: "否则",
  412: "条件结束",
  413: "循环返回",
  505: "移动路线指令",
  601: "战斗胜利",
  602: "战斗逃跑",
  603: "战斗失败",
  604: "战斗分支结束",
  605: "商店商品续行",
  655: "脚本续行",
  657: "插件参数说明"
};
const xp = {
  104: "更改文章选项",
  105: "处理按键输入",
  202: "设置事件位置",
  203: "地图滚动",
  204: "更改地图设置",
  205: "更改雾色调",
  206: "更改雾不透明度",
  207: "显示动画",
  208: "更改透明状态"
};
export function raw(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
export function describeCommand(command, engine = "") {
  const p = command.parameters || [],
    code = command.code;
  const name =
    (/XP|RGSS1/i.test(engine) && xp[code]) || names[code] || "未知指令";
  let detail = "";
  if ([108, 408, 355, 356, 401, 405, 655, 657].includes(code))
    detail = p.map((v) => (typeof v === "string" ? v : raw(v))).join("\n");
  else if (code === 117) detail = "公共事件 #" + p[0];
  else if (code === 121)
    detail = "#" + p[0] + "–#" + p[1] + " → " + (p[2] === 0 ? "ON" : "OFF");
  else if (code === 123) detail = p[0] + " → " + (p[1] === 0 ? "ON" : "OFF");
  else if (code === 111) {
    if (p[0] === 0)
      detail = "开关 #" + p[1] + " 为 " + (p[2] === 0 ? "ON" : "OFF");
    else if (p[0] === 1)
      detail =
        "变量 #" +
        p[1] +
        " " +
        (["＝", "≥", "≤", ">", "<", "≠"][p[4]] || "?") +
        " " +
        (p[2] === 0 ? p[3] : "变量 #" + p[3]);
    else if (p[0] === 2)
      detail = "独立开关 " + p[1] + " 为 " + (p[2] === 0 ? "ON" : "OFF");
    else if (p[0] === 12) detail = "脚本条件（只读，不求值）：" + p[1];
    else detail = "条件类型 " + p[0] + " · " + raw(p.slice(1));
  } else if (code === 122)
    detail =
      "变量 #" +
      p[0] +
      "–#" +
      p[1] +
      " " +
      (["赋值", "加", "减", "乘", "除", "取余"][p[2]] || "?") +
      " · 操作数 " +
      raw(p.slice(3));
  else if (code === 102)
    detail = Array.isArray(p[0]) ? p[0].join(" / ") : raw(p);
  else if (code === 201)
    detail =
      (p[0] === 0 ? "直接指定地图与坐标：" : "由变量指定地图与坐标：") +
      p.slice(1, 4).join(", ");
  else if (p.length) detail = raw(p);
  return {
    name,
    detail,
    text: code + " " + name + " " + detail + " " + raw(p)
  };
}
export function describeConditions(conditions = {}, values = {}) {
  const lines = [],
    value = (key) =>
      values[key] == null
        ? "未知"
        : typeof values[key] === "boolean"
          ? values[key]
            ? "ON / 是"
            : "OFF / 否"
          : raw(values[key]);
  for (const n of [1, 2])
    if (conditions["switch" + n + "Valid"]) {
      const id = conditions["switch" + n + "Id"];
      lines.push("开关 #" + id + " 为 ON；读取时：" + value("switch:" + id));
    }
  if (conditions.variableValid)
    lines.push(
      "变量 #" +
        conditions.variableId +
        " ≥ " +
        conditions.variableValue +
        "；读取时：" +
        value("variable:" + conditions.variableId)
    );
  if (conditions.selfSwitchValid)
    lines.push(
      "独立开关 " +
        conditions.selfSwitchCh +
        " 为 ON；读取时：" +
        value("selfSwitch")
    );
  if (conditions.itemValid)
    lines.push("持有物品 #" + conditions.itemId + "；读取时：" + value("item"));
  if (conditions.actorValid)
    lines.push(
      "角色 #" + conditions.actorId + " 在队伍；读取时：" + value("actor")
    );
  return lines.length ? lines : ["无生效条件"];
}
