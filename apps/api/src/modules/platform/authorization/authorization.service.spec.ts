import {AuthorizationService} from "./authorization.service";
import type {TenantContext} from "@corebiz/contracts";

const context:TenantContext={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

describe("cross-vertical permission resolution",()=>{
  function service(scope:"all"|"branch"|"team"|"own"|null){
    const client={query:jest.fn(async()=>({rows:[{scope}]}))};
    const db={withTenantTransaction:jest.fn(async (_ctx:unknown,cb:any)=>cb(client))};
    return {service:new AuthorizationService(db as any),client,db};
  }
  it.each(["all","branch","team","own"] as const)(
    "keeps a wildcard authorization at its real %s scope",async scope=>{
      const {service:auth,client}=service(scope);
      expect(await auth.resolveScope(context,"inventory.read")).toBe(scope);
      const sql=String(client.query.mock.calls[0][0]);
      expect(sql).toContain("CASE max(");
      expect(sql).toContain("rp.permission_code IN ('*',$3)");
      expect(sql).toContain("tm.user_id=$4 AND tm.status='ACTIVE'");
      expect(client.query.mock.calls[0][1]).toEqual([
        context.tenantId,context.membershipId,"inventory.read",context.userId
      ]);
    }
  );
  it("denies a missing role permission",async()=>{
    const {service:auth}=service(null);
    expect(await auth.resolveScope(context,"accounting.write")).toBeNull();
    expect(await auth.hasPermission(context,"accounting.write")).toBe(false);
  });
  it("uses the highest matching permission scope across simultaneous roles",async()=>{
    const {service:auth,client}=service("branch");
    expect(await auth.resolveScope(context,"sales.read")).toBe("branch");
    expect(client.query.mock.calls[0][0]).toMatch(/WHEN 'branch' THEN 3/);
    expect(client.query.mock.calls[0][0]).toMatch(/WHEN 'own' THEN 1/);
  });
});
