import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const tables={item:[null,{id:1,kind:'item',itypeId:1,name:'药',meta:{}}],weapon:[null,{id:1,kind:'weapon',wtypeId:1,name:'枪',meta:{}}],armor:[null,{id:1,kind:'armor',atypeId:1,name:'衣',meta:{}}]};
const actor={_newItemList:[],actorId:()=>1},pilot={_newItemList:['I1'],actorId:()=>2};
const party={_tkCkItem:['I1'],_cxJsId:{1:2},members:()=>[actor,pilot,actor],thTyZhNumGain(){},thTyZhNumGet(){},
  newGetItem(data){
    const owner=actor._newItemList.length<3?actor._newItemList:party._tkCkItem;
    if(owner===party._tkCkItem&&owner.length>=4)return;
    let value=data;
    if(data.kind!=='item'){value={...data,id:tables[data.kind].length,baseItemId:data.id};tables[data.kind].push(value);}
    owner.push(({item:'I',weapon:'W',armor:'A'})[data.kind]+value.id);
  },
  gainItem(data,delta,includeEquip,owner){const token=({item:'I',weapon:'W',armor:'A'})[data.kind]+data.id;const index=owner._newItemList.indexOf(token);if(index>=0)owner._newItemList.splice(index,1);if(data.baseItemId)tables[data.kind][data.id]=null;}
};
const window={DataManager:{isItem:x=>tables.item.includes(x),isWeapon:x=>tables.weapon.includes(x),isArmor:x=>tables.armor.includes(x)},$gameActors:{actor:id=>id===2?pilot:actor}};
const context={window,runtimeDataTable:kind=>tables[kind]};
vm.runInNewContext(fs.readFileSync('runtime/bridge/src/parts/31-th-inventory.js','utf8'),context);
const adapter=context.resolveCustomInventory(party),item=tables.item[1];
assert.equal(adapter.count(item),2); // pilot appears directly and through a vehicle; count once
assert.equal(adapter.entries()[0].count,2);
assert.equal(adapter.change(item,2),4);
assert.equal(adapter.change(item,-3),1);
assert.equal(adapter.count(item),1);
assert.throws(()=>adapter.change(item,1001),/1000/);
assert.throws(()=>adapter.change(item,20),/当前数量/);
assert.equal(adapter.count(item),7); // capacity reached; explicit partial-success error
adapter.change(item,-7);
assert.equal(adapter.count(item),0);
const weapon=tables.weapon[1];
assert.equal(adapter.change(weapon,1),1);
const instance=tables.weapon[2];
assert.equal(adapter.entries()[0].id,2);
assert.throws(()=>adapter.change(weapon,-1),/具体实例/);
assert.throws(()=>adapter.change(instance,1),/基础装备/);
assert.equal(adapter.change(instance,-1),0);
assert.equal(adapter.count(weapon),0);
assert.throws(()=>adapter.change({...item,meta:{tkPaoDang:true}},1),/独立弹仓/);
assert.throws(()=>adapter.validateLock(weapon,1),/独立装备/);
assert.throws(()=>adapter.validateLock(item,1001),/1000/);
assert.equal(context.resolveCustomInventory({}),null);
console.log('PASS TH inventory owners, warehouse, native mutation, capacity, partial progress, instance protection');

// Native YEP variants use string instance IDs and report zero for a base item.
const independent = { _items: {}, _weapons: {}, _armors: {}, owned: [],
  items(){return [];}, weapons(){return this.owned;}, armors(){return [];},
  gainIndependentItem(){}, numItems(data){return this._weapons[data.id] || 0;},
  gainItem(data, amount){
    if(amount>0) for(let n=0;n<amount;n++){const row={...data,id:'I'+(++this.serial),baseItemId:data.id};this.owned.push(row);this._weapons[row.id]=1;}
    else {this.owned=this.owned.filter(row=>row!==data);delete this._weapons[data.id];}
  },serial:100
};
window.DataManager.isIndependent = data => data.kind === 'weapon';
const nativeAdapter=context.resolveCustomInventory(independent);
assert.ok(nativeAdapter, 'independent native inventory must be recognized');
assert.equal(nativeAdapter.change(weapon,2),2);
assert.equal(independent._weapons[weapon.id],undefined,'never fabricate numeric base stock');
const nativeRows=nativeAdapter.entries();
assert.equal(nativeRows[0].id,'I101');
assert.equal(nativeRows[0].baseItemId,1);
assert.equal(nativeAdapter.change(weapon,-1),1,'base aggregate removal must delete one native instance');
assert.doesNotThrow(()=>nativeAdapter.validateLock(weapon,1));
assert.throws(()=>nativeAdapter.validateLock(independent.owned[0],2),/0 或 1/);
assert.throws(()=>nativeAdapter.change(independent.owned[0],1),/基础装备/);
assert.equal(nativeAdapter.change(independent.owned[0],-1),0);
assert.equal(nativeAdapter.count(weapon),0);
console.log('PASS native independent string IDs, aggregate base count and precise removal');

// Encoded TH_ItemCore builds gate gainItem behind _GITHGT. The adapter must
// open the gate only for the call and restore the original value afterwards.
const encodedItems = [null, {id: 1, itypeId: 1, name: '丹', meta: {}}];
const encoded = {
  _items: {}, _weapons: {}, _armors: {}, _equipBaseRmPr: [], _GITHGT: false,
  items(){ return Object.keys(this._items).filter(id => this._items[id]).map(id => encodedItems[Number(id)]); },
  weapons(){ return []; }, armors(){ return []; },
  numItems(data){ return this.thTyZhNumGet(this._items[data.id]); },
  newNumItems(){ return 0; }, thTyGetOnOver(){ return 0; },
  thTyZhNumGain(value){ return value == null ? value : `e${value}`; },
  thTyZhNumGet(value){ return value == null ? 0 : Number(String(value).slice(1)) || 0; },
  gainItem(data, amount){ if (!this._GITHGT) return; const next = this.numItems(data) + amount; if (next > 0) this._items[data.id] = this.thTyZhNumGain(next); else delete this._items[data.id]; }
};
const encodedAdapter = context.resolveCustomInventory(encoded);
assert.ok(encodedAdapter, 'encoded gated inventory must be recognized');
assert.equal(encodedAdapter.change(encodedItems[1], 3), 3);
assert.equal(encoded._GITHGT, false, 'gate value must be restored');
assert.equal(encodedAdapter.entries()[0].count, 3);
assert.equal(encodedAdapter.change(encodedItems[1], -2), 1);
assert.equal(encoded._GITHGT, false, 'gate value must remain restored after removal');
console.log('PASS encoded inventory gate, encoded count and restore');
