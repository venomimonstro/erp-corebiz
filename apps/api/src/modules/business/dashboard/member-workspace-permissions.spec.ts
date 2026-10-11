import {DashboardService} from "./dashboard.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
type Grant={permission_code:string;scope:"own"|"team"|"branch"|"all"};
function harness(roles:string[],grants:Grant[]){
  const calls:string[]=[];
  const client={query:jest.fn(async(sql:string,_params?:unknown[])=>{
    calls.push(sql);
    if(sql.includes("FROM membership_role mr")&&sql.includes("JOIN tenant_role"))
      return {rows:roles.map(code=>({code}))};
    if(sql.includes("FROM membership_role mr")&&sql.includes("JOIN role_permission"))
      return {rows:grants};
    if(sql.includes("FROM work_project p")&&sql.includes("count(*)::text"))
      return {rows:[{count:"2",overdue:"1"}]};
    if(sql.includes("SELECT count(*)::text AS count FROM task"))
      return {rows:[{count:"4"}]};
    if(sql.includes("FROM work_project p")&&sql.includes("ORDER BY p.due_on"))
      return {rows:[{id:"project-a",name:"Сайт клиента",due_on:"2026-10-10"}]};
    throw new Error("Unexpected query in denied/agency workspace: "+sql.slice(0,120));
  })};
  const db={withTenantTransaction:jest.fn(async (_ctx:unknown,fn:any)=>fn(client))};
  return {service:new DashboardService(db as any),calls,client};
}

describe("cross-vertical employee workspace authorization",()=>{
  it("warehouse role without WMS grant cannot read other people's warehouse queue",async()=>{
    const {service,calls}=harness(["WAREHOUSE"],[]);
    const result=await service.memberWorkspace(context);
    expect(result.workspace).toBe("VIEWER");
    expect(result.metrics).toEqual([]);
    expect(calls.some(q=>q.includes("FROM warehouse_task"))).toBe(false);
  });
  it("finance role with own-scoped grant never sees company-wide payable balances",async()=>{
    const {service,calls}=harness(["FINANCE"],[
      {permission_code:"finance.read",scope:"own"}
    ]);
    const result=await service.memberWorkspace(context);
    expect(result.workspace).toBe("VIEWER");
    expect(calls.some(q=>q.includes("FROM financial_obligation"))).toBe(false);
  });
  it("revoked sales permission blocks sales totals even when SALES_HEAD role remains",async()=>{
    const {service,calls}=harness(["SALES_HEAD"],[
      {permission_code:"crm.read",scope:"all"},
      {permission_code:"tasks.read",scope:"all"}
    ]);
    expect((await service.memberWorkspace(context)).workspace).toBe("VIEWER");
    expect(calls.some(q=>q.includes("FROM sales_order"))).toBe(false);
  });
  it("agency and web studio employees only receive their assigned projects",async()=>{
    const {service,calls}=harness(["VIEWER"],[
      {permission_code:"projects.read",scope:"own"},
      {permission_code:"tasks.read",scope:"own"}
    ]);
    const result=await service.memberWorkspace(context);
    expect(result.workspace).toBe("PROJECTS");
    expect(result.title).toBe("Мои проекты и задачи");
    expect((result.actions as any[])[0].href).toBe("/app/projects/project-a");
    const projectQueries=calls.filter(q=>q.includes("FROM work_project p"));
    expect(projectQueries).toHaveLength(2);
    for(const sql of projectQueries){
      expect(sql).toContain("responsible_membership_id=$2");
      expect(sql).toContain("work_project_member");
      expect(sql).toContain("membership_id=$2");
    }
  });
});
