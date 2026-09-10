// Running the Ruby fixtures from a test, out loud.
//
// The RGSS adapters (XP / VX / VX Ace) are first-class engines for this project,
// but their fixtures need a host `ruby`. The tests used to swallow that:
//
//   if (ruby.error?.code === 'ENOENT') console.log('SKIP ...');
//
// which exits 0. So on a machine without Ruby the suite went green having
// executed none of the RGSS coverage, and `npm test` could not tell "passed"
// from "never ran". Missing Ruby is now a failure with the fix in the message;
// pass --allow-skip only when you deliberately want the partial run.

import { spawnSync } from "node:child_process";
import path from "node:path";

const toolsDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(toolsDir, "..");
const allowSkip = process.argv.includes("--allow-skip");

// The fixtures under tools/fixtures read their neighbours through paths relative
// to the repository root, which is how the tests used to launch them.
export const rubyFixtureCwd = repoRoot;

export function rubyFixturePath(name) {
  return path.join(toolsDir, "fixtures", name);
}

// Returns the ruby command to use, or null when the caller passed --allow-skip
// and no interpreter is installed. Throws otherwise: a silently skipped fixture
// is worse than a red test, because it looks like coverage that does not exist.
//
// The probe runs a real Ruby expression rather than `--version`. A name that
// resolves but is not actually Ruby (a shim, a wrong PATH entry) must be caught
// here — otherwise the fixture fails later with an opaque error, which is
// exactly the "green but nothing ran" confusion this module exists to remove.
const PROBE = ["-e", "exit 0"];

export function requireRuby(what, fixturePath) {
  const probe = spawnSync("ruby", PROBE, { encoding: "utf8" });
  if (!probe.error && probe.status === 0) return "ruby";
  if (allowSkip) {
    console.log(`SKIP ${what}: no usable Ruby interpreter (--allow-skip)`);
    return null;
  }
  const why = probe.error
    ? probe.error.message
    : `ruby ${PROBE.join(" ")} exited ${probe.status}`;
  throw new Error(
    `${what} needs a working Ruby interpreter, but ${why}.\n` +
      (fixturePath
        ? `  fixture: ${path.relative(repoRoot, fixturePath)}\n`
        : "") +
      "  install Ruby (https://rubyinstaller.org/), or re-run with --allow-skip to " +
      "accept a partial local run.\n" +
      "  CI installs Ruby (ruby/setup-ruby), so this is never skipped there."
  );
}

// The caller owns `cwd`: the fixtures resolve their inputs and write their saves
// relative to the directory they are launched in, so forcing a cwd here would
// silently redirect a fixture's writes. Pass { cwd } through `options`.
export function runRubyFixture(ruby, args, label, options = {}) {
  const result = spawnSync(
    ruby,
    args,
    Object.assign({ encoding: "utf8" }, options)
  );
  if (result.error)
    throw new Error(`${label}: could not run ruby — ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(
      `${label}: ruby exited ${result.status}\n${result.stdout || ""}\n${result.stderr || ""}`
    );
  }
  const output = (result.stdout || "").trim();
  if (output) console.log(output);
  return output;
}
