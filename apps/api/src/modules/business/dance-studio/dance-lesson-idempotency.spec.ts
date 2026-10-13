import {ConflictException} from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";

const tenant="11111111-1111-4111-8111-111111111111";
const context={
  tenantId:tenant,
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const group="44444444-4444-4444-8444-444444444444";
const trainer="55555555-5555-4555-8555-555555555555";
const room="66666666-6666-4666-8666-666666666666";
const service="77777777-7777-4777-8777-777777777777";
const startsAt="2026-10-21T13:00:00.000Z";
const request={
  groupId:group,lessonType:"GROUP" as const,
  serviceId:service,trainerResourceId:trainer,
  roomResourceId:room,startsAt,durationMinutes:60,
  roomCapacityUnits:1,capacity:14,
  idempotencyKey:"dance-idempotency-test-1234"
};
function fixture(){
  const queries:string[]=[];
  const row={
    id:"88888888-8888-4888-8888-888888888888",
    version:1,status:"OPEN_FOR_BOOKING",
    group_id:group,lesson_type:"GROUP",service_id:service,
    trainer_resource_id:trainer,room_resource_id:room,
    room_zone_id:null,room_capacity_units:1,
    starts_at:new Date(startsAt),
    ends_at:new Date("2026-10-21T14:00:00.000Z"),capacity:14
  };
  const client={
    query:jest.fn(async(sql:string)=>{
      queries.push(sql);
      if(sql.includes("pg_advisory_xact_lock"))
        return {rows:[{}],rowCount:1};
      if(sql.includes("FROM dance_lesson l")&&
        sql.includes("b.idempotency_key"))
        return {rows:[row],rowCount:1};
      throw new Error("Unexpected SQL: "+sql);
    })
  };
  const instance=Object.create(DanceStudioService.prototype) as any;
  const replay=(input:any)=>
    instance.createLessonTx(client,context,null,input);
  return {replay,queries,client,row};
}
describe("Dance idempotent lessons and leased room safety",()=>{
  it("same group, trainer, room and time returns the original lesson",async()=>{
    const {replay,queries}=fixture();
    await expect(replay(request)).resolves.toMatchObject({
      id:"88888888-8888-4888-8888-888888888888",version:1
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("pg_advisory_xact_lock");
  });
  it.each([
    ["time",{startsAt:"2026-10-21T15:00:00.000Z"}],
    ["group",{groupId:"99999999-9999-4999-8999-999999999999"}],
    ["room",{roomResourceId:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}],
    ["trainer",{trainerResourceId:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}],
    ["duration",{durationMinutes:90}],
    ["capacity",{capacity:17}],
    ["room allocation",{roomCapacityUnits:3}],
    ["format",{lessonType:"RENTAL_EVENT"}],
    ["service",{serviceId:"cccccccc-cccc-4ccc-8ccc-cccccccccccc"}]
  ])("rejects same-key reuse for changed %s",async(_label,changed)=>{
    const {replay,queries}=fixture();
    await expect(replay({...request,...changed}))
      .rejects.toBeInstanceOf(ConflictException);
    expect(queries).toHaveLength(2);
  });
  it("rejects changed rental room for same event key",async()=>{
    const {replay,row}=fixture();
    row.group_id=null;
    row.lesson_type="RENTAL_EVENT";
    row.trainer_resource_id=null;
    await expect(replay({
      idempotencyKey:request.idempotencyKey,
      groupId:undefined,lessonType:"RENTAL_EVENT",
      serviceId:service,roomResourceId:room,
      startsAt,durationMinutes:60,capacity:14
    })).resolves.toHaveProperty("id");
    await expect(replay({
      idempotencyKey:request.idempotencyKey,
      lessonType:"RENTAL_EVENT",serviceId:service,
      roomResourceId:"dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      startsAt,durationMinutes:60,capacity:14
    })).rejects.toBeInstanceOf(ConflictException);
  });
});
