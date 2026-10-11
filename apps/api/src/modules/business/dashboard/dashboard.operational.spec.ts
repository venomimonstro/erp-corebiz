import {DashboardService} from "./dashboard.service";
import {VERTICAL_OPERATIONAL_RULES} from "./vertical-operational-rules";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

function harness(salesFindings:number){
  const calls:Array<{sql:string;args:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,args:unknown[]=[])=>{
    calls.push({sql,args});
    if(sql.includes("SELECT id FROM sales_order")&&sql.includes("fulfillment_status"))
      return {rows:Array.from({length:salesFindings},(_,i)=>({
        id:"77777777-7777-4777-8777-"+String(i+1).padStart(12,"0")
      })),rowCount:salesFindings};
    if(sql.includes("SELECT count(*)::text AS count"))
      return {rows:[{count:"0"}],rowCount:1};
    if(sql.includes("SELECT metric_code,value_minor::text"))
      return {rows:[],rowCount:0};
    if(sql.includes("SELECT id,issue_code,reference_id"))
      return {rows:[],rowCount:0};
    return {rows:[],rowCount:0};
  })};
  const database={
    withTenantTransaction:jest.fn(async(_context:unknown,fn:any)=>fn(client))
  };
  return {service:new DashboardService(database as any),calls,client};
}

describe("owner control across all verticals",()=>{
  it("scans every installed business rule with an explicitly tenant-scoped query",async()=>{
    const {service,calls}=harness(0);
    const result=await service.operational(context);
    expect(result).toHaveProperty("issues");
    for(const rule of VERTICAL_OPERATIONAL_RULES){
      const matched=calls.find(c=>c.sql===rule.sql);
      expect(matched).toBeDefined();
      expect(matched?.args).toEqual([context.tenantId]);
    }
    const resolved=new Set(calls
      .filter(c=>c.sql.includes("UPDATE tenant_operational_issue")&&
        /reference_id\s*<>\s*ALL/.test(c.sql))
      .map(c=>String(c.args[1])));
    for(const rule of VERTICAL_OPERATIONAL_RULES){
      expect(resolved).toContain(rule.code);
    }
  });

  it("keeps unknown sales incidents open when scan reaches the limit",async()=>{
    const {service,calls}=harness(201);
    await service.operational(context);
    const inserted=calls.filter(c=>
      c.sql.includes("INSERT INTO tenant_operational_issue")&&
      c.args[1]==="SALES_UNFULFILLED");
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.args[2]).toHaveLength(200);
    const resolveSales=calls.find(c=>
      c.sql.includes("UPDATE tenant_operational_issue")&&
      c.args[1]==="SALES_UNFULFILLED");
    expect(resolveSales).toBeUndefined();
    expect(new Set(inserted[0]?.args[2] as string[]).size).toBe(200);
  });

  it("reconciles all sales incidents when scan is known complete",async()=>{
    const {service,calls}=harness(2);
    await service.operational(context);
    const resolve=calls.find(c=>
      c.sql.includes("UPDATE tenant_operational_issue")&&
      c.args[1]==="SALES_UNFULFILLED");
    expect(resolve).toBeDefined();
    expect(resolve?.args[2]).toHaveLength(2);
  });
});
