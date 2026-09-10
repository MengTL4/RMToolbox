# tools/

这个目录有 120 多个文件，很难一眼看出从哪下手。这份清单是导航：**先看「入口」和「测试」两节**，其余按需查阅。

分类依据是文件之间的实际引用关系，不是命名习惯；新增脚本请顺手更新本文件。

## 入口（最常用）

| 文件             | 用途                                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `rmch.mjs`       | 命令行总入口：`scan` / `launch` / `attach` / `plan` / `serve` / `bridge-build` / `token` / `send`。不带参数运行会打印全部子命令 |
| `send.mjs`       | 向运行中的游戏发一条桥接命令（`rmch.mjs send` 用它）                                                                            |
| `serve.mjs`      | 只起桥接服务器，不开 GUI                                                                                                        |
| `launch-gui.ps1` | 从源码启动 GUI（自动准备 NW.js 运行时后开窗）                                                                                   |

## 测试

`test-*.mjs` / `test-*.cjs` 是回归测试，其中大部分由 `npm test` 串联执行（见 `package.json`）。分三类：

- **能在任何机器上跑**：绝大多数，纯 Node，不需要游戏本体、不需要网络。
- **需要 NW.js 运行时**：`test-gui-runtime.mjs`，单独用 `npm run test:gui-runtime` 跑，不在 `npm test` 链里。
- **需要真实游戏本体、只在本机跑**：`test-rgss-hooks.mjs`、`test-rgss-contents.mjs` 等 RGSS 集成测试。注意它们会真的把存档同步回游戏安装目录，`test-rgss-contents.mjs` 还会删一个真实存档文件。

需要 Ruby 的测试（`test-event-execution.mjs`、`test-event-tools.mjs`、`test-save-files.mjs`）在缺 Ruby 时会**直接报错**而不是静默跳过——详见 `tools/lib/ruby-fixture.mjs`。临时想跑不完整的测试可以加 `--allow-skip`。

`test-ui-browser.mjs` 用无头 Chrome 渲染真实界面（需 `CHROME_PATH`，默认找系统 Chrome），是唯一能验证 Naive UI 升级有没有砸掉界面的测试。

### RGSS 实机验收（`test-rgss-hooks` / `test-rgss-contents` / `test-rgss-saves`）

这三个会**启动真实游戏**，并在**游戏真实目录里写一个存档槽位**，跑完再删掉。

- **用游戏的隔离副本跑，别用你在意的安装目录。**
- 槽位默认 3，可用 `RMCH_TEST_SAVE_SLOT` 覆盖：
  `$env:RMCH_TEST_SAVE_SLOT = "5"; node tools/test-rgss-contents.mjs "<gameRoot>"`
- 槽位**必须空闲**，否则报 `slot N already has a save — refusing to clobber it`。这是**保护你真实存档的护栏，不是缺陷**。两个常见原因：游戏自己开场就写档（**BLACK SOULS 每次启动都会占住槽位 3**），或上一次运行在清理前异常退出。**换槽位，不要删文件**——那可能是真存档。
- 异常中断会留下存档残留，下次运行就会被护栏挡住。失败后先看一眼游戏目录。

## 构建与发布

| 文件                  | 用途                                                              |
| --------------------- | ----------------------------------------------------------------- |
| `gui-build.mjs`       | 生成 `app/gui/gui-bundle.cjs` + `app/gui/ui/modern.js`            |
| `gui-frontend.mjs`    | Vite 构建 SFC 前端                                                |
| `gui-check.mjs`       | GUI 预检：SFC 语法、生成物是否过期、Naive 导出面、jsoneditor 资源 |
| `commands-doc.mjs`    | 从桥接源码生成 `docs/user/COMMANDS.md`；`--check` 用于 CI         |
| `pack-release.mjs`    | 打 Release zip                                                    |
| `verify-release.mjs`  | 逐条校验 zip 内容与 staging 一致                                  |
| `check-workflow.mjs`  | 校验 CI workflow 引用的脚本/工具是否还存在（已纳入 `npm test`）   |
| `setup-gui.mjs`       | 下载并校验 `nw-runtime.lock.json` 指定的 NW.js                    |
| `build-inject.mjs`    | 用 MinGW 构建 `runtime/inject/`（需要 MSYS2，见 DEVELOPMENT.md）  |
| `build-wmic-shim.mjs` | 构建 wmic 兼容 shim                                               |
| `bake-icon.mjs`       | 从 SDF 生成应用图标                                               |

**改了桥接源码或前端后必须重新生成**，否则 `gui-check` 会失败：`node tools/gui-build.mjs && node tools/rmch.mjs bridge-build`。

## 实机探针 `probes/`（历史笔记）

`probes/` 里的 56 个脚本是适配具体游戏时写的一次性探针，**需要在本机有一份对应的游戏本体**，不少还带着硬编码的本机路径。它们不是产品的一部分，保留价值在于记录了当时怎么排查的：

- `_probe-ess-*.mjs` — Pokemon Essentials 命令面/队伍/存储箱/调试菜单
- `_probe-*.mjs`（RGSS 族）— 从 `process.argv[2]` 拿游戏根目录，用于 RGSS 系列排查
- `_probe-shadow-cmd.mjs`、`_probe-tauri-cdp.mjs`、`_probe-evb-launch.mjs`、`_probe-gui-actor.mjs`
- `retest-*.mjs` — 2026-09-08/09 那轮验收的批量驱动脚本
- `e2e-*.mjs`、`m2-acceptance.mjs`、`smoke-runtime-readonly.mjs` 仍在 `tools/` 顶层（被文档引用较多）

**`probes/` 里的脚本不要用 Prettier 格式化**（已在 `.prettierignore` 排除），也不要指望它们互相 import——它们是各自独立的实地笔记。

### 危险清单：会写盘/改档的探针

跑之前先看清楚，这些不是只读的：

| 脚本                                                                                       | 危险动作                                                                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `_probe-frame.mjs`、`_probe-frame2.mjs`、`_probe-hooks.mjs`、`_probe-paths.mjs`            | **就地改写 `argv[2]` 指向的归档文件**（读入 → 替换脚本条目 → 写回）。传真实游戏的 `Game.rgss3a` 会直接改坏它 |
| `test-rgss-hooks.mjs`、`test-rgss-contents.mjs`、`test-rgss-saves.mjs`（在 `tools/` 顶层） | 启动真实 RGSS 游戏，**把存档同步回游戏安装目录**；`test-rgss-contents.mjs` 还会删除一个真实存档文件          |

只读的探针（可以放心对着真实游戏跑）：`_probe-icons.mjs`、`_dump-*.mjs`、`_probe-enigma-pe.mjs`。

### 搬迁过（2026-09）

这 56 个脚本从 `tools/` 顶层搬进了 `probes/`，搬迁时同步改了三类路径：`../core/` → `../../core/`、`import.meta.dirname` 的仓库根推算加一级、以及 `retest-*` 之间写死的 `"tools/retest-*.mjs"` 子进程路径。

**`npm test` 会跑 `tools/check-probes.mjs` 守住这件事**：它逐个加载 `probes/` 下每个脚本并断言失败原因不是模块解析错误。判据是刻意的——脚本无参数运行本来就会因为缺文件/缺参数而失败，**只有 `ERR_MODULE_NOT_FOUND` 才算搬迁把 import 弄坏了**。

## 清理验收目录时会踩的坑：删不掉的 `nul`

验收脚本运行后，游戏副本目录里会留下**名为 `nul` 的文件**（Windows 保留设备名）。它用常规办法删不掉——`Remove-Item`、`del`，甚至 `rmdir /s /q` 都会失败或留下残留，因为 Win32 把它当空设备解析而不是文件。

已实测可用的清理办法（拿空目录镜像一遍）：

```powershell
$target = "E:\project\RMToolbox\tmp"
$empty = Join-Path $env:TEMP "rmch-empty"
New-Item -ItemType Directory -Force -Path $empty | Out-Null
robocopy $empty $target /MIR /NFL /NDL /NJH /NJS /NC /NS | Out-Null
Remove-Item $target -Recurse -Force
```

`nul` 的确切来源没有定论：重定向目标或子进程 stdio 路径被当成相对路径时，就会落到当时的工作目录里。两条实用的结论——**别把这类文件复制进游戏存档备份**（会让之后的恢复一起失败）；**今后写会重定向输出的验收脚本，用 `stdio: "ignore"` 或绝对路径，不要传裸 `nul`**。

## 子目录

- `probes/` — 见上（56 个实机探针与验收驱动）
- `fixtures/` — 测试夹具（MV 引擎片段、RGSS 的 `.rb` 夹具、GUI host 桩）
- `lib/` — 测试与工具之间共享的助手（`ruby-fixture.mjs`）
- `debug/` — 一次性调试助手（`storm-*` / `homecoming-*` 需要先起对应的 `*-session.mjs`）
