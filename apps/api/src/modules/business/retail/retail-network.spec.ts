import {BadRequestException,ConflictException,NotFoundException} from "@nestjs/common";
import {RetailNetworkService} from "./retail-network.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const location="44444444-4444-4444-8444-444444444444";
const warehouse="55555555-5555-4555-8555-555555555555";
const sku="66666666-6666-4666-8666-666666666666";
const orderId="77777777-7777-4777-8777-777777777777";

describe("omnichannel retail stock and order safety",()=>{
  const order={
    locationId:location,channel:"CLICK_COLLECT" as const,
    idempotencyKey:"saledoc_123456789",
    lines:[{skuId:sku,quantityMilli:"1000"}]
  };
  function setup(opts:{pickup?:boolean;orderStatus?:string;orderWarehouse?:string|null}={}){
    const queries:string[]=[];
    const query=jest.fn(async(sql:string,args?:unknown[])=>{
      queries.push(sql);
      if(sql.includes("FROM retail_location l JOIN warehouse"))return {
        rows:[{id:location,warehouse_id:warehouse,
          pickup_enabled:opts.pickup??true}],rowCount:1
      };
      if(sql.includes("SELECT order_status,version,warehouse_id FROM sales_order"))
        return {rows:[{order_status:opts.orderStatus??"DRAFT",version:1,
          warehouse_id:opts.orderWarehouse??null}],rowCount:1};
      if(sql.includes("FROM retail_order_link")&&sql.includes("FOR UPDATE"))
        return {rows:[],rowCount:0};
      return {rows:[],rowCount:1};
    });
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,callback:any)=>
      callback({query}))};
    const auth={resolveScope:jest.fn().mockResolvedValue("all"),
      membershipIdsForScope:jest.fn().mockResolvedValue(null)};
    const sales={
      create:jest.fn().mockResolvedValue({id:orderId,number:"ORD-001",version:1}),
      confirm:jest.fn().mockResolvedValue({version:2}),
      reserve:jest.fn().mockResolvedValue({fulfillmentStatus:"RESERVED"})
    };
    return {service:new RetailNetworkService(db as any,auth as any,sales as any),
      sales,queries};
  }
  it("rejects invalid quantity without starting an order",async()=>{
    const t=setup();
    await expect(t.service.reserve(ctx,{
      ...order,lines:[{skuId:sku,quantityMilli:"-1"}]
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.sales.create).not.toHaveBeenCalled();
  });
  it("fails closed if the selected store does not offer pickup",async()=>{
    const t=setup({pickup:false});
    await expect(t.service.reserve(ctx,order))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.sales.create).not.toHaveBeenCalled();
  });
  it("reserves from the actual branch warehouse, not a company-default store",async()=>{
    const t=setup();
    const result=await t.service.reserve(ctx,order);
    expect(result.status).toBe("RESERVED_AWAITING_PAYMENT");
    expect(t.sales.create).toHaveBeenCalledWith(ctx,
      expect.objectContaining({
        currency:"RUB",idempotencyKey:"retail:"+location+":"+order.idempotencyKey
      }));
    expect(t.sales.confirm).toHaveBeenCalledWith(ctx,orderId,1);
    expect(t.sales.reserve).toHaveBeenCalledWith(ctx,orderId,
      "retail-reserve:"+orderId,warehouse);
    expect(t.queries.some(q=>q.includes("INSERT INTO retail_order_link"))).toBe(true);
  });
  it("rejects an existing order assigned to another warehouse",async()=>{
    const t=setup({orderWarehouse:"88888888-8888-4888-8888-888888888888"});
    await expect(t.service.reserve(ctx,order))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.sales.reserve).not.toHaveBeenCalled();
  });
  it("retries an already confirmed order without confirming it twice",async()=>{
    const t=setup({orderStatus:"CONFIRMED",orderWarehouse:warehouse});
    await t.service.reserve(ctx,order);
    expect(t.sales.confirm).not.toHaveBeenCalled();
    expect(t.sales.reserve).toHaveBeenCalledTimes(1);
  });
});
