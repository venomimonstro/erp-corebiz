import {ConflictException} from "@nestjs/common";
import {BookingService} from "./booking.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const bookingId="44444444-4444-4444-8444-444444444444";

describe("service / dance shared booking boundary",()=>{
  function serviceForDanceHost(){
    const queries:Array<string>=[];
    const service=Object.create(BookingService.prototype) as any;
    const client={query:jest.fn(async(sql:string)=>{
      queries.push(sql);
      if(sql.includes("FROM dance_lesson"))return {rows:[{id:"linked-lesson"}],rowCount:1};
      if(sql.includes("FROM service_booking"))return {rows:[{
        id:bookingId,service_id:"service",party_id:null,asset_id:null,
        starts_at:new Date("2026-10-13T10:00:00Z"),
        created_at:new Date("2026-10-12T10:00:00Z"),currency:"RUB",
        price_minor_snapshot:"50000",status:"CONFIRMED",
        duration_minutes_snapshot:60,version:1
      }],rowCount:1};
      return {rows:[],rowCount:0};
    })};
    service.database={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    service.serviceScope=jest.fn().mockResolvedValue(null);
    service.assertBookingAccess=jest.fn().mockResolvedValue(undefined);
    return {service,client,queries};
  }
  it("rescheduling a dance host through service endpoint is blocked",async()=>{
    const {service,queries}=serviceForDanceHost();
    await expect(service.reschedule(context,bookingId,{
      startsAt:"2026-10-13T11:00:00Z",version:1
    })).rejects.toBeInstanceOf(ConflictException);
    expect(queries.some(sql=>sql.includes("UPDATE service_booking"))).toBe(false);
  });
  it("completing a dance host via generic service endpoint is blocked",async()=>{
    const {service,queries}=serviceForDanceHost();
    await expect(service.setStatus(context,bookingId,"COMPLETED",1))
      .rejects.toBeInstanceOf(ConflictException);
    expect(queries.some(sql=>sql.includes("UPDATE service_booking"))).toBe(false);
  });
  it("a generic party attachment cannot create a second dance lesson charge",async()=>{
    const {service,queries}=serviceForDanceHost();
    await expect(service.attachParty(context,bookingId,"55555555-5555-4555-8555-555555555555"))
      .rejects.toBeInstanceOf(ConflictException);
    expect(queries.some(sql=>sql.includes("INSERT INTO dance_student_charge")||
      sql.includes("INSERT INTO service_booking_charge"))).toBe(false);
  });
});
