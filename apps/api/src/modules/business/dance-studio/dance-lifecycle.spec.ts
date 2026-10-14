import {ConflictException,ForbiddenException,NotFoundException}
  from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const id="44444444-4444-4444-8444-444444444444";
const serviceId="55555555-5555-4555-8555-555555555555";
const trainerId="66666666-6666-4666-8666-666666666666";
const revision="1792013400.123456";

function setup(config:{
  programStatus?:string;groupStatus?:string;
  programGroup?:boolean;futureLesson?:boolean;
  student?:boolean;waitlist?:boolean;serviceActive?:boolean;
  archivedProgram?:boolean;permissions?:boolean
}={}){
  const queries:string[]=[];
  const client={query:jest.fn(async(sql:string)=>{
    queries.push(sql);
    if(sql.includes("FROM dance_program WHERE tenant_id=$1 AND id=$2 FOR UPDATE"))
      return {rows:[{
        id,name:"Contemporary",service_id:serviceId,branch_id:null,
        min_age:8,max_age:16,default_duration_minutes:60,
        status:config.programStatus??"ACTIVE",revision
      }],rowCount:1};
    if(sql.includes("FROM dance_group")&&sql.includes("FOR UPDATE"))
      return {rows:[{version:1,status:config.groupStatus??"ACTIVE",
        program_id:id,trainer_resource_id:trainerId,room_resource_id:null}],rowCount:1};
    if(sql.includes("FROM dance_program")&&sql.includes("status='ACTIVE'"))
      return {rows:config.archivedProgram?[]:[{}],
        rowCount:config.archivedProgram?0:1};
    if(sql.includes("FROM service_catalog_item"))
      return {rows:config.serviceActive===false?[]:[{}],
        rowCount:config.serviceActive===false?0:1};
    if(sql.includes("FROM branch"))
      return {rows:[],rowCount:0};
    if(sql.includes("FROM dance_group_member"))
      return {rows:config.student?[{}]:[],rowCount:config.student?1:0};
    if(sql.includes("FROM dance_group_waitlist"))
      return {rows:config.waitlist?[{}]:[],rowCount:config.waitlist?1:0};
    if(sql.includes("FROM dance_lesson"))
      return {rows:config.futureLesson?[{}]:[],
        rowCount:config.futureLesson?1:0};
    if(sql.includes("SELECT 1 FROM dance_group"))
      return {rows:config.programGroup?[{}]:[],
        rowCount:config.programGroup?1:0};
    if(sql.includes("UPDATE dance_group"))
      return {rows:[{status:config.groupStatus==="ARCHIVED"?"DRAFT":"ARCHIVED",
        version:2}],rowCount:1};
    if(sql.includes("UPDATE dance_program"))
      return {rows:[{status:config.programStatus==="ARCHIVED"?"ACTIVE":"ARCHIVED",
        revision:"1792013401.123456"}],rowCount:1};
    if(sql.includes("INSERT INTO audit_event"))
      return {rows:[],rowCount:1};
    throw new Error("Unexpected SQL: "+sql.slice(0,120));
  })};
  const database={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
  const authorization={resolveScope:jest.fn(async(_ctx:unknown,permission:string)=>{
    if(config.permissions===false&&permission==="catalog.write")return null;
    return "all";
  })};
  const svc=Object.create(DanceStudioService.prototype) as any;
  svc.database=database;svc.authorization=authorization;
  svc.assertTrainerRoom=jest.fn().mockResolvedValue(undefined);
  return {svc:svc as DanceStudioService,raw:svc,client,queries,database};
}
describe("direction and group lifecycle for a multi-branch dance tenant",()=>{
  it("requires catalog governance; an ordinary reception manager cannot archive directions",async()=>{
    const t=setup({permissions:false});
    await expect(t.svc.changeProgram(ctx,id,{
      action:"ARCHIVE",expectedRevision:revision
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("rejects stale program revisions before any mutation",async()=>{
    const t=setup();
    await expect(t.svc.changeProgram(ctx,id,{
      action:"ARCHIVE",expectedRevision:"1792013390.123456"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(t.queries.some(q=>q.includes("UPDATE dance_program"))).toBe(false);
  });
  it("cannot close an active program with any linked active group",async()=>{
    const t=setup({programGroup:true});
    await expect(t.svc.changeProgram(ctx,id,{
      action:"ARCHIVE",expectedRevision:revision
    })).rejects.toBeInstanceOf(ConflictException);
  });
  it("does not restore a direction when shared catalog service was archived",async()=>{
    const t=setup({programStatus:"ARCHIVED",serviceActive:false});
    await expect(t.svc.changeProgram(ctx,id,{
      action:"RESTORE",expectedRevision:revision
    })).rejects.toBeInstanceOf(ConflictException);
  });
  it("rejects changes to age restrictions while groups remain enrolled",async()=>{
    const t=setup({programGroup:true});
    await expect(t.svc.changeProgram(ctx,id,{
      action:"UPDATE",expectedRevision:revision,minAge:12
    })).rejects.toBeInstanceOf(ConflictException);
  });
  it("allows renaming a direction without rewriting service price or history",async()=>{
    const t=setup();
    const updated=await t.svc.changeProgram(ctx,id,{
      action:"UPDATE",expectedRevision:revision,name:"Contemporary advanced"
    });
    expect(updated.id).toBe(id);
    expect(updated.revision).toBe("1792013401.123456");
    expect(t.queries.some(q=>q.includes("UPDATE service_catalog_item"))).toBe(false);
    expect(t.queries.some(q=>q.includes("DELETE FROM dance_"))).toBe(false);
  });
  it("rejects a foreign branch when creating a new program",async()=>{
    const t=setup();
    await expect(t.svc.createProgram(ctx,{
      name:"Hip-hop",serviceId,branchId:id
    })).rejects.toBeInstanceOf(NotFoundException);
    expect(t.queries.some(q=>q.includes("INSERT INTO dance_program"))).toBe(false);
  });
  it("will not archive group while a child remains enrolled",async()=>{
    const t=setup({student:true});
    await expect(t.svc.groupLifecycle(ctx,id,{
      action:"ARCHIVE",expectedVersion:1
    })).rejects.toBeInstanceOf(ConflictException);
    expect(t.queries.some(q=>q.includes("UPDATE dance_group"))).toBe(false);
  });
  it("will not archive group with future lessons or waitlist",async()=>{
    const future=setup({futureLesson:true});
    await expect(future.svc.groupLifecycle(ctx,id,{
      action:"ARCHIVE",expectedVersion:1
    })).rejects.toBeInstanceOf(ConflictException);
    const waitlist=setup({waitlist:true});
    await expect(waitlist.svc.groupLifecycle(ctx,id,{
      action:"ARCHIVE",expectedVersion:1
    })).rejects.toBeInstanceOf(ConflictException);
  });
  it("archives a settled group and retains versioned attendance history",async()=>{
    const t=setup();
    const output=await t.svc.groupLifecycle(ctx,id,{
      action:"ARCHIVE",expectedVersion:1
    });
    expect(output).toMatchObject({status:"ARCHIVED",version:2});
    expect(t.queries.some(q=>q.includes("DELETE FROM dance_"))).toBe(false);
  });
  it("restoring group needs active direction; group returns to draft",async()=>{
    const missing=setup({groupStatus:"ARCHIVED",archivedProgram:true});
    await expect(missing.svc.groupLifecycle(ctx,id,{
      action:"RESTORE",expectedVersion:1
    })).rejects.toBeInstanceOf(ConflictException);
    const safe=setup({groupStatus:"ARCHIVED"});
    const restored=await safe.svc.groupLifecycle(ctx,id,{
      action:"RESTORE",expectedVersion:1
    });
    expect(restored).toMatchObject({status:"DRAFT",version:2,reviewRequired:true});
    expect(safe.raw.assertTrainerRoom).toHaveBeenCalledWith(
      expect.anything(),ctx.tenantId,trainerId,null
    );
  });
});
