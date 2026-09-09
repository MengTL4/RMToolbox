# 启动路线只有一份目录：路线按容器分，机制作为属性

启动路线曾经有四套并存的词汇——`LAUNCH_ROUTES`（auto/shadow/extension/dll）、计划里的专用路线 id、launcher/attach 回报的 strategy 字符串、以及 `scanner.injectionStrategy()` 的老 id——它们对同一款游戏给出不同名字（末日风暴：计划说 `dll`，scanner 说 `launch-inject`），GUI 还自己抄了一份中文标签。我们决定：**建一份路线目录 `core/launch-routes.mjs` 作为唯一来源，路线按游戏壳（容器）划分，投递机制（扩展加载 / 运行副本 / DLL 附加 / CDP 注入 / 脚本补丁 / 解包）降级为路线的属性**，并删掉 `injectionStrategy()`。

## 为什么

- **"影子目录"是机制，不是所有复制类路线的名字**。实测库里 12 个游戏，首选 `shadow` 的是 0 个，而"复制一份再打补丁"（运行副本）这个机制覆盖了影子目录、RGSS 脚本、EVB 解包、Tauri、合体引擎五条路线。把机制当路线，用户就会在 Essentials 游戏上看到"影子目录"这个不存在的选项。
- **四套词汇必然漂移**，而且已经有证据：`injectionStrategy()` 还留着早已不存在的 `extension-then-shadow`。它现在只剩两个用途（拼一句 `strategyReason`、被四个测试断言），删掉比修更省。
- **计划里承诺的 `fallback` 和 `preflight` 没有任何消费者**，只有测试在读——等于对外宣称"失败可退回下一条路线"却从没实现。

## 取舍

- **保留路线 id 不变**（`shadow`/`dll`/`rgss-script`/…），只把标签、机制、preflight 收敛到目录里：日志、验收记录、用户心智都不用改。
- **fallback 只实现到"串行重试两条、且只在桥接 hello 之前"**，而不是完整状态机：并发或多次重试会冒出多个游戏窗口，收益远小于风险。操作系统拒绝执行（ENOENT/EACCES/EPERM/ENOEXEC）不重试——那是游戏坏了，换路线没用。
- **用户显式选定的路线永不改写**：原样交给启动器，由它给出精确诊断（"没有可打补丁的 bg-script"、"入口 EXE 有歧义"），避免"静默换成另一条路线"掩盖用户的选择。

## 后果

- GUI 的下拉标签、日志里的 strategy、计划输出全部由目录派生，新增一条路线只改一处。
- 附加侧的策略字符串（`nw-inject`、`rgss-inject`、`sealed-relaunch`…）不是启动路线，但同样登记在目录里，因此日志里出现的每个 strategy 都查得到中文名。
- `scanner.injectionStrategy()` 的调用方（launcher 的 `strategyReason`、4 个测试、1 个探针脚本）改为读 `planLaunch()`。
- CONTEXT.md 新增「启动路线」「投递机制」「运行副本」三个词，「影子目录」收窄为 MV/MZ 专用路线的名字。
