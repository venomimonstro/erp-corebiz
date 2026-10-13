import {BadRequestException,ForbiddenException} from "@nestjs/common";
import {DanceBudgetService} from "./dance-budget.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const fixture=(finance="all",dance="all")=>{
  const client={query:jest.fn(async(_sql:string,params:unknown[])=>({
    rows:[
      {branch_id:"44444444-4444-4444-8444-444444444444",
        branch_name:"Москва, филиал А",bookings:2,
        booked_minor:"240000",receivable_minor:"240000",
        settled_minor:"0",unverified:0},
      {branch_id:"55555555-5555-4555-8555-555555555555",
        branch_name:"Москва, филиал Б",bookings:1,
        booked_minor:"100000",receivable_minor:"100000",
        settled_minor:"40000",unverified:0}
    ],rowCount:2
  }))};
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>
    cb(client))};
  const auth={resolveScope:jest.fn(async(_ctx:unknown,code:string)=>
    code==="finance.read"?finance:dance)};
  return {subject:new DanceBudgetService(db as any,auth as any),db,client};
};
describe("Dance separate sublease reporting",()=>{
  it("keeps two branch room receipts separate from own rental costs",async()=>{
    const f=fixture();
    const result=await f.subject.rentalIncome(ctx,"2026-10");
    expect(result.month).toBe("2026-10");
    expect(result.totals).toEqual({
      bookings:3,bookedMinor:"340000",receivableMinor:"340000",
      settledMinor:"40000",unverified:0
    });
    expect(result.branches).toHaveLength(2);
    const [sql,args]=f.client.query.mock.calls[0];
    expect(sql).toContain("b.delivery_format_snapshot='RENTAL'");
    expect(sql).toContain("b.status<>'CANCELLED'");
    expect(sql).toContain("b.tenant_id=$1");
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain("count(c.id)=0 AND b.price_minor_snapshot>0");
    expect(sql).toContain("AT TIME ZONE 'Europe/Moscow'");
    expect(args).toEqual([ctx.tenantId,"2026-10-01"]);
  });
  it.each([
    ["no finance",null,"all"],
    ["read-only branch", "branch","all"],
    ["no studio","all",null]
  ])("denies %s",async(_reason,fin,dan)=>{
    const f=fixture(fin as any,dan as any);
    await expect(f.subject.rentalIncome(ctx,"2026-10"))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("does not execute database SQL for malformed periods",async()=>{
    const f=fixture();
    await expect(f.subject.rentalIncome(ctx,"2026-13"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(f.db.withTenantTransaction).not.toHaveBeenCalled();
  });
});
