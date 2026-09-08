import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'app/gui/src/host.ts'), 'utf8');
const output = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
const context = {exports: {}, window: {}};
vm.runInNewContext(output, context, {filename: 'host-boundary.js'});
const {getGuiHost} = context.exports;
assert.throws(() => getGuiHost(), /原生宿主不可用/);
assert.throws(() => getGuiHost(() => null), /宿主未正确加载/);
assert.throws(() => getGuiHost(() => ({})), /缺少接口：init/);
// Loading the real CJS interface is harmless: init/launch/attach are never called.
const host = createRequire(import.meta.url)(path.join(root, 'app/gui/host.cjs'));
let loads = 0;
assert.equal(getGuiHost(id => { loads++; assert.equal(id, './host.cjs'); return host; }), host);
assert.equal(loads, 1);
const broken = {...host, attach: undefined};
assert.throws(() => getGuiHost(() => broken), /缺少接口：attach/);
// Every method in the TypeScript contract must actually exist on the host.
const ast = ts.createSourceFile('host.ts', source, ts.ScriptTarget.Latest, true);
const contract = ast.statements.find(n => ts.isInterfaceDeclaration(n) && n.name.text === 'GuiHost');
for (const member of contract.members) assert.equal(typeof host[member.name.getText(ast)], 'function', member.name.getText(ast));
console.log('GUI host boundary PASS: clear startup errors, real CJS method contract, no native action during loading');
