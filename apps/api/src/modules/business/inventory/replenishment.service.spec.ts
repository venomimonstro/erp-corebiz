import {InventoryService} from "./inventory.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const base={
  warehouseId:"44444444-4444-4444-8444-444444444444",
  warehouseName:"Москва, склад",
  skuId:"55555555-5555-4555-8555-555555555555",
  sku:"SHAMPOO-01",productName:"Шампунь",
  physicalMilli:"9000",reservedMilli:"6000",
  availableMilli:"3000",sellableMilli:"1000",
  safetyStockMilli:"2000",sourcingEnabled:true
};
function subject(rows:Array<typeof base>){
  const service=Object.create(InventoryService.prototype) as InventoryService;
  const balances=jest.fn().mockResolvedValue(rows);
  (service as any).balances=balances;
  return {service,balances};
}
describe("MoySklad-style stock replenishment recommendations",()=>{
  it("does not create purchase orders and avoids false shortages",async()=>{
    const {service,balances}=subject([base]);
    expect(await service.replenishment(ctx)).toEqual([]);
    expect(balances).toHaveBeenCalledWith(ctx);
  });
  it("prioritizes unfulfilled reservations",async()=>{
    const row={...base,physicalMilli:"3000",reservedMilli:"5000",
      availableMilli:"-2000",sellableMilli:"0",safetyStockMilli:"2000"};
    const {service}=subject([row]);
    expect(await service.replenishment(ctx)).toEqual([expect.objectContaining({
      recommendedPurchaseMilli:"4000",
      urgency:"RESERVATION_SHORTAGE",
      purchaseOrderCreated:false
    })]);
  });
  it("warns when available stock drops below safety stock",async()=>{
    const row={...base,physicalMilli:"7000",reservedMilli:"6000",
      availableMilli:"1000",sellableMilli:"0",safetyStockMilli:"2500"};
    const {service}=subject([row]);
    expect(await service.replenishment(ctx)).toEqual([expect.objectContaining({
      recommendedPurchaseMilli:"1500",urgency:"BELOW_SAFETY_STOCK"
    })]);
  });
  it("does not suggest ordering for disabled sourcing policies",async()=>{
    const row={...base,physicalMilli:"0",reservedMilli:"10000",
      availableMilli:"-10000",sourcingEnabled:false};
    expect(await subject([row]).service.replenishment(ctx)).toEqual([]);
  });
  it("keeps exact quantities even above Number.MAX_SAFE_INTEGER",async()=>{
    const row={...base,physicalMilli:"9007199254740993",
      reservedMilli:"9007199254740995",
      availableMilli:"-2",safetyStockMilli:"1000"};
    expect((await subject([row]).service.replenishment(ctx))[0])
      .toMatchObject({recommendedPurchaseMilli:"1002"});
  });
  it("never suggests a negative order and sorts hard shortages first",async()=>{
    const safety={...base,skuId:"66666666-6666-4666-8666-666666666666",
      sku:"A",physicalMilli:"5",reservedMilli:"2",safetyStockMilli:"5",
      availableMilli:"3"};
    const shortage={...base,skuId:"77777777-7777-4777-8777-777777777777",
      sku:"Z",physicalMilli:"1",reservedMilli:"3",safetyStockMilli:"0",
      availableMilli:"-2"};
    const all=await subject([safety,shortage,base]).service.replenishment(ctx);
    expect(all.map(x=>x.urgency))
      .toEqual(["RESERVATION_SHORTAGE","BELOW_SAFETY_STOCK"]);
    expect(all.map(x=>x.recommendedPurchaseMilli)).toEqual(["2","2"]);
  });
});
