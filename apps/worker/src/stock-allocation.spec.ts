import {availableUnits,distributeUnits,type MarketListing} from "./stock-allocation";
const list=(id:string,priority:number):MarketListing=>({
  id,priority,enabled:true,publishEnabled:true,provider:"OZON",externalWarehouseId:"1"
});
describe("single stock, multiple marketplaces",()=>{
  it("never duplicates the last physical unit across channels",()=>{
    const q=distributeUnits(1,[list("wb",10),list("ozon",20),list("ym",30)]);
    expect([...q.values()]).toEqual([1,0,0]);
  });
  it("sum of all published quantities never exceeds available stock",()=>{
    for(let stock=0;stock<=100;stock++){
      const q=distributeUnits(stock,[list("one",10),list("two",20),list("three",30)]);
      expect([...q.values()].reduce((a,b)=>a+b,0)).toBe(stock);
    }
  });
  it("does not publish to disabled or unconfigured listings",()=>{
    const q=distributeUnits(3,[list("a",1),{...list("b",2),publishEnabled:false},
      {...list("c",3),externalWarehouseId:null}]);
    expect([...q.values()]).toEqual([3,0,0]);
  });
  it("subtracts OMS reserves, marketplace inbox demand and safety stock",()=>{
    expect(availableUnits(5000n,1000n,2000n,1000n)).toBe(1);
    expect(availableUnits(1000n,0n,1000n,0n)).toBe(0);
    expect(availableUnits(1999n,0n,0n,0n)).toBe(1);
    expect(availableUnits(0n,0n,0n,0n)).toBe(0);
  });
});
