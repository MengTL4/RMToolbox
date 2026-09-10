// Generate the bridge command reference from the bridge sources.
//
// The command table is defined by hand in runtime/bridge/src/parts/*-commands-*.js
// and mirrored by runtime/rgss-bridge/bridge.rb, so a hand-written list in docs
// would drift the first time a command is added. This reads the registrations
// instead. `npm test` runs this with --check so a stale reference fails the
// suite rather than shipping.
//
//   node tools/commands-doc.mjs           # write docs/user/COMMANDS.md
//   node tools/commands-doc.mjs --check   # fail if the file is not up to date
//
// A command is documented with the comment lines directly above its name. The
// first line becomes the summary; anything after it is kept as detail. Write
// those comments for the user, not for the next reader of the bridge: they end
// up in the only reference users have.

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const partsDir = path.join(root, "runtime", "bridge", "src", "parts");
const outPath = path.join(root, "docs", "user", "COMMANDS.md");

// Section headers follow the source's own banner comments, e.g.
//   // Commands: core / diagnostics.
const SECTION = /^\s*\/\/\s*Commands:\s*(.+?)\.?\s*$/;
// Per-group markers inside a command table: `// --- gold ----...`
const GROUP = /^\s*\/\/\s*-{2,}\s*([a-z][a-z0-9 ,/'-]*?)\s*-{2,}\s*$/i;
const KEY = /^\s*"([a-z][A-Za-z0-9]*\.[A-Za-z0-9_.]+)"\s*:/;
// Separator rules inside the command tables are visual grouping, not documentation.
const SEPARATOR = /^-{2,}.*-{2,}$/;

function parseParts() {
  const files = fs
    .readdirSync(partsDir)
    .filter((name) => /-commands-.*\.js$/.test(name))
    .sort();
  const commands = [];
  for (const file of files) {
    const lines = fs
      .readFileSync(path.join(partsDir, file), "utf8")
      .split(/\r?\n/);
    let section = "";
    let group = "";
    let pending = [];
    for (const line of lines) {
      const header = SECTION.exec(line);
      if (header) {
        section = header[1].trim();
        pending = [];
        continue;
      }
      const marker = GROUP.exec(line);
      if (marker) {
        // A group marker is both a heading and the end of any running comment.
        group = marker[1].trim().toLowerCase();
        pending = [];
        continue;
      }
      const key = KEY.exec(line);
      if (key) {
        const text = pending.filter((part) => !SEPARATOR.test(part));
        commands.push({
          name: key[1],
          file,
          // Prefer the fine-grained group marker; fall back to the file banner.
          section: group || section,
          // A comment block is wrapped prose: join it back into one sentence.
          description: text.join(" ").replace(/\s+/g, " ").trim()
        });
        pending = [];
        continue;
      }
      const comment = /^\s*\/\/\s?(.*)$/.exec(line);
      if (comment) {
        pending.push(comment[1].trim());
        continue;
      }
      // Any real code ends the comment block that could describe the next command.
      if (line.trim()) pending = [];
    }
  }
  return commands;
}

function render(commands) {
  const sections = [];
  for (const command of commands) {
    const name = command.section || `${command.file}（未分组）`;
    let section = sections.find((s) => s.name === name);
    if (!section) sections.push((section = { name, commands: [] }));
    section.commands.push(command);
  }
  const slug = (name) =>
    name
      .toLowerCase()
      .replace(/[^\w\u4e00-\u9fff]+/g, "-")
      .replace(/^-|-$/g, "");
  const out = [];
  out.push("# 桥接命令参考");
  out.push("");
  out.push(
    "由 `node tools/commands-doc.mjs` 从 `runtime/bridge/src/parts/*-commands-*.js`"
  );
  out.push("生成，请勿手改；分片里的注释就是本文件里每个命令的说明。");
  out.push("");
  out.push("```powershell");
  out.push("node tools/rmch.mjs send <gameKey> <命令名> '<JSON 参数>'");
  out.push("```");
  out.push("");
  out.push(
    "参数是一个 JSON 对象。命令名同时适用于 MV/MZ 与 XP/VX/VX Ace——RGSS 桥接"
  );
  out.push(
    "镜像同一套命令名，引擎本身做不到的命令会明确报错，而不是静默失败。"
  );
  out.push(
    "在游戏里也可以直接执行代码：MV/MZ 用 `console.eval`，RGSS 用工具箱控制台。"
  );
  out.push("");
  out.push(`共 **${commands.length}** 条命令。`);
  out.push("");
  out.push("## 目录");
  out.push("");
  for (const section of sections) {
    out.push(
      `- [${section.name}](#${slug(section.name)})（${section.commands.length}）`
    );
  }
  out.push("");
  for (const section of sections) {
    out.push(`## ${section.name}`);
    out.push("");
    out.push("| 命令 | 说明 |");
    out.push("| --- | --- |");
    for (const command of section.commands) {
      const description = (command.description || "—").replace(/\|/g, "\\|");
      out.push(`| \`${command.name}\` | ${description} |`);
    }
    out.push("");
  }
  const undocumented = commands.filter((c) => !c.description);
  out.push("## 说明");
  out.push("");
  if (undocumented.length) {
    out.push(
      `以下 ${undocumented.length} 条命令在源码里没有紧邻的注释，说明暂缺：`
    );
    out.push("");
    out.push(undocumented.map((c) => `\`${c.name}\``).join("、"));
    out.push("");
  }
  out.push(
    `来源分片：${[...new Set(commands.map((c) => c.file))].map((f) => "`" + f + "`").join("、")}`
  );
  out.push("");
  return out.join("\n");
}

const commands = parseParts();
if (!commands.length)
  throw new Error(`no command registrations found under ${partsDir}`);
const markdown = render(commands);

if (process.argv.includes("--check")) {
  const current = fs.existsSync(outPath)
    ? fs.readFileSync(outPath, "utf8")
    : "";
  if (current !== markdown) {
    throw new Error(
      `${path.relative(root, outPath)} is out of date — run: node tools/commands-doc.mjs`
    );
  }
  console.log(`command reference up to date (${commands.length} commands)`);
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, markdown);
  console.log(
    `wrote ${path.relative(root, outPath)} (${commands.length} commands)`
  );
}
