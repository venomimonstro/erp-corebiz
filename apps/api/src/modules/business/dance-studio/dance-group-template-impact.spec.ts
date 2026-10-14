import {ConflictException} from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const groupId="44444444-4444-4444-8444-444444444444";
const trainer="55555555-5555-4555-8555-555555555555";
const group={
  id:groupId,version:4,name:"Бачата",trainer_resource_id:trainer,
  branch_id:null,room_resource_id:null,room_zone_id:null,
  room_capacity_units:1,capacity:16,break_even_members:8,
  starts_on:"2026-10-01",ends_on:null,
  schedule:[{weekday:2,startMinute:1140,durationMinutes:60}]
};
const newSchedule=[{weekday:4,startMinute:1140,durationMinutes:60}];
function fixture(future=3){
  const logs:Array<{sql:string;args:unknown[]}>= [];
  const query=jest.fn(async(sql:string,args:unknown[]=[])=>{
    logs.push({sql,args});
    if(sql.includes("count(DISTINCT l.id)::int"))
      return {rows:[{lessons:future,participants:11,
        first_lesson_at:new Date("2026-10-22T16:00:00Z"),
        last_lesson_at:new Date("2026-11-05T16:00:00Z")}]};
    if(sql.includes("FROM dance_group_member"))
      return {rows:[{count:7}],rowCount:1};
    if(sql.includes("SELECT membership_id")&&sql.includes("FROM service_resource"))
      return {rows:[{membership_id:context.membershipId}],rowCount:1};
    if(sql.includes("SELECT count(*)::int AS count")&&sql.includes("FROM dance_lesson"))
      return {rows:[{count:future}],rowCount:1};
    if(sql.includes("UPDATE dance_group"))
      return {rows:[{...group,version:5}],rowCount:1};
    throw new Error("Unmocked SQL: "+sql.slice(0,110));
  });
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>
    cb({query}))};
  const svc=Object.create(DanceStudioService.prototype) as any;
  svc.database=db;
  svc.scopeIds=jest.fn().mockResolvedValue(null);
  svc.assertGroupAccess=jest.fn().mockResolvedValue(group);
  svc.assertTrainerRoom=jest.fn().mockResolvedValue(undefined);
  svc.audit=jest.fn().mockResolvedValue(undefined);
  return {service:svc as DanceStudioService,internal:svc,query,logs};
}
describe("group edit: preserve existing reservations and client expectations",()=>{
  it("previews student commitments without changing the calendar",async()=>{
    const f=fixture(3);
    const impact=await f.service.groupChangeImpact(context,groupId);
    expect(impact).toMatchObject({
      groupId,version:4,futureLessons:3,futureParticipants:11
    });
    expect(f.logs.some(x=>x.sql.includes("UPDATE dance_group"))).toBe(false);
    expect(f.internal.scopeIds).toHaveBeenCalledWith(context,"dance.read");
  });
  it("rejects a changed timetable when 3 future lessons exist",async()=>{
    const f=fixture(3);
    await expect(f.service.updateGroup(context,groupId,{
      version:4,schedule:newSchedule
    })).rejects.toBeInstanceOf(ConflictException);
    expect(f.logs.some(x=>x.sql.includes("UPDATE dance_group"))).toBe(false);
  });
  it("accepts explicit acknowledgment without mutating existing lessons",async()=>{
    const f=fixture(3);
    const response=await f.service.updateGroup(context,groupId,{
      version:4,schedule:newSchedule,acknowledgeFutureLessonsUnchanged:true
    });
    expect(response.future_lessons_unchanged).toBe(3);
    expect(f.logs.some(x=>x.sql.includes("UPDATE dance_group"))).toBe(true);
    expect(f.logs.some(x=>x.sql.includes("UPDATE dance_lesson"))).toBe(false);
  });
  it("allows updates with no booked future lessons",async()=>{
    const f=fixture(0);
    await expect(f.service.updateGroup(context,groupId,{
      version:4,schedule:newSchedule
    })).resolves.toHaveProperty("future_lessons_unchanged",0);
  });
  it("retains optimistic locking of version",async()=>{
    const f=fixture(3);
    await expect(f.service.updateGroup(context,groupId,{
      version:3,schedule:newSchedule,acknowledgeFutureLessonsUnchanged:true
    })).rejects.toBeInstanceOf(ConflictException);
    expect(f.logs.some(x=>x.sql.includes("UPDATE dance_group"))).toBe(false);
  });
});
