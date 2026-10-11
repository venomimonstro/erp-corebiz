import {DanceOperationsService} from "./dance-operations.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
describe("dance studio: operational reconciliation",()=>{
  function build(financial:boolean){
    const sqls:string[]=[];
    const client={query:jest.fn(async(sql:string)=>{
      sqls.push(sql);
      if(sql.includes("AS closed_open_roster"))return {rows:[{
        overbooked:1,closed_open_roster:0,no_profit:2
      }]};
      if(sql.includes("FROM dance_group g"))return {rows:[{overbooked:0}]};
      if(sql.includes("FROM dance_package_redemption"))return {rows:[{stranded:3}]};
      if(sql.includes("FROM dance_makeup_credit"))return {rows:[{stranded:0}]};
      if(sql.includes("FROM dance_student_charge"))return {rows:[{unlinked:1}]};
      if(sql.includes("FROM payroll_statement_review"))return {rows:[{disputes:2}]};
      throw new Error("Unexpected query: "+sql.slice(0,100));
    })};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const auth={
      resolveScope:jest.fn(async(_ctx:unknown,permission:string)=>{
        if(permission==="dance.read")return "all";
        if(permission==="finance.read")return financial?"all":null;
        return null;
      }),
      membershipIdsForScope:jest.fn(async()=>null)
    };
    return {service:new DanceOperationsService(db as any,auth as any),sqls};
  }

  it("detects stranded package credits and overbooked lessons",async()=>{
    const {service}=build(true);
    const result=await service.health(ctx);
    expect(result.status).toBe("ACTION_REQUIRED");
    expect(result.risks.map(r=>r.code)).toEqual([
      "STRANDED_PACKAGES","OVERBOOKED_LESSONS","UNLINKED_CHARGES",
      "MISSING_PROFITABILITY","PAYROLL_DISPUTES"
    ]);
    expect(result.totalIssues).toBe(9);
  });

  it("never executes invoice or payroll queries for read-only instructors",async()=>{
    const {service,sqls}=build(false);
    const result=await service.health(ctx);
    expect(result.canViewFinance).toBe(false);
    expect(result.risks.some(r=>r.code==="UNLINKED_CHARGES"||
      r.code==="PAYROLL_DISPUTES")).toBe(false);
    expect(sqls.some(sql=>sql.includes("FROM dance_student_charge")||
      sql.includes("FROM payroll_statement_review"))).toBe(false);
  });
});
