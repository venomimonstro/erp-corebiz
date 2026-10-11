/**
 * Conservative partitioning of one shared FBS warehouse pool.
 * Never publish the same last unit on two independent marketplaces.
 */
export type MarketListing={
  id:string;priority:number;enabled:boolean;publishEnabled:boolean;
  externalWarehouseId:string|null;provider:string;
};
export function distributeUnits(atpUnits:number,listings:MarketListing[]):Map<string,number>{
  if(!Number.isSafeInteger(atpUnits)||atpUnits<0)throw new Error("INVALID_ATP");
  const result=new Map(listings.map(l=>[l.id,0]));
  const eligible=listings.filter(l=>l.enabled&&l.publishEnabled&&
    l.externalWarehouseId!==null&&
    ["OZON","WILDBERRIES","YANDEX_MARKET"].includes(l.provider))
    .sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
  if(!eligible.length)return result;
  // Reserve scarce stock for one listing at a time, then share further units.
  for(let i=0;i<atpUnits;i++){
    const listing=eligible[i%eligible.length]!;
    result.set(listing.id,(result.get(listing.id)??0)+1);
  }
  return result;
}
export function availableUnits(
  physicalMilli:bigint,reservedMilli:bigint,unimportedDemandMilli:bigint,safetyMilli:bigint
):number{
  const available=physicalMilli-reservedMilli-unimportedDemandMilli-safetyMilli;
  if(available<=0n)return 0;
  // Integer units only; do not make fractional physical inventory sellable.
  const units=available/1000n;
  if(units>BigInt(Number.MAX_SAFE_INTEGER))throw new Error("ATP_OVERFLOW");
  return Number(units);
}
