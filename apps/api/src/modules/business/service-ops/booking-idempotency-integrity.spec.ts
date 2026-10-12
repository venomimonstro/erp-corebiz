import {ConflictException} from "@nestjs/common";
import {BookingService} from "./booking.service";

const tenant={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const bookingId="44444444-4444-4444-8444-444444444444";
const master="55555555-5555-4555-8555-555555555555";
const otherMaster="66666666-6666-4666-8666-666666666666";
const input={
  serviceId:"77777777-7777-4777-8777-777777777777",
  startsAt:"2026-10-15T14:00:00.000Z",
  resourceIds:[master],
  partyId:"88888888-8888-4888-8888-888888888888",
  source:"MANUAL" as const,
  idempotencyKey:"original-key-1234567"
};
const existing={
  id:bookingId,business_number:"BOOK-2026-1",version:2,
  service_id:input.serviceId,starts_at:new Date(input.startsAt),
  party_id:input.partyId,asset_id:null,branch_id:null,
  delivery_format_snapshot:"INDIVIDUAL",source:"MANUAL",notes:null
};

function fixture(){
  const client={query:jest.fn(async(sql:string)=>{
    if(sql.includes("FROM service_booking_resource"))
      return {rows:[{resource_id:master,capacity_units:1,zone_id:null}],rowCount:1};
    if(sql.includes("FROM service_booking"))
      return {rows:[existing],rowCount:1};
    throw new Error("unexpected database query: "+sql);
  })};
  const database={
    withTenantTransaction:jest.fn(async(_ctx:unknown,callback:any)=>callback(client))
  };
  const subject=Object.create(BookingService.prototype) as any;
  subject.database=database;
  subject.serviceScope=jest.fn().mockResolvedValue(null);
  subject.assertBookingAccess=jest.fn().mockResolvedValue(undefined);
  subject.getService=jest.fn();
  subject.lockResources=jest.fn();
  return {service:subject as BookingService,subject,client};
}

describe("appointment idempotency input integrity",()=>{
  it("returns the original booking only for the same appointment",async()=>{
    const {service,subject}=fixture();
    const replay=await service.createBooking(tenant,input);
    expect(replay).toEqual({id:bookingId,number:"BOOK-2026-1",version:2});
    expect(subject.assertBookingAccess).toHaveBeenCalled();
    expect(subject.lockResources).not.toHaveBeenCalled();
  });
  it.each([
    ["different time",{startsAt:"2026-10-15T15:00:00.000Z"}],
    ["different service",{serviceId:"99999999-9999-4999-8999-999999999999"}],
    ["different master",{resourceIds:[otherMaster]}],
    ["different client",{partyId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}],
    ["different branch",{branchId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}],
    ["different source",{source:"PHONE" as const}],
    ["different notes",{notes:"Changed notes"}],
    ["different zone",{resources:[{resourceId:master,zoneId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}]}]
  ])("rejects key reuse for %s",async(_label,change)=>{
    const {service,subject}=fixture();
    await expect(service.createBooking(tenant,{...input,...change}))
      .rejects.toBeInstanceOf(ConflictException);
    expect(subject.getService).not.toHaveBeenCalled();
    expect(subject.lockResources).not.toHaveBeenCalled();
  });
});
