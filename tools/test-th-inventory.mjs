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
