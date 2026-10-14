import {ConflictException,ForbiddenException} from "@nestjs/common";
import {BookingService} from "./booking.service";
import {ResourcesService} from "./resources.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const serviceId="44444444-4444-4444-8444-444444444444";
const resourceId="55555555-5555-4555-8555-555555555555";
const revision="1791990000.123456";
const nextRevision="1791990001.123456";

function catalog(canEdit=true){
  let current=revision;
  const logs:Array<{sql:string;params:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,params:unknown[]=[])=>{
    logs.push({sql,params});
    if(sql.includes("SELECT EXTRACT(EPOCH FROM updated_at)"))
      return {rows:[{revision:current}],rowCount:1};
    if(sql.includes("UPDATE service_catalog_item")){
      current=nextRevision;
      return {rows:[{revision:current}],rowCount:1};
    }
    if(sql.includes("INSERT INTO audit_event"))
      return {rows:[],rowCount:1};
    throw new Error("Unexpected query: "+sql);
  })};
  const database={withTenantTransaction:jest.fn(async(_c:unknown,callback:any)=>
    callback(client))};
  const item=Object.create(BookingService.prototype) as any;
  item.database=database;
  item.requireServiceAll=jest.fn().mockResolvedValue(null);
  item.authorization={resolveScope:jest.fn().mockResolvedValue(canEdit?"all":null)};
  return {item:item as BookingService,client,logs,database};
}
function resource(canManage=true){
  let current=revision;
  const logs:Array<{sql:string;params:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,params:unknown[]=[])=>{
    logs.push({sql,params});
    if(sql.includes("SELECT EXTRACT(EPOCH FROM updated_at)"))
      return {rows:[{revision:current}],rowCount:1};
    if(sql.includes("UPDATE service_resource")){
      current=nextRevision;
      return {rows:[{revision:current}],rowCount:1};
    }
    throw new Error("Unexpected query: "+sql);
  })};
  const database={withTenantTransaction:jest.fn(async(_c:unknown,callback:any)=>
    callback(client))};
  const item=Object.create(ResourcesService.prototype) as any;
  item.database=database;
  item.serviceScope=jest.fn().mockResolvedValue({scope:"all",membershipIds:null});
  item.authorization={resolveScope:jest.fn().mockResolvedValue(canManage?"all":null)};
  item.audit=jest.fn().mockResolvedValue(undefined);
  return {item:item as ResourcesService,client,logs,database};
}

describe("shared ERP service catalog, optimistic updates",()=>{
  it("persists revision and immutable audit, rejects a second stale editor",async()=>{
    const f=catalog();
    const result=await f.item.updateService(context,serviceId,{
      priceMinor:"350000",durationMinutes:60,expectedRevision:revision
    });
    expect(result).toEqual({updated:true,revision:nextRevision});
    expect(f.logs.some(x=>x.sql.includes("service.catalog_updated"))).toBe(true);
    const writes=f.logs.filter(x=>x.sql.includes("UPDATE service_catalog_item"));
    expect(writes).toHaveLength(1);
    await expect(f.item.updateService(context,serviceId,{
      priceMinor:"240000",expectedRevision:revision
    })).rejects.toBeInstanceOf(ConflictException);
    expect(f.logs.filter(x=>x.sql.includes("UPDATE service_catalog_item"))).toHaveLength(1);
  });
  it("separates permission to register visits from permission to edit prices",async()=>{
    const f=catalog(false);
    await expect(f.item.updateService(context,serviceId,{
      priceMinor:"70000",expectedRevision:revision
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
    await expect(f.item.createDeliveryRule(context,{
      serviceId,priceMinor:"70000"
    })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.item.createPackagePlan(context,{
      name:"Неподтверждённая скидка 90%",
      visitLimit:10,durationDays:30,priceMinor:"70000"
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
describe("shared ERP staff and resource name changes",()=>{
  it("rejects lost update and keeps revision in audit trail",async()=>{
    const f=resource();
    const response=await f.item.rename(context,resourceId,{
      name:"Тренер Иванова",expectedRevision:revision
    });
    expect(response).toEqual({updated:true,revision:nextRevision});
    expect(f.logs.filter(x=>x.sql.includes("UPDATE service_resource"))).toHaveLength(1);
    await expect(f.item.rename(context,resourceId,{
      name:"Тренер Петрова",expectedRevision:revision
    })).rejects.toBeInstanceOf(ConflictException);
    expect(f.logs.filter(x=>x.sql.includes("UPDATE service_resource"))).toHaveLength(1);
  });
  it("never allows a receptionist without users.manage to rename employees",async()=>{
    const f=resource(false);
    await expect(f.item.rename(context,resourceId,{
      name:"Другой сотрудник",expectedRevision:revision
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
