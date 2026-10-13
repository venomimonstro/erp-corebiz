import {InventoryService} from "./inventory.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const warehouse="44444444-4444-4444-8444-444444444444";
const skuId="55555555-5555-4555-8555-555555555555";
const item={
  warehouseId:warehouse,warehouseName:"Москва — склад 1",
  skuId,sku:"TEST-1",productName:"Тестовая позиция",
  physicalMilli:"3000",reservedMilli:"4000",
  safetyStockMilli:"2000",sourcingEnabled:true
};
function mockInbound(rows:Array<{
  sku_id:string;warehouse_id:string|null;inbound_milli:string
}>){
  const query=jest.fn().mockResolvedValue({rows});
  const db={
    withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>
      fn({query}))
  };
  const source=Object.create(InventoryService.prototype) as any;
  source.database=db;
  source.balances=jest.fn().mockResolvedValue([item]);
  return {service:source as InventoryService,query};
}
describe("purchase replenishment: physical/reserved/inbound are distinct",()=>{
  it("suggests shortage before procurement when there is no confirmed supply",async()=>{
    const {service}=mockInbound([]);
    const [recommendation]=await service.replenishment(ctx);
    expect(recommendation).toMatchObject({
      physicalMilli:"3000",reservedMilli:"4000",
      safetyStockMilli:"2000",availableMilli:"-1000",
      grossShortageMilli:"3000",confirmedInboundMilli:"0",
      recommendedPurchaseMilli:"3000",urgency:"RESERVATION_SHORTAGE"
    });
  });
  it("subtracts only the unreceived quantity assigned to exactly one branch warehouse",async()=>{
    const {service,query}=mockInbound([
      {sku_id:skuId,warehouse_id:warehouse,inbound_milli:"1500"}
    ]);
    const [row]=await service.replenishment(ctx);
    expect(row.confirmedInboundMilli).toBe("1500");
    expect(row.recommendedPurchaseMilli).toBe("1500");
    const sql=query.mock.calls[0][0] as string;
    expect(sql).toContain("HAVING count(*)=1");
    expect(sql).toContain("po.status IN ('CONFIRMED','PARTIALLY_RECEIVED')");
    expect(sql).toContain("ordered_quantity_milli-");
    expect(sql).toContain("received_quantity_milli");
  });
  it("never silently allocates supply with no unambiguous warehouse",async()=>{
    const {service}=mockInbound([
      {sku_id:skuId,warehouse_id:null,inbound_milli:"2800"}
    ]);
    const [row]=await service.replenishment(ctx);
    expect(row.unallocatedInboundMilli).toBe("2800");
    expect(row.confirmedInboundMilli).toBe("0");
    expect(row.recommendedPurchaseMilli).toBe("3000");
  });
  it("does not create duplicate purchase if firm inbound fully covers shortfall",async()=>{
    const {service}=mockInbound([
      {sku_id:skuId,warehouse_id:warehouse,inbound_milli:"4000"}
    ]);
    const [row]=await service.replenishment(ctx);
    expect(row.recommendedPurchaseMilli).toBe("0");
    // A confirmed delivery prevents duplicate buying, but reservations
    // still exceed physical stock until goods are actually received.
    expect(row.urgency).toBe("RESERVATION_SHORTAGE");
    expect(row.purchaseOrderCreated).toBe(false);
  });
  it("does not offer purchases for discontinued/sourcing disabled stock",async()=>{
    const data=mockInbound([]);
    (data.service as any).balances=jest.fn().mockResolvedValue([
      {...item,sourcingEnabled:false}
    ]);
    expect(await data.service.replenishment(ctx)).toEqual([]);
  });
});
