import { DashboardService } from "./dashboard.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
type Activation = {verticalCode:string;completed:boolean;
  milestones:Array<{key:string;href:string;done:boolean;firstValue?:boolean}>};

function mockActivation(profileCode:string,verticalCode:string){
  const queries:string[]=[];
  const query=jest.fn(async(sql:string,params?:unknown[])=>{
    queries.push(sql);
    // Every query remains tenant scoped to the selected session.
    if(params?.length && sql.includes("tenant_id=$1")){
      expect(params[0]).toBe(context.tenantId);
    }
    if(sql.includes("AS profile_code") && sql.includes("AS vertical_code")){
      return {rows:[{profile_code:profileCode,vertical_code:verticalCode}],rowCount:1};
    }
    if(sql.includes("SELECT first_seen_at,first_value_at")){
      return {rows:[{
        first_seen_at:new Date(Date.now()-3600_000),
        first_value_at:null,completed_at:null,dismissed_at:null
      }],rowCount:1};
    }
    if(sql.includes("AS services") && sql.includes("AS trainers")){
      return {rows:[{
        services:1,trainers:1,programs:1,groups:1,students:1,
        plans:1,lessons:1,payroll:0
      }],rowCount:1};
    }
    if(sql.includes("AS vehicles") && sql.includes("AS donors")){
      return {rows:[{vehicles:1,orders:1,donors:0,parts:0,completed:0}],rowCount:1};
    }
    if(sql.includes("AS mapped"))return {rows:[{mapped:1}],rowCount:1};
    if(sql.includes("AS orders") && sql.includes("FROM channel_order_inbox")){
      return {rows:[{orders:1}],rowCount:1};
    }
    if(sql.includes("AS terms"))return {rows:[{terms:1}],rowCount:1};
    if(sql.includes("AS done") && sql.includes("AS owners")){
      return {rows:[{done:0,owners:1}],rowCount:1};
    }
    if(sql.includes("AS published"))return {rows:[{published:1}],rowCount:1};
    if(sql.includes("AS configured"))return {rows:[{configured:1}],rowCount:1};
    if(sql.includes("AS stock"))return {rows:[{stock:1}],rowCount:1};
    if(sql.includes("AS count"))return {rows:[{count:"0"}],rowCount:1};
    return {rows:[],rowCount:0};
  });
  const database={
    withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))
  };
  const service=new DashboardService(database as any);
  return {service,queries};
}

describe("real business first day",()=>{
  it("guides dance owners through service, trainer, group, student, plan, lesson and pay rule",async()=>{
    const x=mockActivation("SERVICE","DANCE_FITNESS");
    const result=await x.service.activation(context) as Activation;
    const ids=result.milestones.map(step=>step.key);
    expect(ids).toEqual([
      "dance-service","dance-trainer","dance-program","dance-group",
      "dance-student","dance-plan","dance-lesson","dance-payroll"
    ]);
    expect(result.milestones.find(s=>s.key==="dance-lesson")?.firstValue).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.milestones[0]?.href).toBe("/app/dance/setup");
    expect(x.queries.some(sql=>sql.includes("FROM dance_student"))).toBe(true);
  });

  it("uses vehicle and work-order milestones rather than a generic salon booking",async()=>{
    const x=mockActivation("SERVICE","AUTO_SERVICE");
    const result=await x.service.activation(context) as Activation;
    expect(result.milestones.map(s=>s.key)).toEqual([
      "auto-client","auto-vehicle","auto-order","auto-delivery"
    ]);
    expect(result.milestones[2]?.firstValue).toBe(true);
  });

  it("makes wholesale terms an actual required setup action",async()=>{
    const x=mockActivation("TRADE","WHOLESALE_B2B");
    const result=await x.service.activation(context) as Activation;
    expect(result.milestones.find(s=>s.key==="b2b-terms")?.done).toBe(true);
    expect(result.milestones.find(s=>s.key==="b2b-order")?.href)
      .toBe("/app/sales/orders");
  });

  it("does not declare first WMS value from merely opening a task",async()=>{
    const x=mockActivation("WAREHOUSE_3PL","WAREHOUSE_3PL");
    const result=await x.service.activation(context) as Activation;
    expect(result.milestones.find(s=>s.key==="task-done")?.done).toBe(false);
    expect(result.milestones.find(s=>s.key==="task-done")?.firstValue).toBe(true);
  });

  it("counts imported marketplace orders, not manually confirmed orders",async()=>{
    const x=mockActivation("ECOMMERCE","MARKETPLACE_SELLER");
    const result=await x.service.activation(context) as Activation;
    expect(result.milestones.map(s=>s.key)).toEqual([
      "market-sku","market-account","market-mapping","market-order"
    ]);
    expect(result.milestones[3]?.done).toBe(true);
    expect(x.queries.some(sql=>sql.includes("status='IMPORTED'"))).toBe(true);
  });
});
