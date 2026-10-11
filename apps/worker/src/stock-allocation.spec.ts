import test from "node:test";
import assert from "node:assert/strict";
import {availableUnits,distributeUnits,conservativeTarget,type MarketListing} from "./stock-allocation.js";

const listing=(id:string,priority:number):MarketListing=>({
  id,priority,enabled:true,publishEnabled:true,provider:"OZON",externalWarehouseId:"1"
});

test("one physical unit cannot be independently advertised on multiple channels",()=>{
  const result=distributeUnits(1,[listing("wb",10),listing("ozon",20),listing("ym",30)]);
  assert.deepEqual([...result.values()],[1,0,0]);
});
test("allocated quantities always sum to at most physical ATP",()=>{
  for(let stock=0;stock<=10000;stock+=17){
    const quantities=distributeUnits(stock,[listing("one",10),listing("two",20),listing("three",30)]);
    assert.equal([...quantities.values()].reduce((a,b)=>a+b,0),stock);
  }
});
test("disabled or unconfigured listings never publish",()=>{
  const result=distributeUnits(3,[listing("a",1),{...listing("b",2),publishEnabled:false},
    {...listing("c",3),externalWarehouseId:null}]);
  assert.deepEqual([...result.values()],[3,0,0]);
});
test("reserve OMS, unimported orders, safety and partial units",()=>{
  assert.equal(availableUnits(5000n,1000n,2000n,1000n),1);
  assert.equal(availableUnits(1000n,0n,1000n,0n),0);
  assert.equal(availableUnits(1999n,0n,0n,0n),1);
  assert.equal(availableUnits(0n,0n,0n,0n),0);
  assert.equal(availableUnits(1000n,0n,0n,2000n),0);
});

test("two buyers on different marketplaces: do not expose stock before old listing confirms zero",()=>{
  // Warehouse: 1 item. It is still advertised on Ozon; scheduling WB must wait.
  assert.equal(conservativeTarget(1,0,1,1),0);
  // Ozon has confirmed its reduction from one to zero.
  assert.equal(conservativeTarget(1,0,0,1),1);
});
test("provider delay and 5xx: never increase the second channel while previous acknowledgement is outstanding",()=>{
  for(let physical=0;physical<=20;physical++){
    for(let already=0;already<=20;already++){
      const toNew=conservativeTarget(physical,0,already,physical);
      assert.ok(toNew>=0);
      assert.ok(toNew<=Math.max(0,physical-already));
    }
  }
});
test("network failure must not manufacture published stock on a new channel",()=>{
  assert.equal(conservativeTarget(99,null,0,100),0);
  assert.throws(()=>conservativeTarget(2,-1,0,5));
});
test("multiple warehouses: reserved and safety stock are deducted before channel distribution",()=>{
  // One warehouse with 7 physical, two already reserved, one safety:
  const atp=availableUnits(7000n,2000n,0n,1000n);
  assert.equal(atp,4);
  const q=distributeUnits(atp,[listing("Ozon",10),listing("WB",20),listing("YM",30)]);
  assert.deepEqual([...q.values()],[2,1,1]);
});
test("bad stock snapshots or quantities are rejected rather than clamped to a positive number",()=>{
  assert.throws(()=>distributeUnits(-1,[listing("WB",1)]));
  assert.throws(()=>distributeUnits(0.5,[listing("WB",1)]));
  assert.throws(()=>conservativeTarget(2,1,-1,5));
  assert.equal(availableUnits(0n,10_000n,0n,0n),0);
});
