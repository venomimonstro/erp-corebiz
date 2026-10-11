import {GlobalSearchService} from "./global-search.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const teamMember="44444444-4444-4444-8444-444444444444";
const branchMember="55555555-5555-4555-8555-555555555555";

function harness(grants:Array<{permission_code:string;scope:string}>){
  const examined:Array<{sql:string;values:unknown[]}>= [];
  const client={
    query:jest.fn(async(sql:string,values:unknown[]=[])=>{
      examined.push({sql,values});
      if(sql.includes("FROM membership_role mr")&&sql.includes("SELECT rp.permission_code"))
        return {rows:grants};
      if(sql.includes("FROM team_membership actor")&&sql.includes("JOIN team_membership members"))
        return {rows:[{membership_id:teamMember}]};
      if(sql.includes("JOIN team peers_teams"))
        return {rows:[{membership_id:branchMember}]};
      if(sql.includes("FROM party p")&&sql.includes("p.responsible_membership_id"))
        return {rows:[]};
      if(sql.includes("FROM crm_deal d"))return {rows:[]};
      if(sql.includes("FROM sales_order o"))return {rows:[]};
      if(sql.includes("FROM purchase_order po"))return {rows:[]};
      if(sql.includes("FROM sku s"))return {rows:[]};
      throw new Error("Unexpected SQL: "+sql.slice(0,110));
    })
  };
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
  const runtime={
    acquire:jest.fn(async()=>({leaseKey:"test-lease"})),
    release:jest.fn(async()=>undefined)
  };
  return {service:new GlobalSearchService(db as any,runtime as any),examined,runtime};
}

describe("global search multi-tenant authorization and scoped employee lists",()=>{
  it("returns no cross-domain results or actions without an active permission",async()=>{
    const {service,examined,runtime}=harness([]);
    const result=await service.search(context,"example");
    expect(result.items).toEqual([]);
    expect(result.quickActions).toEqual([]);
    expect(examined.every(x=>!x.sql.includes("FROM sku s"))).toBe(true);
    expect(runtime.release).toHaveBeenCalledTimes(1);
  });
  it("only queries own sales orders for an own-scoped grant",async()=>{
    const {service,examined}=harness([{permission_code:"sales.read",scope:"own"}]);
    await service.search(context,"example");
    const sales=examined.find(x=>x.sql.includes("FROM sales_order o"));
    expect(sales?.values[3]).toEqual([context.membershipId]);
    expect(sales?.sql).toContain("responsible_membership_id=ANY($4::uuid[])");
  });
  it("includes team members for a team-scoped CRM grant",async()=>{
    const {service,examined}=harness([{permission_code:"crm.read",scope:"team"}]);
    await service.search(context,"example");
    const crm=examined.find(x=>x.sql.includes("FROM crm_deal d"));
    expect(crm?.values[3]).toEqual(expect.arrayContaining([context.membershipId,teamMember]));
    expect(crm?.values[3]).not.toContain(branchMember);
  });
  it("includes employees in the same branch for a branch-scoped grant",async()=>{
    const {service,examined}=harness([{permission_code:"procurement.read",scope:"branch"}]);
    await service.search(context,"example");
    const purchases=examined.find(x=>x.sql.includes("FROM purchase_order po"));
    expect(purchases?.values[3]).toEqual(expect.arrayContaining([context.membershipId,teamMember,branchMember]));
  });
  it("does not expose organization-wide product names to a catalog own role",async()=>{
    const {service,examined}=harness([{permission_code:"catalog.read",scope:"own"}]);
    await service.search(context,"sensitive");
    expect(examined.some(x=>x.sql.includes("FROM sku s"))).toBe(false);
  });
  it("only the all catalog role can search tenant-wide SKU data",async()=>{
    const {service,examined}=harness([{permission_code:"catalog.read",scope:"all"}]);
    await service.search(context,"article");
    expect(examined.some(x=>x.sql.includes("FROM sku s"))).toBe(true);
  });
  it("never upgrades an own-scoped wildcard to full catalog visibility",async()=>{
    const {service,examined}=harness([{permission_code:"*",scope:"own"}]);
    await service.search(context,"private");
    expect(examined.some(x=>x.sql.includes("FROM sku s"))).toBe(false);
  });
});
