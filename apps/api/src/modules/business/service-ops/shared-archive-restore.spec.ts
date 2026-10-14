import {
  ForbiddenException,NotFoundException
} from "@nestjs/common";
import {ResourcesService} from "./resources.service";
import {BookingService} from "./booking.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const resourceId="44444444-4444-4444-8444-444444444444";
const staffMembership="55555555-5555-4555-8555-555555555555";
const serviceId="66666666-6666-4666-8666-666666666666";
function resources(canManage=true,found=true,memberStatus="SUSPENDED"){
  const client={query:jest.fn(async(sql:string,args:any[])=>{
    if(sql.includes("FROM service_resource")&&sql.includes("status='ARCHIVED'"))
      return {rows:found?[{membership_id:staffMembership}]:[],rowCount:found?1:0};
    if(sql.includes("FROM tenant_membership"))
      return {rows:[{status:memberStatus}],rowCount:1};
    if(sql.includes("UPDATE service_resource"))
      return {rows:[],rowCount:1};
    if(sql.includes("FROM service_resource r"))
      return {rows:[{id:resourceId,status:args[2]}],rowCount:1};
    throw Error("Unexpected SQL "+sql.slice(0,120));
  })};
  const db={withTenantTransaction:jest.fn(async(_c:any,cb:any)=>cb(client))};
  const auth={resolveScope:jest.fn(async(_c:any,code:string)=>
    code==="users.manage"&&!canManage?null:"all")};
  const subject=Object.create(ResourcesService.prototype) as any;
  subject.database=db;subject.authorization=auth;
  subject.serviceScope=jest.fn().mockResolvedValue({scope:"all",membershipIds:null});
  subject.audit=jest.fn().mockResolvedValue(undefined);
  return {service:subject as ResourcesService,client,db,auth,subject};
}
function catalogue(canManage=true,found=true){
  const client={query:jest.fn(async(sql:string,args:any[])=>{
    if(sql.includes("FROM service_catalog_item")&&sql.includes("FOR UPDATE"))
      return {rows:found?[{id:serviceId}]:[],rowCount:found?1:0};
    if(sql.includes("UPDATE service_catalog_item"))return {rows:[],rowCount:1};
    if(sql.includes("INSERT INTO audit_event"))return {rows:[],rowCount:1};
    if(sql.includes("FROM service_catalog_item s"))
      return {rows:[{id:serviceId,status:args[1]}],rowCount:1};
    throw Error("Unexpected SQL "+sql.slice(0,120));
  })};
  const db={withTenantTransaction:jest.fn(async(_c:any,cb:any)=>cb(client))};
  const auth={resolveScope:jest.fn(async()=>canManage?"all":null)};
  const subject=Object.create(BookingService.prototype) as any;
  subject.database=db;subject.authorization=auth;
  subject.requireServiceAll=jest.fn().mockResolvedValue(undefined);
  return {service:subject as BookingService,client,db};
}
describe("shared service catalogue/resource lifecycle (all industry verticals)",()=>{
  it("shows archive list only to manager; tenant and status filter in SQL",async()=>{
    const r=resources();
    const result=await r.service.list(ctx,"ARCHIVED");
    expect(result[0]).toMatchObject({id:resourceId,status:"ARCHIVED"});
    expect(r.client.query).toHaveBeenCalledWith(
      expect.stringContaining("r.status = $3"),
      [ctx.tenantId,null,"ARCHIVED"]
    );
    const restricted=resources(false);
    await expect(restricted.service.list(ctx,"ARCHIVED"))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(restricted.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("restore keeps old membership suspended and disables online booking",async()=>{
    const r=resources();
    expect(await r.service.restore(ctx,resourceId)).toEqual({
      restored:true,onlineBookingEnabled:false,loginRequiresReview:true
    });
    const statements=r.client.query.mock.calls.map(x=>String(x[0]));
    expect(statements.some(x=>x.includes("online_booking_enabled=false"))).toBe(true);
    expect(statements.every(x=>!x.includes("UPDATE tenant_membership"))).toBe(true);
    expect(r.subject.audit).toHaveBeenCalledWith(expect.anything(),ctx,
      "service.resource_restored","service_resource",resourceId,
      expect.objectContaining({loginRequiresReview:true}));
  });
  it("restore of already active or inaccessible resource fails, not duplicate",async()=>{
    const r=resources(true,false);
    await expect(r.service.restore(ctx,resourceId))
      .rejects.toBeInstanceOf(NotFoundException);
    const forbidden=resources(false);
    await expect(forbidden.service.restore(ctx,resourceId))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
  it("active login stays active but online bookings require separate review",async()=>{
    const r=resources(true,true,"ACTIVE");
    expect((await r.service.restore(ctx,resourceId)).loginRequiresReview).toBe(false);
    expect(r.client.query.mock.calls.some(x=>String(x[0])
      .includes("online_booking_enabled=false"))).toBe(true);
  });
  it("service archive is only visible with administrative permission",async()=>{
    const t=catalogue();
    expect(await t.service.services(ctx,"ARCHIVED")).toEqual([
      {id:serviceId,status:"ARCHIVED"}
    ]);
    expect(t.client.query).toHaveBeenCalledWith(
      expect.stringContaining("s.status = $2"),[ctx.tenantId,"ARCHIVED"]
    );
    const forbidden=catalogue(false);
    await expect(forbidden.service.services(ctx,"ARCHIVED"))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
  it("restores service with same identifier and audit trail",async()=>{
    const t=catalogue();
    expect(await t.service.restoreService(ctx,serviceId)).toEqual({
      restored:true,reviewRequired:true
    });
    const statements=t.client.query.mock.calls.map(x=>String(x[0]));
    expect(statements.some(x=>x.includes("status='ARCHIVED' FOR UPDATE"))).toBe(true);
    expect(statements.some(x=>x.includes("status='ACTIVE'"))).toBe(true);
    expect(statements.some(x=>x.includes("service.catalog_restored"))).toBe(true);
    expect(statements.every(x=>!x.includes("DELETE FROM service_booking"))).toBe(true);
  });
  it("restored services require approval and cannot be booked prematurely",async()=>{
    const t=catalogue();
    await t.service.restoreService(ctx,serviceId);
    const sql=t.client.query.mock.calls.map(x=>String(x[0]));
    expect(sql.some(x=>x.includes("restore_review_required"))).toBe(true);
    const booking=t.service as any;
    const raw={query:jest.fn(async()=>({rows:[{
      id:serviceId,duration_minutes:60,buffer_before_minutes:0,
      buffer_after_minutes:0,price_minor:"700000",currency:"RUB",
      group_capacity:12,delivery_format:"GROUP",
      metadata:{restore_review_required:true}
    }],rowCount:1}))};
    await expect(booking.getService(raw,ctx.tenantId,serviceId))
      .rejects.toThrow("ещё не подтверждена владельцем");
    expect(await t.service.approveRestoredService(ctx,serviceId))
      .toEqual({published:true});
    expect(t.client.query.mock.calls.some(x=>String(x[0])
      .includes("metadata=coalesce(metadata"))).toBe(true);
  });
  it("permission-limited reception cannot approve service publication",async()=>{
    const t=catalogue(false);
    await expect(t.service.approveRestoredService(ctx,serviceId))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(t.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("never resurrects a service on a repeated or unauthorized request",async()=>{
    await expect(catalogue(true,false).service.restoreService(ctx,serviceId))
      .rejects.toBeInstanceOf(NotFoundException);
    const forbidden=catalogue(false);
    await expect(forbidden.service.restoreService(ctx,serviceId))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(forbidden.db.withTenantTransaction).not.toHaveBeenCalled();
  });
});
