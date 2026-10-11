import {BadRequestException} from "@nestjs/common";
import {OmsService} from "./oms.service";
const ctx={tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"};
describe("OMS shared stock safety",()=>{
  function harness(){
    const query=jest.fn(async(_sql:string)=>({rows:[],rowCount:0}));
    const database={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>cb({query}))};
    return {oms:new OmsService(database as any,{} as any),database,query};
  }
  it.each([-1,0.5,NaN,Infinity,10001])(
    "rejects non-integer or out-of-range sourcing priority %s",async priority=>{
      const {oms,database}=harness();
      await expect(oms.setPolicy(ctx,{
        warehouseId:"w",skuId:"s",sourcingPriority:priority
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(database.withTenantTransaction).not.toHaveBeenCalled();
    }
  );
  it("never counts unscoped client-owned WMS/3PL stock as retailer ATP",async()=>{
    let sql="";
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>cb({
      query:jest.fn(async(statement:string)=>{sql=statement;return {rows:[]};})
    }))};
    const oms=new OmsService(db as any,{} as any);
    await oms.atp(ctx);
    expect(sql).toContain("wp.owner_tracking_state IS DISTINCT FROM 'OWNER_LEDGER'");
    expect(sql).toContain("COALESCE(ip.enabled,true)=true");
    expect(sql).toContain("w.status='ACTIVE'");
  });
});
