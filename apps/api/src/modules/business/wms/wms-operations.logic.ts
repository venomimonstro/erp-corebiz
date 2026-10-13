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

/** Opaque keyset for one warehouse and one filter selection. It grants no
 * authorization and cannot change tenant scoping; every request is checked.
 */
export type StockPageCursor={
  warehouseId:string;name:string;sku:string;skuId:string;
  query:string;onlyProblems:boolean;
};
const uuidPattern=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
export function encodeStockCursor(position:StockPageCursor):string{
  return Buffer.from(JSON.stringify(position),"utf8").toString("base64url");
}
export function decodeStockCursor(cursor:string):StockPageCursor{
  if(cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new Error("INVALID_STOCK_CURSOR");
  try{
    const value=JSON.parse(Buffer.from(cursor,"base64url").toString("utf8"));
    if(!value||typeof value!=="object"||Array.isArray(value)||
      !uuidPattern.test(value.warehouseId)||
      !uuidPattern.test(value.skuId)||
      typeof value.name!=="string"||value.name.length>400||
      typeof value.sku!=="string"||value.sku.length>120||
      typeof value.query!=="string"||value.query.length>80||
      typeof value.onlyProblems!=="boolean")
      throw new Error("INVALID_STOCK_CURSOR");
    return {
      warehouseId:value.warehouseId,name:value.name,sku:value.sku,
      skuId:value.skuId,query:value.query,onlyProblems:value.onlyProblems
    };
  }catch{
    throw new Error("INVALID_STOCK_CURSOR");
  }
}
