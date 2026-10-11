import {BadRequestException,ConflictException} from "@nestjs/common";
import {assertReservableStock} from "./reservation-policy";

const baseline={
  physicalMilli:5000n,reservedMilli:1000n,requestedMilli:2000n,
  configuredSafetyMilli:1000n,enabled:true
};
describe("safe shared ATP across sales, OMS, marketplaces and WMS",()=>{
  it("allows booking while preserving the published safety buffer",()=>{
    expect(()=>assertReservableStock(baseline)).not.toThrow();
  });
  it("blocks last unit when it is explicitly reserved for safety stock",()=>{
    expect(()=>assertReservableStock({...baseline,requestedMilli:4000n}))
      .toThrow(ConflictException);
  });
  it("rejects inventory policy disabled for this warehouse/SKU",()=>{
    expect(()=>assertReservableStock({...baseline,enabled:false}))
      .toThrow(ConflictException);
  });
  it("preserves stricter policy if source OMS snapshot is stale",()=>{
    expect(()=>assertReservableStock({
      ...baseline,configuredSafetyMilli:1500n,inheritedSafetyMilli:0n,
      requestedMilli:3000n
    })).toThrow(ConflictException);
  });
  it("uses stricter inherited safety stock from OMS allocation",()=>{
    expect(()=>assertReservableStock({
      ...baseline,configuredSafetyMilli:100n,inheritedSafetyMilli:2200n,
      requestedMilli:2000n
    })).toThrow(ConflictException);
  });
  it("rejects invalid negative balance/safety, rather than manufacturing stock",()=>{
    expect(()=>assertReservableStock({...baseline,configuredSafetyMilli:-1n}))
      .toThrow(BadRequestException);
    expect(()=>assertReservableStock({...baseline,physicalMilli:-1n}))
      .toThrow(BadRequestException);
  });
});
