import {ConflictException} from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const groupId="44444444-4444-4444-8444-444444444444";
const lessonId="55555555-5555-4555-8555-555555555555";
const studentId="66666666-6666-4666-8666-666666666666";

function harness(query:(sql:string,params:unknown[])=>Promise<unknown>){
  const client={query:jest.fn(query)};
  const db={withTenantTransaction:jest.fn(async(_context:unknown,run:any)=>run(client))};
  const auth={
    resolveScope:jest.fn(async()=> "all"),
    membershipIdsForScope:jest.fn(async()=>null)
  };
  const studio=new DanceStudioService(db as any,auth as any);
  return {studio,client,db};
}

describe("dance: simultaneous capacity and cancellation safeguards",()=>{
  it("does not move an already enrolled child into the waiting list when full",async()=>{
    const {studio,client}=harness(async sql=>{
      if(sql.includes("FROM dance_group_member")&&sql.includes("FOR UPDATE"))return {
        rows:[{id:"member-1",status:"ACTIVE",reserved_place:true,discount_bps:1000}]
      };
      if(sql.includes("UPDATE dance_group_member"))return {
        rows:[{id:"member-1",status:"ACTIVE",reserved_place:true}]
      };
      throw new Error("Unexpected query: "+sql.slice(0,90));
    });
    (studio as any).assertGroupAccess=jest.fn().mockResolvedValue({
      id:groupId,program_id:"program-1",capacity:1
    });
    (studio as any).assertStudentAccess=jest.fn().mockResolvedValue({
      id:studentId,party_id:"party-1"
    });
    (studio as any).assertStudentEligibility=jest.fn().mockResolvedValue(undefined);
    const result=await studio.addGroupMember(context,groupId,{studentId});
    expect(result.waitlisted).toBe(false);
    expect(result.alreadyEnrolled).toBe(true);
    expect(client.query.mock.calls.some(c=>String(c[0]).includes("INSERT INTO dance_group_waitlist")))
      .toBe(false);
  });

  it("cannot reactivate a paused non-reserving member when their former seat was filled",async()=>{
    const {studio,client}=harness(async sql=>{
      if(sql.includes("SELECT id,student_id,status,reserved_place"))return {
        rows:[{id:"member-1",student_id:studentId,status:"PAUSED",reserved_place:false}]
      };
      if(sql.includes("count(*)::integer")&&sql.includes("dance_group_member"))
        return {rows:[{count:1}]};
      throw new Error("Unexpected query: "+sql.slice(0,90));
    });
    (studio as any).assertGroupAccess=jest.fn().mockResolvedValue({id:groupId,capacity:1});
    await expect(studio.changeGroupMemberStatus(context,groupId,"member-1",
      {status:"ACTIVE"})).rejects.toBeInstanceOf(ConflictException);
    expect(client.query.mock.calls.some(c=>String(c[0]).includes("UPDATE dance_group_member")))
      .toBe(false);
  });

  it("refuses backdated free cancellation and never releases the package",async()=>{
    const {studio,client}=harness(async sql=>{
      if(sql.includes("FROM dance_lesson_participant"))return {rows:[{
        id:"participant-1",student_id:studentId,package_id:"package-1",
        makeup_credit_id:null,charge_minor:"0",price_source:"PACKAGE",
        version:1,status:"BOOKED"
      }]};
      throw new Error("Unexpected query: "+sql.slice(0,90));
    });
    (studio as any).assertLessonAccess=jest.fn().mockResolvedValue({
      id:lessonId,starts_at:new Date(Date.now()-3600000),
      status:"OPEN_FOR_BOOKING",attendance_locked_at:null
    });
    const release=jest.fn();
    (studio as any).releaseDanceReservationTx=release;
    await expect(studio.markAttendance(context,lessonId,"participant-1",
      {status:"CANCELLED_IN_TIME",version:1})).rejects.toBeInstanceOf(ConflictException);
    expect(release).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(c=>String(c[0]).startsWith("UPDATE dance_lesson_participant")))
      .toBe(false);
  });

  it("preserves an early cancellation and frees the seat for the waitlist",async()=>{
    const {studio}=harness(async sql=>{
      if(sql.includes("FROM dance_lesson_participant")&&sql.includes("FOR UPDATE"))
        return {rows:[{
          id:"participant-1",student_id:studentId,package_id:null,
          makeup_credit_id:null,charge_minor:"0",price_source:"FREE",
          version:3,status:"BOOKED"
        }]};
      if(sql.includes("UPDATE dance_lesson_participant"))return {
        rows:[{id:"participant-1",version:4,status:"CANCELLED_IN_TIME"}]
      };
      if(sql.includes("FROM dance_lesson_participant")&&sql.includes("SKIP LOCKED"))
        return {rows:[]};
      throw new Error("Unexpected query: "+sql.slice(0,90));
    });
    (studio as any).assertLessonAccess=jest.fn().mockResolvedValue({
      id:lessonId,starts_at:new Date(Date.now()+86400000),
      status:"PLANNED",attendance_locked_at:null
    });
    const result=await studio.markAttendance(context,lessonId,"participant-1",
      {status:"CANCELLED_IN_TIME",version:3});
    expect(result.status).toBe("CANCELLED_IN_TIME");
    expect(result.promoted).toBeNull();
  });
});
