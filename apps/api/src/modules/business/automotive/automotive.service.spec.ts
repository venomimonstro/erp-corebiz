import {BadRequestException} from "@nestjs/common";
import {AutomotiveService} from "./automotive.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const id="44444444-4444-4444-8444-444444444444";

function harness(status="WAITING_APPROVAL"){
  const calls:Array<{sql:string;args:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,args:unknown[]=[])=>{
    calls.push({sql,args});
    if(sql.includes("FROM automotive_work_order o")&&sql.includes("FOR UPDATE"))
      return {rows:[{id,status,mileage_in_km:120_000,mileage_out_km:null,
        authorization_limit_minor:"500000",vehicle_id:"vehicle-1"}],rowCount:1};
    if(sql.includes("UPDATE automotive_work_order"))
      return {rows:[{id,status,authorization_limit_minor:args[9]}],rowCount:1};
    return {rows:[],rowCount:0};
  })};
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
  const service=new AutomotiveService(db as any,{} as any);
  return {service,client,db,calls};
}

describe("automotive repair authorization and safety",()=>{
  it("rejects invalid customer budget before any database write",async()=>{
    const {service,db}=harness();
    await expect(service.createWorkOrder(ctx,{
      vehicleId:"vehicle",authorizationLimitMinor:"-100"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("requires client consent evidence when the repair estimate changes",async()=>{
    const {service,calls}=harness();
    await expect(service.updateWorkOrder(ctx,id,{
      authorizationLimitMinor:"700000",authorizationNote:"okay"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.some(x=>x.sql.includes("UPDATE automotive_work_order"))).toBe(false);
  });

  it("rejects edits after a vehicle has been delivered",async()=>{
    const {service,calls}=harness("DELIVERED");
    await expect(service.updateWorkOrder(ctx,id,{
      authorizationLimitMinor:"900000",
      authorizationNote:"Customer requested an extra repair"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.some(x=>x.sql.includes("UPDATE automotive_work_order"))).toBe(false);
  });

  it("stores new budget in a transaction with immutable audit event",async()=>{
    const {service,calls}=harness();
    await service.updateWorkOrder(ctx,id,{
      authorizationLimitMinor:"700000",
      authorizationNote:"Согласовано дополнительно с клиентом"
    });
    const update=calls.find(x=>x.sql.includes("UPDATE automotive_work_order"));
    expect(update?.args[8]).toBe(true);
    expect(update?.args[9]).toBe("700000");
    const audit=calls.find(x=>x.sql.includes("INSERT INTO audit_event"));
    expect(audit).toBeDefined();
    expect(audit?.args[3]).toBe("automotive.authorization_limit_changed");
    expect(JSON.parse(String(audit?.args[6])).previousLimitMinor).toBe("500000");
  });
});
