import {DashboardService} from "./dashboard.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

function fixture(serviceGrant:boolean){
  const sqls:string[]=[];
  const client={query:jest.fn(async(sql:string)=>{
    sqls.push(sql);
    if(sql.includes("JOIN tenant_role"))
      return {rows:[{code:"SERVICE_STAFF"}]};
    if(sql.includes("JOIN role_permission"))
      return {rows:serviceGrant?
        [{permission_code:"service.read",scope:"own"}]:[]};
    if(sql.includes("SELECT count(DISTINCT b.id)::text"))
      return {rows:[{count:"3"}]};
    if(sql.includes("SELECT count(*)::text AS count")&&sql.includes("FROM task"))
      return {rows:[{count:"2"}]};
    if(sql.includes("SELECT DISTINCT b.id,s.name AS service,b.ends_at"))
      return {rows:[{
        id:"booking-overdue-1",service:"Стрижка",ends_at:new Date("2026-10-11T12:00:00Z")
      }]};
    if(sql.includes("SELECT DISTINCT")&&sql.includes("b.starts_at"))
      return {rows:[{
        id:"booking-upcoming",business_number:"SB-1",
        starts_at:new Date("2026-10-12T12:00:00Z"),
        customer:"Клиент",service:"Маникюр"
      }]};
    throw new Error("Unexpected SQL: "+sql.slice(0,130));
  })};
  const database={
    withTenantTransaction:jest.fn(async (_ctx:unknown,fn:any)=>fn(client))
  };
  return {service:new DashboardService(database as any),sqls};
}

describe("service industry personal workday",()=>{
  it("cannot load service appointments after permission revocation",async()=>{
    const {service,sqls}=fixture(false);
    expect((await service.memberWorkspace(context)).workspace).toBe("VIEWER");
    expect(sqls.some(q=>q.includes("FROM service_booking b"))).toBe(false);
  });

  it("handles local resource calendar days and excludes dance host bookings",async()=>{
    const {service,sqls}=fixture(true);
    const result=await service.memberWorkspace(context);
    expect(result.workspace).toBe("SERVICE");
    const dateQuery=sqls.find(q=>q.includes("count(DISTINCT b.id)"))!;
    expect(dateQuery).toContain("AT TIME ZONE coalesce(r.timezone,'Europe/Moscow')");
    expect(dateQuery).toContain("l.host_booking_id=b.id");
    const queries=sqls.filter(q=>q.includes("SELECT DISTINCT")&&q.includes("FROM service_booking b"));
    expect(queries).toHaveLength(2);
    for(const q of queries){
      expect(q).toContain("r.membership_id=$2");
      expect(q).toContain("l.host_booking_id=b.id");
    }
  });

  it("keeps overdue salon visits visible ahead of the upcoming appointment list",async()=>{
    const {service}=fixture(true);
    const result=await service.memberWorkspace(context);
    expect(result.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({label:"Незакрытые визиты",value:"1"})
    ]));
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id:"booking-overdue:booking-overdue-1",
        severity:"WARNING",href:"/app/service/bookings"
      }),
      expect.objectContaining({
        id:"booking:booking-upcoming",
        severity:"INFO"
      })
    ]));
  });
});
