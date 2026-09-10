# 启动路线判定设计

## 目标

“启动并注入”先解决递送方式，再解决运行时适配。这里有两层，不要混用：

- **启动路线**：某个游戏壳对应的一套固定做法（扩展启动、影子目录、DLL 附加、Tauri/CDP、EVB 解包 + RGSS 脚本……）。
- **投递机制**：路线把桥接送进运行时所用的手段（扩展加载、运行副本、DLL 附加、CDP 注入、脚本补丁、解包）。一条路线用一种主机制，可叠加其他机制；一种机制可以被多条路线共用——运行副本就是影子目录、RGSS、Tauri、合体引擎四条路线共用的机制。

MV/MZ、封闭引擎、RGSS、Essentials 等属于不同的运行时适配器。不能因为 DLL 返回成功就把游戏标记为已适配，也不能因为一个场景停在对话中就再次注入。

路线判定的唯一入口是 `core/launch-plan.mjs` 的 `planLaunch(scan, { strategy })`。它是纯函数，不启动进程、不写文件，返回可序列化的计划。路线本身的身份（id、中文名、机制、preflight）只有一份定义，在 `core/launch-routes.mjs`；计划的候选、GUI 下拉、日志里的 strategy 字符串全部由它派生：

```js
{
  family: "standard-nwjs",
  requested: "auto",
  preferred: "shadow",
  selected: "shadow",
  candidates: [{ id: "shadow", label: "影子目录", userGoal: "不动原目录", mechanism: ["copy"], mechanismLabel: "运行副本", … }, …],
  fallback: ["extension", "dll"],
  blocked: [],
  readiness: {
    required: ["process", "bridge-hello", "runtime-ready"],
    fallbackOnlyBefore: "bridge-hello"
  }
}
```

`GameRuntime` 把计划映射到现有启动器：DLL 路线仍接收原来的窄参数，避免破坏 GUI、CLI 和附加逻辑；返回结果带有不可枚举的 `launchPlan` 和 `routeAttempts`，宿主可以显示或记录选择原因。

计划里的 `fallback` 在这层被真正执行：首选路线在桥接 hello 之前失败时，自动尝试下一个候选（最多两条），尝试过程写进 `routeAttempts` 和日志。静态就能否决的候选（`preflightOf`：缺 bg-script、入口 EXE 不确定）跳过而不是硬试；操作系统直接拒绝执行文件（ENOENT / EACCES / EPERM / ENOEXEC）不重试——那是游戏坏了，不是路线错了。用户显式选定的路线永远原样交给启动器，由启动器给出精确诊断。

## 判定顺序

1. 先按容器和引擎排除专用路线：`nb-shell`、EVB、RGSS、Tauri、sealed、bundled、RM2K。
2. 对普通 NW.js 检查 `bg-script` 和保护标记。
3. `bg-script` 存在时把影子目录加入候选；没有时影子目录进入阻断原因。
4. 普通 NW.js 同时保留扩展和 DLL 候选，实际健康状态必须由启动后的桥接握手确认。
5. `grover-boot` 首选裸启动后 DLL；影子目录只作为显式备用路线。
6. `nb-evalnwbin` 和 Enigma-NB 只允许裸启动后 DLL，分别使用文件通道和 WebSocket。
7. `nb-shell` 直接拒绝，不进行“再试一条注入路线”的危险重试。

## 路线健康标准

静态候选只说明“值得尝试”。一条路线记录为健康前，启动器或验收脚本必须依次确认：

```text
游戏进程出现
→ renderer/页面就绪
→ bridge hello
→ 数据库或运行时对象可读
→ 一次可回滚命令成功
→ 存档位置可读写
```

桥接 hello 之前的进程退出、入口歧义、影子补丁失败、DLL 位数或权限错误属于递送失败，可以使用计划中的下一候选。桥接 hello 之后的对话阻塞、场景不可操作、数据库为空或游戏原生拒绝修改属于运行时状态或适配器问题，不能用第二次注入掩盖。

## 当前路线矩阵（机制一列来自 `core/launch-routes.mjs`）

| 扫描特征 | 首选 | 机制 | 允许的备用 | 说明 |
| --- | --- | --- | --- | --- |
| 普通 NW.js + `bg-script` | `shadow` | 运行副本 | `extension`, `dll` | 影子目录补丁启动链，原目录不改 |
| 普通 NW.js 无 `bg-script` | `extension` | 扩展加载 | `dll` | 没有影子补丁入口 |
| `grover-boot` | `dll` | DLL 附加 | `shadow`（有 `bg-script` 时） | 裸启动后等待保护检查，再投递 DLL |
| `nb-evalnwbin` | `dll` | DLL 附加 | 无 | 启动参数和页内 WebSocket 会使游戏退出 |
| `enigma-nb` | `dll` | DLL 附加 | 无 | 启动参数会使 Enigma 盒退出 |
| RGSS / Essentials | `rgss-script` | 脚本补丁 + 运行副本 | 专用 RGSS attach | 不套 MV/MZ 桥 |
| EVB 单文件壳 | `evb-unpack-rgss-script` | 解包 + 脚本补丁 + 运行副本 | 无 | 先展开虚拟文件系统 |
| Tauri / WebView2 | `tauri-cdp` | CDP 注入 + 运行副本 | 无 | 需要打过补丁的可执行副本 |
| sealed MZ | `extension-cdp-seed` | 扩展加载 + CDP 注入 | 无 | CDP 堆扫描发布引擎对象 |
| 合体引擎 | `shadow-engine-publish` | 运行副本 + 脚本补丁 | 无 | 只能在闭包内发布运行时对象 |
| `nb-shell` | 拒绝 | — | 无 | 壳会检测启动参数和 DLL |

附加侧的策略字符串（`nw-inject`、`nw-launch-inject-file`、`rgss-inject`、`sealed-relaunch`、`bundled-relaunch`…）不是启动路线，但也登记在同一份目录里，日志里出现的每个 strategy 都能查到中文名和机制。

## 机制 × 路线矩阵

路线按容器划分、机制是路线的属性；换一个方向看，一种机制可以被多条路线共用。下表按机制归组路线（数据来自 `core/launch-routes.mjs` 的 `mechanism` / `alsoUses`）：

| 机制 | 作为主机制的路线 | 叠加使用的路线 |
| --- | --- | --- |
| 扩展加载 | extension、extension-cdp-seed | — |
| 运行副本 | shadow、shadow-engine-publish | rgss-script、evb-unpack-rgss-script、tauri-cdp |
| DLL 附加 | dll | — |
| CDP 注入 | tauri-cdp | extension-cdp-seed |
| 脚本补丁 | rgss-script | evb-unpack-rgss-script、shadow-engine-publish |
| 解包 | evb-unpack-rgss-script | — |

运行副本是覆盖最广的机制（5 条路线）；DLL 附加只有一条路线，但它是所有拒绝启动参数的壳（grover-boot、nb-evalnwbin、enigma-nb）的唯一活路。

GUI 的路线呈现也只有目录这一个来源：主标签取目录里的 `userGoal`（面向用户目标的短句），提示取 `mechanismLabel` 与 `reason`，GUI 不保留自己的标签表。用户在下拉中做的路线选择只保存在内存（每次会话有效），不落盘——若未来要"记住选择"，需要新增存储并定义其格式。

## 失败和缓存

计划保留 `preferred`、`candidates`、`blocked` 和 `fallback`，并且不会在桥接尚未确认前同时启动两条路线——回退是串行的：一条失败，才试下一条。启动器返回明确的阶段结果后，同一个启动尝试走以下状态机：

```text
planned → spawned → bridge-hello → runtime-ready → accepted
                 ↘ delivery-failed → next candidate
```

路线健康缓存应绑定游戏根目录、入口 EXE 和关键启动文件的指纹。游戏更新、入口变化或保护标记变化时清除缓存，重新做静态和运行时探测。

