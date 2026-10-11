import {ActionQueueService} from "./action-queue.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
type Grant={permission_code:string;scope:"own"|"team"|"branch"|"all"};

function fixture(grants:Grant[]){
  const queries:string[]=[];
  const client={query:jest.fn(async(sql:string)=>{
    queries.push(sql);
    if(sql.includes("SELECT EXISTS(")&&sql.includes("dashboard.owner.read"))
      return {rows:[{permitted:false}]};
    if(sql.includes("UPDATE action_queue_user_state"))
      return {rows:[],rowCount:0};
    if(sql.includes("SELECT DISTINCT rp.permission_code,rp.scope"))
      return {rows:grants};
    if(sql.includes("FROM tenant_operational_issue"))
      return {rows:[{
        id:"issue-1",issue_code:"FINANCE_OVERDUE",
        first_seen_at:new Date("2026-10-10T09:00:00Z")
      }]};
    if(sql.includes("FROM action_queue_user_state"))
      return {rows:[]};
    if(sql.includes("FROM finance_bank_statement_line")||
       sql.includes("FROM accounting_compliance_obligation")||
       sql.includes("FROM marketing_alert_event"))
      return {rows:[]};
    throw new Error("Unexpected SQL: "+sql.slice(0,140));
  })};
  const database={withTenantTransaction:jest.fn(async(_context:unknown,fn:any)=>fn(client))};
  const service=new ActionQueueService(database as any,{} as any,{} as any);
  return {service,queries};
}

describe("cross-vertical incident access scopes",()=>{
  it.each(["own","team","branch"] as const)(
    "does not expose a company-wide debt alert on finance.%s permission",async scope=>{
      const {service,queries}=fixture([{permission_code:"finance.read",scope}]);
      const result=await service.queue(context);
      expect(result.items).toEqual([]);
      expect(queries.some(sql=>sql.includes("FROM tenant_operational_issue")))
        .toBe(false);
    }
  );

  it("full finance access includes actionable unpaid obligations",async()=>{
    const {service,queries}=fixture([{permission_code:"finance.read",scope:"all"}]);
    const result=await service.queue(context);
    expect(queries.some(sql=>sql.includes("issue_code=ANY($2::text[])"))).toBe(true);
    expect(result.items[0]?.sourceKey).toBe("operational:issue-1");
    expect(result.items[0]?.severity).toBe("WARNING");
  });

  it("no partial accounting scope can leak corporate tax deadlines",async()=>{
    const {service,queries}=fixture([
      {permission_code:"accounting.compliance.read",scope:"own"}
    ]);
    expect((await service.queue(context)).items).toEqual([]);
    expect(queries.some(sql=>sql.includes("FROM accounting_compliance_obligation")))
      .toBe(false);
  });
});
