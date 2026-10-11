import {GlobalSearchService} from "./global-search.service";

const context={
 tenantId:"11111111-1111-4111-8111-111111111111",
 membershipId:"22222222-2222-4222-8222-222222222222",
 userId:"33333333-3333-4333-8333-333333333333"
};
describe("global search cannot bypass branch/employee data access",()=>{
  it("requires a responsible CRM employee or an explicit all-scope permission",async()=>{
    const queries: Array<{sql:string;args:unknown[]}> = [];
    const client={query:jest.fn(async(sql:string,args:unknown[]=[])=>{
      queries.push({sql,args});
      if(sql.includes("SELECT DISTINCT rp.permission_code"))
        return {rows:[{permission_code:"crm.read"}]};
      return {rows:[]};
    })};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const pressure={
      acquire:jest.fn().mockResolvedValue({leaseKey:"test-lease"}),
      release:jest.fn().mockResolvedValue(undefined)
    };
    const service=new GlobalSearchService(db as any,pressure as any);
    await service.search(context,"Мария");
    const party=queries.find(x=>x.sql.includes("FROM party p\n"));
    expect(party).toBeDefined();
    expect(party?.sql).toContain("p.tenant_id=$1");
    expect(party?.sql).toContain("p.responsible_membership_id=$3");
    expect(party?.sql).toContain("rp.scope='all'");
    expect(party?.args).toEqual([context.tenantId,"%Мария%",context.membershipId]);
  });

  it("never includes unassigned sales and procurement orders for scoped users",async()=>{
    const queries:string[]=[];
    const client={query:jest.fn(async(sql:string)=>{
      queries.push(sql);
      if(sql.includes("SELECT DISTINCT rp.permission_code"))
        return {rows:[
          {permission_code:"sales.read"},{permission_code:"procurement.read"}
        ]};
      return {rows:[]};
    })};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
    const pressure={acquire:jest.fn().mockResolvedValue({leaseKey:"test"}),
      release:jest.fn().mockResolvedValue(undefined)};
    const service=new GlobalSearchService(db as any,pressure as any);
    await service.search(context,"Товар");
    const orders=queries.find(q=>q.includes("FROM sales_order o"));
    const purchases=queries.find(q=>q.includes("FROM purchase_order po"));
    expect(orders).not.toContain("o.responsible_membership_id IS NULL");
    expect(purchases).not.toContain("po.responsible_membership_id IS NULL");
    expect(orders).toContain("o.responsible_membership_id=$3");
    expect(purchases).toContain("po.responsible_membership_id=$3");
  });
});
