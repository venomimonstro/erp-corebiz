import {BadRequestException,ForbiddenException} from "@nestjs/common";
import {DanceTrainerPortalService} from "./dance-trainer-portal.service";
const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const resourceA="44444444-4444-4444-8444-444444444444";
const resourceB="55555555-5555-4555-8555-555555555555";
function fixture(options:{permission?:string|null;hasResources?:boolean}={}){
  const calls:Array<{sql:string;args:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,args:unknown[]=[])=>{
    calls.push({sql,args});
    if(sql.includes("SELECT r.id,r.name,r.timezone,b.name AS branch_name"))
      return options.hasResources===false?{rows:[],rowCount:0}:{
        rows:[
          {id:resourceA,name:"Coach A",timezone:"Europe/Moscow",branch_name:"Филиал А"},
          {id:resourceB,name:"Coach B",timezone:"Europe/Moscow",branch_name:"Филиал Б"}
        ],rowCount:2
      };
    if(sql.includes("FROM dance_lesson l"))
      return {rows:[
        {id:"lesson-a",trainer_resource_id:resourceA,branch_name:"Филиал А"},
        {id:"lesson-b",trainer_resource_id:resourceB,branch_name:"Филиал Б"}
      ],rowCount:2};
    throw new Error("Unexpected SQL: "+sql.slice(0,95));
  })};
  const database={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>cb(client))};
  const auth={resolveScope:jest.fn(async()=>options.permission===undefined?
    "own":options.permission)};
  const portal=new DanceTrainerPortalService(database as any,auth as any);
  return {portal,calls,database};
}
describe("trainer portal with assignments at two studio branches",()=>{
  it("shows lessons from both resources of the same authenticated trainer",async()=>{
    const {portal,calls}=fixture();
    const result=await portal.self(ctx,"2026-10-13","2026-11-13");
    expect(result.resources).toHaveLength(2);
    expect(result.lessons).toHaveLength(2);
    expect(result.lessons.map((x:any)=>x.trainer_resource_id))
      .toEqual([resourceA,resourceB]);
    const rows=calls.find(c=>c.sql.includes("FROM dance_lesson l"));
    expect(rows?.args).toEqual([
      ctx.tenantId,ctx.membershipId,"2026-10-13","2026-11-13",
      [resourceA,resourceB]
    ]);
    expect(rows?.sql).toContain("coach.membership_id=$2");
    expect(rows?.sql).toContain("l.trainer_resource_id=ANY($5::uuid[])");
    expect(rows?.sql).toContain("coalesce(coach.timezone,'Europe/Moscow')");
    expect(rows?.sql).not.toContain("l.trainer_resource_id=$2");
  });
  it("does not expose a calendar without a linked active coach resource",async()=>{
    const {portal}=fixture({hasResources:false});
    await expect(portal.self(ctx,"2026-10-13","2026-11-13"))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
  it("refuses to expose other employees' schedules without own permission",async()=>{
    const {portal,database}=fixture({permission:null});
    await expect(portal.self(ctx,"2026-10-13","2026-11-13"))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("refuses calendar ranges wider than 92 days",async()=>{
    const {portal,database}=fixture();
    await expect(portal.self(ctx,"2026-01-01","2026-07-01"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
