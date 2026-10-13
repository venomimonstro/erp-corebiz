/**
 * Warehouse cockpit quantities are thousandths, never floating point.
 * Distinguish physical ATP from purchasing projection: confirmed inbound
 * is NOT a stock receipt and cannot be sold as already available.
 */
export function warehouseStockIndicators(input:{
  physicalMilli:string;
  reservedMilli:string;
  expectedMilli:string;
  safetyMilli:string;
  sourcingEnabled:boolean;
}){
  const nonNegative=(s:string,field:string)=>{
    if(!/^\d+$/.test(s))throw new Error("Invalid "+field);
    return BigInt(s);
  };
  const physical=nonNegative(input.physicalMilli,"physical");
  const reserved=nonNegative(input.reservedMilli,"reserved");
  const expected=nonNegative(input.expectedMilli,"confirmed inbound");
  const safety=nonNegative(input.safetyMilli,"safety stock");
  const available=physical-reserved;
  const projected=available+expected;
  const sellable=input.sourcingEnabled?
    (available>safety?available-safety:0n):0n;
  const recommended=projected<safety?safety-projected:0n;
  return {
    physicalMilli:physical.toString(),
    reservedMilli:reserved.toString(),
    expectedMilli:expected.toString(),
    availableNowMilli:available.toString(),
    projectedPlanningMilli:projected.toString(),
    sellableNowMilli:sellable.toString(),
    recommendedPurchaseMilli:input.sourcingEnabled?recommended.toString():"0",
    state:available<0n?"RESERVATION_SHORTAGE":
      available<safety?"BELOW_SAFETY":
      expected>0n?"INCOMING_CONFIRMED":"OK",
    stockIsPhysicalOnly:true
  };
}

export type PickRouteTask={
  taskId:string;zonePriority:number;pickSequence:number;
  priority:number;locationCode:string;skuCode:string;
  quantityMilli:string;orderId:string|null;status:string;
};

export function orderPickRoute(items:PickRouteTask[]):PickRouteTask[]{
  return [...items].sort((a,b)=>
    a.zonePriority-b.zonePriority ||
    a.pickSequence-b.pickSequence ||
    a.priority-b.priority ||
    a.locationCode.localeCompare(b.locationCode,"ru") ||
    a.taskId.localeCompare(b.taskId)
  );
}
