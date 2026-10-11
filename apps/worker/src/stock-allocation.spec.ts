import test from "node:test";
import assert from "node:assert/strict";
import {availableUnits,distributeUnits,type MarketListing} from "./stock-allocation.js";

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
