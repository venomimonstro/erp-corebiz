import {ConflictException,ForbiddenException} from "@nestjs/common";
import {ResourcesService} from "./resources.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const resourceId="44444444-4444-4444-8444-444444444444";
const coachMembership="55555555-5555-4555-8555-555555555555";

function fixture(opts:{
  roles?:string[];isOwner?:boolean;resourceType?:string;
  futureGroups?:boolean;hasMembership?:boolean;
  manage?:boolean;active?:boolean;otherActiveResource?:boolean;
}={}){
  const query=jest.fn(async(sql:string)=>{
    if(sql.includes("pg_advisory_xact_lock"))
      return {rows:[{}],rowCount:1};
    if(sql.includes("SELECT id,type,membership_id FROM service_resource"))
      return {rows:[{id:resourceId,type:opts.resourceType??"EMPLOYEE",
        membership_id:opts.hasMembership===false?null:coachMembership}],rowCount:1};
    if(sql.includes("FROM dance_group"))
      return {rows:opts.futureGroups?[{id:"group"}]:[],rowCount:opts.futureGroups?1:0};
    if(sql.includes("FROM dance_lesson"))
      return {rows:[],rowCount:0};
    if(sql.includes("FROM service_booking_resource"))
      return {rows:[],rowCount:0};
    if(sql.includes("FROM room_rental_contract"))
      return {rows:[],rowCount:0};
    if(sql.includes("UPDATE service_resource"))
      return {rows:[{id:resourceId}],rowCount:1};
    if(sql.includes("SELECT is_owner,status FROM tenant_membership"))
      return {rows:[{is_owner:opts.isOwner??false,
        status:opts.active===false?"SUSPENDED":"ACTIVE"}],rowCount:1};
    if(sql.includes("FROM membership_role mr"))
      return {rows:(opts.roles??["DANCE_TRAINER"]).map(code=>({code})),rowCount:1};
    if(sql.includes("FROM service_resource") &&
       sql.includes("membership_id=$2") && sql.includes("id<>$3")){
      return opts.otherActiveResource
        ?{rows:[{id:"another-active-branch"}],rowCount:1}
        :{rows:[],rowCount:0};
    }
    if(sql.includes("UPDATE tenant_membership"))
      return {rows:[{}],rowCount:1};
    throw Error("Unexpected PostgreSQL query "+sql.slice(0,100));
  });
  const database={withTenantTransaction:jest.fn(async(_ctx:any,cb:any)=>cb({query}))};
  const authorization={resolveScope:jest.fn(async()=>opts.manage===false?null:"all")};
  const obj=Object.create(ResourcesService.prototype) as any;
  obj.database=database;
  obj.authorization=authorization;
  obj.serviceScope=jest.fn(async()=>({scope:"all",membershipIds:null}));
  obj.audit=jest.fn(async()=>undefined);
  return {service:obj as ResourcesService,query,database};
}
describe("Dance coach offboarding with shared partner membership",()=>{
  it("atomically archives a dedicated trainer and suspends its login",async()=>{
    const t=fixture();
    const res=await t.service.archive(ctx,resourceId);
    expect(res).toEqual({archived:true,loginSuspended:true,
      linkedUserRemainsActive:false});
    const sql=t.query.mock.calls.map(([s])=>s as string);
    const archive=sql.findIndex(x=>x.includes("UPDATE service_resource"));
    const suspended=sql.findIndex(x=>x.includes("UPDATE tenant_membership"));
    expect(archive).toBeGreaterThan(-1);
    expect(suspended).toBeGreaterThan(archive);
    const lock=sql.findIndex(x=>x.includes("pg_advisory_xact_lock"));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(archive);
  });
  it("keeps a dedicated coach login when their other branch resource remains active",async()=>{
    const t=fixture({otherActiveResource:true});
    const result=await t.service.archive(ctx,resourceId);
    expect(result).toEqual({
      archived:true,loginSuspended:false,linkedUserRemainsActive:true
    });
    expect(t.query.mock.calls.some(([sql])=>String(sql)
      .includes("UPDATE tenant_membership"))).toBe(false);
    expect(t.query.mock.calls.some(([sql])=>String(sql)
      .includes("id<>$3"))).toBe(true);
  });
  it("suspends a dedicated coach only when the LAST active assignment is archived",async()=>{
    const t=fixture({otherActiveResource:false});
    const result=await t.service.archive(ctx,resourceId);
    expect(result.loginSuspended).toBe(true);
    const checkedOther=t.query.mock.calls.some(([sql])=>String(sql)
      .includes("id<>$3"));
    expect(checkedOther).toBe(true);
  });
  it("does not revoke the co-owner while archiving a teaching resource",async()=>{
    const t=fixture({roles:["DANCE_PARTNER"]});
    expect(await t.service.archive(ctx,resourceId))
      .toEqual({archived:true,loginSuspended:false,
        linkedUserRemainsActive:true});
    expect(t.query.mock.calls.some(([sql])=>String(sql)
      .includes("UPDATE tenant_membership"))).toBe(false);
  });
  it("never suspends tenant owner via resource archival",async()=>{
    const t=fixture({isOwner:true,roles:["OWNER"]});
    const result=await t.service.archive(ctx,resourceId);
    expect(result.linkedUserRemainsActive).toBe(true);
    expect(result.loginSuspended).toBe(false);
  });
  it("stops before archival when a coach still owns a group",async()=>{
    const t=fixture({futureGroups:true});
    await expect(t.service.archive(ctx,resourceId))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.query.mock.calls.some(([sql])=>String(sql)
      .includes("UPDATE service_resource"))).toBe(false);
  });
  it("cannot dismiss anyone with only service.read or no user administration",async()=>{
    const t=fixture({manage:false});
    await expect(t.service.archive(ctx,resourceId))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(t.database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("archiving a hall never affects an unrelated member login",async()=>{
    const t=fixture({resourceType:"HALL",hasMembership:false});
    const res=await t.service.archive(ctx,resourceId);
    expect(res).toMatchObject({archived:true,loginSuspended:false});
    expect(t.query.mock.calls.some(([sql])=>String(sql)
      .includes("UPDATE tenant_membership"))).toBe(false);
  });
});
