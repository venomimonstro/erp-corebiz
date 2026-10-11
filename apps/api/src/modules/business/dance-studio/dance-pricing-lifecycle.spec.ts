import {ConflictException} from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const lessonId="44444444-4444-4444-8444-444444444444";
const studentId="55555555-5555-4555-8555-555555555555";

describe("dance rescheduling and group price lifecycle",()=>{
  const authorization={
    resolveScope:jest.fn(async()=> "all"),
    membershipIdsForScope:jest.fn(async()=>null)
  };

  it("a stale calendar version fails with a conflict instead of undeclared payment variables",async()=>{
    const client={query:jest.fn()};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const service=new DanceStudioService(db as any,authorization as any);
    (service as any).assertLessonAccess=jest.fn().mockResolvedValue({
      id:lessonId,version:3,status:"OPEN_FOR_BOOKING",
      booking_price_minor:"50000"
    });
    await expect(service.updateLesson(ctx,lessonId,{
      version:2,startsAt:"2026-10-18T17:00:00Z"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("bulk roster uses the saved lesson price and preserves the group discount",async()=>{
    const client={query:jest.fn(async(sql:string)=>{
      if(sql.includes("FROM service_booking"))
        return {rows:[{price_minor:"50000"}],rowCount:1};
      if(sql.includes("FROM dance_group_member gm"))
        return {rows:[{
          student_id:studentId,party_id:"party-1",
          member_status:"ACTIVE",discount_bps:1000
        }],rowCount:1};
      if(sql.includes("FROM dance_lesson_participant"))
        return {rows:[],rowCount:0};
      throw new Error("Unexpected SQL "+sql.slice(0,100));
    })};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const service=new DanceStudioService(db as any,authorization as any);
    (service as any).assertLessonAccess=jest.fn().mockResolvedValue({
      id:lessonId,group_id:"group-1",host_booking_id:"booking-1",
      status:"OPEN_FOR_BOOKING"
    });
    (service as any).candidatePackageIds=jest.fn().mockResolvedValue([]);
    const add=jest.fn().mockResolvedValue({status:"BOOKED"});
    (service as any).addParticipant=add;
    const result=await service.syncGroupRosterToLesson(ctx,lessonId);
    expect(result.enrolled).toBe(1);
    expect(add).toHaveBeenCalledWith(ctx,lessonId,{
      studentId,chargeMinor:"45000",allowWaitlist:true
    });
    expect(client.query.mock.calls.some(([sql])=>
      String(sql).includes("SELECT price_minor_snapshot::text AS price_minor")))
      .toBe(true);
  });
});
