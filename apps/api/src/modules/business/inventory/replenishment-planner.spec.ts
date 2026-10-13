import {planReplenishment} from "./replenishment-planner";
describe("purchasing forecast never confuses inbound with physical on-hand",()=>{
  it("distinguishes shortages before and after confirmed inbound",()=>{
    expect(planReplenishment({
      physicalMilli:"2000",reservedMilli:"4000",
      safetyStockMilli:"3000",confirmedInboundMilli:"2500"
    })).toMatchObject({
      availableMilli:"-2000",
      shortageBeforeInboundMilli:"5000",
      confirmedInboundMilli:"2500",
      recommendedPurchaseMilli:"2500",
      urgency:"RESERVATION_SHORTAGE"
    });
  });
  it("shows outstanding receipt without recommending duplicate procurement",()=>{
    expect(planReplenishment({
      physicalMilli:"1000",reservedMilli:"1000",
      safetyStockMilli:"3000",confirmedInboundMilli:"3500"
    })).toMatchObject({
      requiresAttention:true,
      recommendedPurchaseMilli:"0",
      urgency:"AWAITING_RECEIPT"
    });
  });
  it("does not show items that have no deficit",()=>{
    expect(planReplenishment({
      physicalMilli:"6000",reservedMilli:"2000",
      safetyStockMilli:"1000",confirmedInboundMilli:"0"
    })).toMatchObject({
      requiresAttention:false,
      recommendedPurchaseMilli:"0"
    });
  });
  it("handles quantities beyond JS safe integers without truncation",()=>{
    const a=planReplenishment({
      physicalMilli:"9007199254740993000",
      reservedMilli:"9007199254740995000",
      safetyStockMilli:"5000",
      confirmedInboundMilli:"2000"
    });
    expect(a.recommendedPurchaseMilli).toBe("5000");
    expect(a.shortageBeforeInboundMilli).toBe("7000");
  });
  it("rejects a negative inbound estimate",()=>{
    expect(()=>planReplenishment({
      physicalMilli:"0",reservedMilli:"0",
      safetyStockMilli:"0",confirmedInboundMilli:"-1"
    })).toThrow("INVALID_STOCK_PLANNING_INPUT");
  });
});
