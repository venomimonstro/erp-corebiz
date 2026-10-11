import {BadRequestException,ConflictException} from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const lessonId="44444444-4444-4444-8444-444444444444";
const studentId="55555555-5555-4555-8555-555555555555";

describe("dance studio: safe booking and attendance",()=>{
  const authorization={
    resolveScope:jest.fn(async()=> "all"),
    membershipIdsForScope:jest.fn(async()=>null)
  };

  it.each([
    [{studentId,priceSource:"FREE",chargeMinor:"20000"},"Бесплатное занятие"],
    [{studentId,packageId:"p",chargeMinor:"1000"},"абонемента"],
    [{studentId,priceSource:"MAKEUP"},"отработки"],
    [{studentId,priceSource:"UNKNOWN"},"способ оплаты"],
    [{studentId,chargeMinor:"99999999999999999999"},"стоимость"]
  ])("rejects invalid booking payment rule before database write",async(input,expected)=>{
    const database={withTenantTransaction:jest.fn()};
    const service=new DanceStudioService(database as any,authorization as any);
    await expect(service.addParticipant(context,lessonId,input as any))
      .rejects.toThrow(expected);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("uses the lesson price snapshot for direct bookings with no manual price",async()=>{
    const captured:Array<unknown[]>=[];
    const client={
      query:jest.fn(async(sql:string,params:unknown[]=[])=>{
        if(sql.includes("FROM dance_lesson l"))return {rows:[{
          id:lessonId,group_id:null,status:"PLANNED",capacity:10,
          attendance_locked_at:null,booking_price_minor:"45000",currency:"RUB"
        }],rowCount:1};
        if(sql.includes("FROM dance_student s"))return {rows:[{
          id:studentId,party_id:"66666666-6666-4666-8666-666666666666"
        }],rowCount:1};
        if(sql.includes("SELECT count(*)")&&sql.includes("FROM dance_lesson_participant"))
          return {rows:[{count:0}],rowCount:1};
        if(sql.includes("SELECT id,status,version")&&sql.includes("FROM dance_lesson_participant"))
          return {rows:[],rowCount:0};
        if(sql.includes("INSERT INTO dance_lesson_participant")){
          captured.push(params);
          return {rows:[{id:"77777777-7777-4777-8777-777777777777",status:"BOOKED",version:1}],rowCount:1};
        }
        throw new Error("Unexpected SQL: "+sql.slice(0,95));
      })
    };
    const database={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const service=new DanceStudioService(database as any,authorization as any);
    const charge=jest.fn(async()=>undefined);
    (service as any).attachParticipantPaymentTx=charge;
    const booking=await service.addParticipant(context,lessonId,{studentId,priceSource:"DIRECT"});
    expect(booking.status).toBe("BOOKED");
    expect(captured[0]?.[6]).toBe("45000");
    expect(charge).toHaveBeenCalledTimes(1);
    expect(charge.mock.calls[0]?.[8]).toBe("45000");
  });

  it("rejects a missing price, never silently gives away a direct lesson",async()=>{
    const client={query:jest.fn(async()=>({rows:[{
      id:lessonId,group_id:null,status:"PLANNED",attendance_locked_at:null,
      capacity:10,currency:"RUB",booking_price_minor:"0"
    }]}))};
    const database={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const service=new DanceStudioService(database as any,authorization as any);
    await expect(service.addParticipant(context,lessonId,{studentId,priceSource:"DIRECT"}))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it.each([
    [{status:"INVALID",version:1},"отметка"],
    [{status:"ATTENDED",version:0},"версия"],
    [{status:"LATE",version:-1},"версия"]
  ])("validates attendance transitions before issuing SQL",async(input,reason)=>{
    const database={withTenantTransaction:jest.fn()};
    const service=new DanceStudioService(database as any,authorization as any);
    await expect(service.markAttendance(context,lessonId,"p",input as any))
      .rejects.toThrow(reason);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
