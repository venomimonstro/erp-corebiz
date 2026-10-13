import {BadRequestException,ForbiddenException,NotFoundException} from "@nestjs/common";
import {CommerceDecisionsService} from "./commerce-decisions.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const sku="44444444-4444-4444-8444-444444444444";
const valid={leadDays:21,reviewDays:7,minimumBatchMilli:"5000",enabled:true};

function setup(permission:string|null="all",found=true){
  const calls:Array<{sql:string;args:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,args:unknown[])=>{
    calls.push({sql,args});
    if(sql.includes("FROM sku s JOIN product_variant"))
      return {rows:found?[{id:sku}]:[],rowCount:found?1:0};
    if(sql.includes("INSERT INTO procurement_reorder_rule"))
      return {rows:[{sku_id:sku,lead_days:21,review_days:7,
        minimum_batch_milli:"5000",enabled:true}],rowCount:1};
    if(sql.includes("FROM procurement_reorder_rule r"))
      return {rows:[{sku_id:sku,lead_days:21,review_days:7,
        minimum_batch_milli:"5000",enabled:true}],rowCount:1};
    throw Error("Unexpected SQL "+sql.slice(0,80));
  })};
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>cb(client))};
  const auth={resolveScope:jest.fn().mockResolvedValue(permission)};
  return {instance:new CommerceDecisionsService(db as any,auth as any),db,auth,calls};
}

describe("MoySklad-inspired purchasing review rules (no automatic POs)",()=>{
  it("requires all-scope procurement.write before any SQL",async()=>{
    const f=setup("own");
    await expect(f.instance.updateRule(context,sku,valid))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it.each([
    {...valid,leadDays:0},{...valid,leadDays:181},
    {...valid,leadDays:7.5},{...valid,reviewDays:0},
    {...valid,reviewDays:91},{...valid,minimumBatchMilli:"-10"},
    {...valid,minimumBatchMilli:"2.50"},
    {...valid,minimumBatchMilli:"010"},
    {...valid,enabled:"true" as any}
  ])("rejects invalid rule input before modifying database: %p",async bad=>{
    const f=setup();
    await expect(f.instance.updateRule(context,sku,bad))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("rejects wrong SKU and tenant-isolated non-inventory product",async()=>{
    const f=setup();
    await expect(f.instance.updateRule(context,"invalid",valid))
      .rejects.toBeInstanceOf(BadRequestException);
    const g=setup("all",false);
    await expect(g.instance.updateRule(context,sku,valid))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(g.calls[0]?.args).toEqual([context.tenantId,sku]);
  });
  it("saves a tenant-scoped lead/review policy; does not create orders",async()=>{
    const f=setup();
    const result=await f.instance.updateRule(context,sku,valid);
    expect(result).toMatchObject({sku_id:sku,lead_days:21,review_days:7});
    const mutation=f.calls.find(x=>x.sql.includes("INSERT INTO procurement_reorder_rule"));
    expect(mutation?.args).toEqual([
      context.tenantId,sku,21,7,"5000",true,context.membershipId
    ]);
    expect(f.calls.every(x=>!/(?:INSERT|UPDATE)\s+(?:purchase_order|inventory_balance)/i
      .test(x.sql))).toBe(true);
  });
  it("read policies require procurement read rights",async()=>{
    const f=setup(null);
    await expect(f.instance.rules(context))
      .rejects.toBeInstanceOf(ForbiddenException);
    const good=setup();
    const rows=await good.instance.rules(context);
    expect(rows[0]).toMatchObject({sku_id:sku,lead_days:21});
    expect(good.calls[0]?.args).toEqual([context.tenantId]);
  });
});
