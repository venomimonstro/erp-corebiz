import {DanceStudioService} from "./dance-studio.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

describe("dance studio dashboard: role and finance isolation",()=>{
  function harness(financial:boolean){
    const queries:string[]=[];
    const client={
      query:jest.fn(async(sql:string)=>{
        queries.push(sql);
        if(sql.includes("AS unclosed_past_lessons"))return {
          rows:[{
            unclosed_past_lessons:2,attended_without_payment_source:1,
            completed_without_profitability:1,completed_without_trainer_accrual:1,
            lesson_waitlist:0,over_capacity:0
          }]
        };
        return {rows:[],rowCount:0};
      })
    };
    const database={
      withTenantTransaction:jest.fn(async (_context:unknown,fn:any)=>fn(client))
    };
    const authorization={
      resolveScope:jest.fn(async(_context:unknown,permission:string)=>{
        if(permission==="dance.read")return "all";
        if(permission==="finance.read")return financial?"all":null;
        return null;
      }),
      membershipIdsForScope:jest.fn(async()=>null)
    };
    return {service:new DanceStudioService(database as any,authorization as any),
      client,queries};
  }

  it("shows only operational data to teachers without company-finance permission",async()=>{
    const {service,queries}=harness(false);
    const result=await service.dashboard(ctx);
    expect(result.canViewFinancials).toBe(false);
    expect(result.debt).toBeNull();
    expect(result.monthEconomics).toBeNull();
    expect(result.economicsByProgram).toEqual([]);
    expect(result.economicsByTrainer).toEqual([]);
    expect(result.attention.unclosed_past_lessons).toBe(2);
    expect(queries.some(x=>x.includes("dance_lesson_profitability"))).toBe(false);
    expect(queries.some(x=>x.includes("dance_student_charge"))).toBe(false);
    expect(queries.some(x=>x.includes("trainer_payroll_statement"))).toBe(false);
  });

  it("allows finance readers to access owner economy",async()=>{
    const {service,queries}=harness(true);
    const result=await service.dashboard(ctx);
    expect(result.canViewFinancials).toBe(true);
    expect(result.debt).toBeDefined();
    expect(result.monthEconomics).toBeDefined();
    expect(result.monthEconomics?.owner_margin_minor).toBe("0");
    expect(queries.some(x=>x.includes("dance_lesson_profitability"))).toBe(true);
  });

  it("selects today's schedule using the studio resource timezone",async()=>{
    const {service,queries}=harness(false);
    await service.dashboard(ctx);
    const lessonQuery=queries.find(q=>q.includes("AS lesson_timezone"));
    expect(lessonQuery).toContain("AT TIME ZONE");
    expect(lessonQuery).toContain("coalesce(rr.timezone,tr.timezone,'Europe/Moscow')");
  });
});
