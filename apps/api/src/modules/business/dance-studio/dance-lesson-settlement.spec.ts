import {ConflictException} from "@nestjs/common";
import {DanceEconomicsService} from "./dance-economics.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
describe("dance commercial settlement integrity",()=>{
  function harness(participants:any[]){
    const client={query:jest.fn(async(sql:string)=>{
      if(sql.includes("status='BOOKED'")&&sql.includes("count(*)"))
        return {rows:[{count:0}],rowCount:1};
      if(sql.includes("FROM dance_lesson_participant")&&sql.includes("ORDER BY id"))
        return {rows:participants,rowCount:participants.length};
      if(sql.includes("FROM dance_package_redemption"))
        return {rows:[],rowCount:0};
      if(sql.includes("INSERT INTO dance_lesson_profitability"))
        return {rows:[{lesson_id:"lesson-1"}],rowCount:1};
      if(sql.includes("UPDATE dance_lesson")||
         sql.includes("UPDATE service_booking")||
         sql.includes("INSERT INTO audit_event"))
        return {rows:[],rowCount:1};
      throw new Error("Unexpected SQL "+sql.slice(0,90));
    })};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const auth={
      resolveScope:jest.fn(async()=> "all"),
      membershipIdsForScope:jest.fn(async()=>null)
    };
    const service=new DanceEconomicsService(db as any,auth as any,{} as any);
    (service as any).lessonForUpdate=jest.fn().mockResolvedValue({
      id:"lesson-1",status:"OPEN_FOR_BOOKING",host_booking_id:"booking-1",
      currency:"RUB",trainer_resource_id:null
    });
    (service as any).consumeLessonMaterials=jest.fn().mockResolvedValue({
      amount:0n,snapshot:{}
    });
    (service as any).lessonRevenueBases=jest.fn().mockResolvedValue({
      earned:0n,billed:0n,paid:0n,list:0n
    });
    (service as any).calculateTrainerCost=jest.fn().mockResolvedValue({
      amount:0n,planId:null,snapshot:{},eligibleRevenue:0n
    });
    (service as any).calculateRoomCost=jest.fn().mockResolvedValue({
      amount:0n,snapshot:{}
    });
    (service as any).audit=jest.fn().mockResolvedValue(undefined);
    return {service,client};
  }

  it("waitlisted makeup student is ignored, with no false credit consumption",async()=>{
    const {service,client}=harness([{
      id:"p1",status:"WAITLIST",package_id:null,
      makeup_credit_id:"credit-1",charge_minor:"0"
    }]);
    const result=await service.completeLesson(ctx,"lesson-1");
    expect(result.lesson_id).toBe("lesson-1");
    expect(client.query.mock.calls.some(([sql])=>
      String(sql).includes("FROM dance_makeup_credit"))).toBe(false);
  });

  it("missing package redemption blocks close and financial accrual",async()=>{
    const {service,client}=harness([{
      id:"p2",status:"NO_SHOW",package_id:"package-1",
      makeup_credit_id:null,charge_minor:"0"
    }]);
    await expect(service.completeLesson(ctx,"lesson-1"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(client.query.mock.calls.some(([sql])=>
      String(sql).includes("INSERT INTO dance_lesson_profitability"))).toBe(false);
  });
});
