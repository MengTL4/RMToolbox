# 启动路线判定设计

## 目标

“启动并注入”先解决递送方式，再解决运行时适配。递送方式包括影子目录、原生 DLL、NW 扩展和专用 CDP/RGSS 路线；MV/MZ、封闭引擎、RGSS、Essentials 等属于不同的运行时适配器。不能因为 DLL 返回成功就把游戏标记为已适配，也不能因为一个场景停在对话中就再次注入。

路线判定的唯一入口是 `core/launch-plan.mjs` 的 `planLaunch(scan, { strategy })`。它是纯函数，不启动进程、不写文件，返回可序列化的计划：

```js
{
  family: "standard-nwjs",
  requested: "auto",
  preferred: "shadow",
  selected: "shadow",
  candidates: ["shadow", "extension", "dll"],
  fallback: ["extension", "dll"],
  blocked: [],
  readiness: {
    required: ["process", "bridge-hello", "runtime-ready"],
    fallbackOnlyBefore: "bridge-hello"
  }
}
```

`GameRuntime` 只负责把计划映射到现有启动器。DLL 路线仍接收原来的窄参数，避免破坏 GUI、CLI 和附加逻辑；返回结果带有不可枚举的 `launchPlan`，宿主可以显示或记录选择原因。

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

## 当前路线矩阵

| 扫描特征 | 首选 | 允许的备用 | 说明 |
| --- | --- | --- | --- |
| 普通 NW.js + `bg-script` | `shadow` | `extension`, `dll` | 影子目录补丁启动链，原目录不改 |
| 普通 NW.js 无 `bg-script` | `extension` | `dll` | 没有影子补丁入口 |
| `grover-boot` | `dll` | `shadow`（有 `bg-script` 时） | 裸启动后等待保护检查，再投递 DLL |
| `nb-evalnwbin` | `dll` | 无 | 启动参数和页内 WebSocket 会使游戏退出 |
| `enigma-nb` | `dll` | 无 | 启动参数会使 Enigma 盒退出 |
| RGSS / Essentials | `rgss-script` | 专用 RGSS attach | 不套 MV/MZ 桥 |
| Tauri / sealed / bundled | 专用路线 | 无通用 DLL | 需要 CDP、堆发布或脚本闭包发布 |
| `nb-shell` | 拒绝 | 无 | 壳会检测启动参数和 DLL |

## 失败和缓存

计划中保留 `preferred`、`candidates`、`blocked` 和 `fallback`，但当前不会在桥接尚未确认前盲目同时启动两条路线。后续如果需要自动 fallback，应让启动器返回明确的阶段结果，并在同一个启动尝试中采用以下状态机：

```text
planned → spawned → bridge-hello → runtime-ready → accepted
                 ↘ delivery-failed → next candidate
```

路线健康缓存应绑定游戏根目录、入口 EXE 和关键启动文件的指纹。游戏更新、入口变化或保护标记变化时清除缓存，重新做静态和运行时探测。

