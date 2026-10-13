/** A purchasing recommendation is not a goods receipt.
 * Monetary or inventory fields remain decimal INTEGER strings to avoid
 * precision loss when data exceeds JS Number.MAX_SAFE_INTEGER.
 */
export type ReplenishmentInput={
  physicalMilli:string;
  reservedMilli:string;
  safetyStockMilli:string;
  confirmedInboundMilli:string;
};
export type ReplenishmentUrgency=
  "RESERVATION_SHORTAGE"|"BELOW_SAFETY_STOCK"|"AWAITING_RECEIPT";
export function planReplenishment(input:ReplenishmentInput){
  const physical=BigInt(input.physicalMilli);
  const reserved=BigInt(input.reservedMilli);
  const safety=BigInt(input.safetyStockMilli);
  const inbound=BigInt(input.confirmedInboundMilli);
  if(reserved<0n||safety<0n||inbound<0n)
    throw new Error("INVALID_STOCK_PLANNING_INPUT");
  const available=physical-reserved;
  const shortage=reserved+safety>physical
    ?reserved+safety-physical:0n;
  const toBuy=shortage>inbound?shortage-inbound:0n;
  const urgency:ReplenishmentUrgency=
    available<0n?"RESERVATION_SHORTAGE":
    toBuy>0n?"BELOW_SAFETY_STOCK":"AWAITING_RECEIPT";
  return {
    availableMilli:available.toString(),
    shortageBeforeInboundMilli:shortage.toString(),
    confirmedInboundMilli:inbound.toString(),
    recommendedPurchaseMilli:toBuy.toString(),
    requiresAttention:shortage>0n,
    urgency
  };
}
