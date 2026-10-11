import {BadRequestException} from "@nestjs/common";
import {OmsService} from "./oms.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const warehouseId="44444444-4444-4444-8444-444444444444";
const skuId="55555555-5555-4555-8555-555555555555";

describe("OMS: preserving commercial stock policies",()=>{
  function harness(){
    const client={query:jest.fn(async(sql:string,_params:unknown[])=>({
      rows:[],rowCount:1
    }))};
    const service=Object.create(OmsService.prototype) as any;
    service.database={withTenantTransaction:jest.fn(async(_ctx:unknown,run:any)=>run(client))};
    return {service,client};
  }
  it("updating only safety stock never re-enables manually suspended sourcing",async()=>{
    const {service,client}=harness();
    await service.setPolicy(context,{
      warehouseId,skuId,safetyStockMilli:"5000"
    });
    const write=client.query.mock.calls.find(([sql]:[string])=>
      sql.includes("INSERT INTO inventory_policy"));
    expect(write).toBeDefined();
    expect(write[0]).toContain("ELSE inventory_policy.enabled");
    expect(write[0]).toContain("ELSE inventory_policy.sourcing_priority");
    expect(write[1].slice(-3)).toEqual([true,false,false]);
  });
  it("an explicit disabled state does not overwrite the protected safety quantity",async()=>{
    const {service,client}=harness();
    await service.setPolicy(context,{warehouseId,skuId,enabled:false});
    const write=client.query.mock.calls.find(([sql]:[string])=>
      sql.includes("INSERT INTO inventory_policy"));
    expect(write[1].slice(-3)).toEqual([false,false,true]);
    expect(write[1][5]).toBe(false);
  });
  it("rejects non-boolean availability and invalid negative safety",async()=>{
    const {service,client}=harness();
    await expect(service.setPolicy(context,{
      warehouseId,skuId,enabled:"false" as any
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.setPolicy(context,{
      warehouseId,skuId,safetyStockMilli:"-100"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(client.query).not.toHaveBeenCalled();
  });
});
