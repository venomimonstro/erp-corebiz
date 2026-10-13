import {BadRequestException,ForbiddenException,ConflictException} from "@nestjs/common";
import {DanceTrainerPortalService} from "./dance-trainer-portal.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const resourceId="44444444-4444-4444-8444-444444444444";
function fixture(scope:string|null="own",resource=true){
  const calls:Array<{sql:string;args:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,args:unknown[])=>{
    calls.push({sql,args});
    if(sql.includes("FROM service_resource r")&&sql.includes("JOIN tenant_membership"))
      return {rows:resource?[{id:resourceId,name:"Coach",timezone:"Europe/Moscow"}]:[],rowCount:resource?1:0};
    if(sql.includes("FROM dance_lesson l"))
      return {rows:[{id:"own-lesson",group_name:"Hip-Hop",booked_count:9,attended_count:8}],rowCount:1};
    if(sql.includes("FROM tenant_membership m"))
      return {rows:[{ok:1}],rowCount:1};
    if(sql.startsWith("UPDATE service_resource s"))
      return {rows:[{id:resourceId}],rowCount:1};
    return {rows:[],rowCount:0};
  })};
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
  const auth={resolveScope:jest.fn(async(_ctx:unknown,permission:string)=>{
    if(permission==="dance.trainer.read")return scope;
    return "all";
  })};
  return {service:new DanceTrainerPortalService(db as any,auth as any),
    db,auth,calls,client};
}
describe("Self-service dance trainer profile",()=>{
  it("blocks people without a trainer calendar permission",async()=>{
    const {service,db}=fixture(null);
    await expect(service.self(ctx,"2026-10-01","2026-11-01"))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("requires a server-linked employee membership, never an HTTP trainer ID",async()=>{
    const {service}=fixture("own",false);
    await expect(service.self(ctx,"2026-10-01","2026-11-01"))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
  it("shows own room, group and workload without customer financial data",async()=>{
    const {service,calls}=fixture();
    const response=await service.self(ctx,"2026-10-01","2026-11-01");
    expect(response.trainer.id).toBe(resourceId);
    expect(response.lessons).toHaveLength(1);
    const read=calls.find(x=>x.sql.includes("FROM service_resource r"));
    expect(read?.args).toEqual([ctx.tenantId,ctx.membershipId,ctx.userId]);
    const lessons=calls.find(x=>x.sql.includes("FROM dance_lesson l"));
    expect(lessons?.args).toEqual([
      ctx.tenantId,resourceId,"2026-10-01","2026-11-01","Europe/Moscow"
    ]);
    expect(lessons?.sql).toContain("l.trainer_resource_id=$2");
    expect(lessons?.sql).not.toContain("party.display_name");
    expect(lessons?.sql).not.toContain("finance");
    expect(JSON.stringify(response)).not.toContain("customer_name");
  });
  it("rejects date spans beyond 92 days or invalid days",async()=>{
    const {service,db}=fixture();
    await expect(service.self(ctx,"2026-10-01","2027-02-01"))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.self(ctx,"2026-02-30","2026-03-02"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("only the owner can link a minimal trainer login",async()=>{
    const f=fixture();
    f.auth.resolveScope=jest.fn(async()=>null);
    await expect(f.service.link(ctx,{membershipId:ctx.membershipId,resourceId}))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("binds tenant membership to an unclaimed employee only",async()=>{
    const f=fixture();
    const result=await f.service.link(ctx,{membershipId:ctx.membershipId,resourceId});
    expect(result.linked).toBe(true);
    const sql=f.calls.find(x=>x.sql.startsWith("UPDATE service_resource s"));
    expect(sql?.sql).toContain("s.membership_id IS NULL OR s.membership_id=$3");
    expect(sql?.sql).toContain("other.id<>s.id");
    expect(sql?.args).toEqual([ctx.tenantId,resourceId,ctx.membershipId]);
  });
});
