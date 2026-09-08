import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../runtime/bridge/src/parts/07-renamed-engine.js', import.meta.url),'utf8');
const resolveSource = readFileSync(new URL('../runtime/bridge/src/parts/10-engine.js', import.meta.url),'utf8');
const sandbox = {
  ThGem_Player: class Player {}, ThSce_Map: class MapScene {},
  ThGem_Interpreter: class Interpreter {}, ThGem_Actor: class Actor {},
  ThWin_Menu: class Menu {}, ThBtData: {},
  $thNewGmPl: null, $thNewGmPr: null,
  $thNewGmMp: null, $thNewGmAc: null, $thNewGmMe: null,
  $thNewDtAc: [null,{id:1,name:'driver'}], $thNewDtMpIf: [null,{id:1,name:'town'}],
  SceneManager: { thNewGoto(scene) { this.next = scene; }, thNewPush(scene) { this.pushed = scene; }, thNewPop() { this.popped = true; } },
  capturedEngine: () => null, capturedDataTable: () => null
};
sandbox.window = sandbox;
const context=vm.createContext(sandbox);
vm.runInContext(source+resolveSource,context);
assert.equal(sandbox.Game_Player,sandbox.ThGem_Player);
assert.equal(sandbox.Scene_Map,sandbox.ThSce_Map);
assert.equal(sandbox.Game_Interpreter,sandbox.ThGem_Interpreter);
assert.equal(sandbox.Window_Menu,sandbox.ThWin_Menu);
assert.equal(sandbox.BattleManager,sandbox.ThBtData);
sandbox.SceneManager.goto(sandbox.Scene_Map);
assert.equal(sandbox.SceneManager.next,sandbox.ThSce_Map,'scene transitions preserve manager receiver');
sandbox.SceneManager.push(sandbox.Scene_Map);
assert.equal(sandbox.SceneManager.pushed,sandbox.ThSce_Map);
sandbox.SceneManager.pop();
assert.equal(sandbox.SceneManager.popped,true);
assert.equal(vm.runInContext('resolvePlayer()',context),null);
const first={gold:1}, second={gold:2};
sandbox.$thNewGmPr=first;
assert.equal(vm.runInContext('resolveParty()',context),first);
sandbox.$thNewGmPr=second;
assert.equal(vm.runInContext('resolveParty()',context),second,'load/new-game must replace the live reference');
sandbox.$gameParty=first;
assert.equal(sandbox.$thNewGmPr,first,'write-through preserves game globals');
assert.equal(vm.runInContext('resolveData("actor")',context),sandbox.$thNewDtAc);
assert.equal(vm.runInContext('resolveData("mapInfo")',context),sandbox.$thNewDtMpIf);
assert.equal(vm.runInContext('resolveSceneMap()',context),sandbox.ThSce_Map);
const descriptor=Object.getOwnPropertyDescriptor(sandbox,'$gameParty');
vm.runInContext(source,context);
assert.equal(Object.getOwnPropertyDescriptor(sandbox,'$gameParty').get,descriptor.get,'publishing is idempotent');
const foreign={ThGem_Player:class {},ThSce_Map:class {},$thNewGmPl:null,$thNewGmPr:null,$gameParty:first};
foreign.window=foreign;
vm.runInNewContext(source,foreign);
assert.equal(foreign.$gameParty,first,'native globals are never overwritten');
const unrelated={ThGem_Player:class {}};
unrelated.window=unrelated;
vm.runInNewContext(source,unrelated);
assert.equal(unrelated.Game_Player,undefined,'one matching constructor is not a family signature');
const storm={Game_Player:class {},Scene_Map:class {},$ftGmPl:null,$ftGmPr:first,
  $ftGmAc:{},$ftGmSw:{},$ftGmVr:{},$newTkIt:[null,{id:1,name:'capsule'}],
  $newTkAc:[], $newTkCs:[], $thTkSk:[], $thTkWp:[], $thTkAr:[],
  $newTkEn:[], $thTkTr:[], $thTkSt:[], $thTkCom:[],
  $gameMap:{native:true}, capturedEngine:()=>null,capturedDataTable:()=>null};
storm.window=storm;
const stormContext=vm.createContext(storm);
vm.runInContext(source+resolveSource,stormContext);
assert.equal(vm.runInContext('resolveParty()',stormContext),first,'FT family publishes its real party');
assert.equal(storm.$dataItems,storm.$newTkIt);
assert.equal(storm.$dataCommonEvents,storm.$thTkCom);
storm.$ftGmPr=second;
assert.equal(storm.$gameParty,second);
storm.$gameParty=first;
assert.equal(storm.$ftGmPr,first);
assert.equal(storm.$gameMap.native,true);
console.log('renamed engine PASS: family gate, native-global preservation, constructors, resolvers and live save replacement');
