// Launch-route catalogue — the single source of truth for "how does the bridge
// get into this game".
//
// Before this module the answer lived in four places that disagreed with each
// other: LAUNCH_ROUTES (auto/shadow/extension/dll), the dedicated route ids in
// launch-plan.mjs, the strategy strings returned by launcher/attach, and
// scanner.injectionStrategy(). The same game was called "dll" by the planner and
// "launch-inject" by the scanner, and the GUI kept its own hand-written copy of
// the Chinese labels.
//
// Two orthogonal axes are modelled explicitly here, because conflating them is
// what made the old table confusing:
//
//   operation  — what the user asked for: 启动并注入 / 附加 / 接管重启
//   route      — the recipe for one container family, tagged with the mechanism
//                it uses to deliver the bridge.
//
// A mechanism is how the bridge physically reaches the runtime; a route is the
// container-specific recipe that uses it. 运行副本 (a rebuilt copy of the game,
// hard links plus real copies for patched files — "影子目录" is its MV/MZ form)
// is one mechanism shared by several routes, which is why it never made sense
// as a route a user picks for an Essentials or Tauri game.
//
// Each route also carries a userGoal: the short goal-oriented phrase the GUI
// shows as the route's display name. Presentation lives here in the catalogue —
// the GUI keeps no label table of its own.

export const MECHANISMS = Object.freeze({
  extension: {
    id: "extension",
    label: "扩展启动",
    note: "原版 Game.exe 直接加载 bridge 扩展（--load-extension）"
  },
  copy: {
    id: "copy",
    label: "运行副本",
    note: "在独立目录里重建一份游戏（链接 + 需要改动的文件落真副本）；MV/MZ 的「影子目录」就是这一种"
  },
  dll: {
    id: "dll",
    label: "DLL 附加",
    note: "不带任何启动参数地启动游戏，再向渲染进程投递原生桥"
  },
  cdp: {
    id: "cdp",
    label: "CDP 注入",
    note: "打开调试端口，用 Runtime.evaluate 投递桥"
  },
  script: {
    id: "script",
    label: "脚本补丁",
    note: "把桥接代码写进游戏自己的脚本载体（RGSS 脚本归档 / 合体闭包）"
  },
  unpack: {
    id: "unpack",
    label: "解包",
    note: "先把单文件壳里的虚拟文件系统展开成真实目录"
  }
});

// Launch routes: one recipe per container family.
//
// preflight lists what must hold before the route can even be attempted. Items
// the static scan can prove are checked by preflightOf(); the rest (renderer
// appearance, PE architecture, bridge hello) are runtime questions the launcher
// answers by trying.
export const ROUTES = Object.freeze({
  extension: {
    id: "extension",
    label: "扩展启动",
    operation: "launch",
    mechanism: "extension",
    userGoal: "原版直接启动",
    transport: "load-extension",
    preflight: ["game-executable", "private-profile", "bridge-hello"],
    reason: "标准 NW.js 使用原版 Game.exe 加载 bridge 扩展"
  },
  shadow: {
    id: "shadow",
    label: "影子目录",
    operation: "launch",
    mechanism: "copy",
    userGoal: "不动原目录",
    transport: "shadow-dir",
    preflight: ["bg-script", "patch-anchor", "shadow-spawn", "bridge-hello"],
    reason: "bg-script 启动链可在独立影子目录中打补丁"
  },
  dll: {
    id: "dll",
    label: "DLL 附加",
    operation: "launch",
    mechanism: "dll",
    userGoal: "壳拒绝参数时的兜底",
    transport: "native-dll-file",
    preflight: ["plain-spawn", "renderer", "pe-arch", "bridge-hello"],
    reason: "裸启动后向渲染进程投递原生桥"
  },
  "rgss-script": {
    id: "rgss-script",
    label: "RGSS 脚本注入",
    operation: "launch",
    mechanism: "script",
    alsoUses: ["copy"],
    userGoal: "RGSS 游戏专用",
    transport: "rgss-shadow",
    preflight: ["game.ini-library", "scripts-archive"],
    reason: "RGSS 游戏把 Ruby 桥接写进运行副本的 Scripts 归档"
  },
  "evb-unpack-rgss-script": {
    id: "evb-unpack-rgss-script",
    label: "EVB 解包 + RGSS 脚本",
    operation: "launch",
    mechanism: "unpack",
    alsoUses: ["copy", "script"],
    userGoal: "EVB 壳游戏专用",
    transport: "evb-unpack",
    preflight: ["evb-executable"],
    reason: "EVB 单文件壳先解包，再走 RGSS 运行副本脚本注入"
  },
  "tauri-cdp": {
    id: "tauri-cdp",
    label: "Tauri / WebView2 CDP",
    operation: "launch",
    mechanism: "cdp",
    alsoUses: ["copy"],
    userGoal: "Tauri 游戏专用",
    transport: "cdp",
    preflight: ["tauri-executable"],
    reason: "Tauri/WebView2 需要一份打过补丁的可执行副本来打开 CDP"
  },
  "extension-cdp-seed": {
    id: "extension-cdp-seed",
    label: "扩展 + CDP 发布引擎",
    operation: "launch",
    mechanism: "extension",
    alsoUses: ["cdp"],
    userGoal: "封闭 MZ 专用",
    transport: "extension-cdp",
    preflight: ["remote-debug-port", "heap-seed"],
    reason: "封闭 MZ 需要启动调试端口并用 CDP 把引擎对象发布出来"
  },
  "shadow-engine-publish": {
    id: "shadow-engine-publish",
    label: "合体引擎副本发布",
    operation: "launch",
    mechanism: "copy",
    alsoUses: ["script"],
    userGoal: "合体引擎专用",
    transport: "shadow-patched-script",
    preflight: ["bundle-script-anchor"],
    reason: "合体引擎只能在运行副本的闭包里发布运行时对象"
  }
});

// Strategies reported by the attach side. They are not launch routes — attach
// works on a game the user already started (or relaunches it) — but they show up
// in the same log/summary field, so they are registered here too: every strategy
// string the toolbox can emit has a name and a mechanism.
export const ATTACH_ROUTES = Object.freeze({
  "nw-inject": { id: "nw-inject", label: "附加到运行中（DLL）", mechanism: "dll", operation: "attach" },
  "nw-inject-file": { id: "nw-inject-file", label: "附加到运行中（DLL·文件通道）", mechanism: "dll", operation: "attach" },
  "nw-launch-inject": { id: "nw-launch-inject", label: "启动并注入（DLL）", mechanism: "dll", operation: "launch" },
  "nw-launch-inject-file": { id: "nw-launch-inject-file", label: "启动并注入（DLL·文件通道）", mechanism: "dll", operation: "launch" },
  "rgss-inject": { id: "rgss-inject", label: "RGSS 附加（脚本注入）", mechanism: "script", operation: "attach" },
  "sealed-relaunch": { id: "sealed-relaunch", label: "接管重启（封闭 MZ）", mechanism: "extension", operation: "takeover", alsoUses: ["cdp"] },
  "bundled-relaunch": { id: "bundled-relaunch", label: "接管重启（合体引擎）", mechanism: "copy", operation: "takeover", alsoUses: ["script"] }
});

const ALL = { ...ROUTES, ...ATTACH_ROUTES };

export function routeById(id) {
  return ALL[id] || null;
}

export function routeLabel(id) {
  return (ALL[id] && ALL[id].label) || id;
}

export function routeMechanism(id) {
  const entry = ALL[id];
  if (!entry) return null;
  return [entry.mechanism, ...(entry.alsoUses || [])];
}

export function mechanismLabel(id) {
  return (MECHANISMS[id] && MECHANISMS[id].label) || id;
}

export function routeMechanismLabels(id) {
  return (routeMechanism(id) || []).map(mechanismLabel).filter(Boolean);
}

export function routeMechanismText(id) {
  return routeMechanismLabels(id).join(" + ");
}

/**
 * The static half of a route's preflight: only what a scan can prove. Anything
 * else (renderer appearance, PE architecture, bridge hello) is a runtime
 * question and deliberately passes here — the launcher reports it by failing.
 */
export function preflightOf(scan, routeId) {
  const route = ROUTES[routeId];
  if (!route) return { ok: true, reason: null };
  const items = route.preflight || [];
  if (items.includes("bg-script")) {
    const bgScript = !!(scan && scan.manifest && scan.manifest.bgScript);
    if (!bgScript) return { ok: false, reason: "影子路线需要可打补丁的 bg-script，这个游戏没有" };
  }
  if (items.includes("game-executable")) {
    const hasExe = !!(scan && scan.paths && scan.paths.exe);
    if (!hasExe) return { ok: false, reason: "没有确定的游戏 EXE，无法用原版 Game.exe 启动" };
  }
  return { ok: true, reason: null };
}
