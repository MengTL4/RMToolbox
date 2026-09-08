// Release entry point: npm ci, then npm run build. No game runtime donor needed.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBridge } from '../core/bridge-bundler.mjs';
import { buildGuiBundle } from '../core/gui-bundler.mjs';
import { buildFrontend } from './gui-frontend.mjs';
import { verifyReleaseArchive } from './verify-release.mjs';
import { assertBuildPath, setupGuiRuntime, readRuntimeLock, fileSha256 } from '../core/setup-gui-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(pkg.version)) throw new Error('Invalid release version');
const staging = assertBuildPath(root, path.join(root, 'output/release/RMToolbox'));
const destZip = assertBuildPath(root, path.join(root, `output/RMToolbox-v${pkg.version}-win-x64.zip`));
const tempZip = assertBuildPath(root, destZip.replace(/\.zip$/, '.building.zip'));
const run = (...args) => execFileSync(process.execPath, args, {cwd: root, stdio: 'inherit', windowsHide: true});
const psString = value => "'" + value.replaceAll("'", "''") + "'";

run('node_modules/vue-tsc/bin/vue-tsc.js', '--noEmit');
buildGuiBundle(root);
buildBridge(root);
await buildFrontend(root);
run('tools/test-gui-runtime-setup.mjs');
run('tools/test-gui-host-boundary.mjs');
run('tools/test-ui-interactions.mjs');
run('tools/gui-check.mjs');

// Whitelist GUI application assets: never copy local Chromium profiles, donor
// junctions or unknown runtime leftovers from the developer's app/gui folder.
fs.rmSync(staging, {recursive: true, force: true});
fs.mkdirSync(path.join(staging, 'app/gui'), {recursive: true});
const guiEntries = ['package.json', 'index.html', 'host.cjs', 'gui-bundle.cjs', 'ui', 'vendor', 'styles.css', 'jsoneditor-theme.css', 'icon.png'];
for (const name of guiEntries) fs.cpSync(path.join(root, 'app/gui', name), path.join(staging, 'app/gui', name), {recursive: true});
const exclude = new Set(['runtime/inject/bin/obj', 'runtime/inject/bin/win32/test', 'runtime/inject/bin/x64/test']);
for (const name of ['core', 'runtime/bridge', 'runtime/rgss-bridge', 'runtime/inject/bin', 'tools', 'docs/screenshots']) {
  fs.cpSync(path.join(root, name), path.join(staging, name), {recursive: true,
    filter: source => !exclude.has(path.relative(root, source).split(path.sep).join('/'))});
}
for (const name of ['README.md', 'LICENSE', 'package.json', 'nw-runtime.lock.json', 'package-lock.json',
  'docs/NEW-GAMES-ADAPTATION.md', 'docs/HOMECOMING-0133-ACCEPTANCE.md', 'docs/STORM-ADAPTATION.md']) fs.copyFileSync(path.join(root, name), path.join(staging, name));
// Always install from the checksum-verified official archive into a clean stage.
await setupGuiRuntime({projectRoot: root, guiDir: path.join(staging, 'app/gui'), force: true});
const guiPackagePath = path.join(staging, 'app/gui/package.json');
const guiPackage = JSON.parse(fs.readFileSync(guiPackagePath, 'utf8'));
guiPackage.version = pkg.version;
fs.writeFileSync(guiPackagePath, JSON.stringify(guiPackage, null, 2) + '\n');
for (const arch of ['win32', 'x64']) for (const name of ['rmch-inject.exe', 'rmch-mvhook.dll', 'rmch-rgsshook.dll']) {
  if (!fs.statSync(path.join(staging, 'runtime/inject/bin', arch, name)).size) throw new Error('Empty injector: ' + name);
}
fs.writeFileSync(path.join(staging, 'RMToolbox.cmd'), '@echo off\r\nstart "" "%~dp0app\\gui\\RMToolbox.exe" %*\r\n', 'ascii');
run('tools/test-gui-runtime.mjs', path.join(staging, 'app/gui'), path.join(staging, 'app/gui'));
const lock = readRuntimeLock(root);
fs.writeFileSync(path.join(staging, 'build-info.json'), JSON.stringify({
  version: pkg.version, platform: lock.platform, runtime: lock,
  dependencyLockSha256: fileSha256(path.join(root, 'package-lock.json')),
  generated: Object.fromEntries(['app/gui/gui-bundle.cjs', 'app/gui/ui/modern.js', 'runtime/bridge/page-bridge.js'].map(file => [file, fileSha256(path.join(staging, file))]))
}, null, 2) + '\n');

// Keep the previous good ZIP until the replacement has been fully written.
fs.rmSync(tempZip, {force: true});
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
  `$ErrorActionPreference='Stop'; Compress-Archive -LiteralPath ${psString(staging)} -DestinationPath ${psString(tempZip)} -CompressionLevel Optimal`], {stdio: 'inherit', windowsHide: true});
verifyReleaseArchive(tempZip, staging);
fs.rmSync(destZip, {force: true});
fs.renameSync(tempZip, destZip);
fs.writeFileSync(destZip + '.sha256', `${fileSha256(destZip)}  ${path.basename(destZip)}\n`);
console.log(`release zip: ${destZip} (${(fs.statSync(destZip).size / 1024 / 1024).toFixed(1)} MB)`);
