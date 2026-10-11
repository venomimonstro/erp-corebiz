import {BadRequestException,ForbiddenException,NotFoundException} from "@nestjs/common";
import {RolesService} from "./roles.service";
import type {TenantContext} from "@corebiz/contracts";

const context:TenantContext={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const targetId="44444444-4444-4444-8444-444444444444";
const roleId="55555555-5555-4555-8555-555555555555";

describe("RBAC role assignment cannot mint an owner or elevate rights",()=>{
  function harness(args:{role:string;actorOwner:boolean;targetOwner:boolean;
    elevated?:boolean;targetExists?:boolean}){
    const query=jest.fn(async(sql:string,values:unknown[]=[])=>{
      if(sql.includes("SELECT id")&&sql.includes("FROM tenant_membership"))
        return {rows:args.targetExists===false?[]:[{id:targetId}],rowCount:args.targetExists===false?0:1};
      if(sql.includes("SELECT code")&&sql.includes("FROM tenant_role"))
        return {rows:[{code:args.role}],rowCount:1};
      if(sql.includes("SELECT is_owner")&&sql.includes("FOR UPDATE"))
        return {rows:[{is_owner:args.targetOwner}],rowCount:1};
      if(sql.includes("SELECT is_owner")&&sql.includes("status='ACTIVE'"))
        return {rows:[{is_owner:args.actorOwner}],rowCount:1};
      if(sql.includes("SELECT target.permission_code"))
        return {rows:args.elevated?[{permission_code:"finance.read",scope:"all"}]:[],rowCount:args.elevated?1:0};
      if(sql.includes("DELETE FROM membership_role")||
         sql.includes("INSERT INTO membership_role")||
         sql.includes("INSERT INTO audit_event"))return {rows:[],rowCount:1};
      throw new Error("Unexpected query "+sql.slice(0,100));
    });
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))};
    return {service:new RolesService(db as any),query};
  }
  it("refuses ADMIN promoting a colleague to OWNER",async()=>{
    const {service,query}=harness({role:"OWNER",actorOwner:false,targetOwner:false});
    await expect(service.assignRole(context,targetId,roleId))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(query.mock.calls.some(x=>String(x[0]).includes("DELETE FROM membership_role"))).toBe(false);
  });
  it("does not let ADMIN assign all-scope accounting beyond own privileges",async()=>{
    const {service,query}=harness({role:"FINANCE",actorOwner:false,
      targetOwner:false,elevated:true});
    await expect(service.assignRole(context,targetId,roleId))
      .rejects.toBeInstanceOf(ForbiddenException);
    const check=query.mock.calls.find(x=>String(x[0]).includes("SELECT target.permission_code"));
    expect(check?.[0]).toContain("actor_role.membership_id=$3");
    expect(check?.[0]).toContain("own_grant.permission_code IN ('*',target.permission_code)");
    expect(check?.[1]).toEqual([context.tenantId,roleId,context.membershipId]);
  });
  it("permits a delegable role inside the actor's own grant scope",async()=>{
    const {service,query}=harness({role:"SALES_MANAGER",actorOwner:false,targetOwner:false});
    await expect(service.assignRole(context,targetId,roleId)).resolves.toBeUndefined();
    expect(query.mock.calls.some(x=>String(x[0]).includes("INSERT INTO audit_event"))).toBe(true);
  });
  it("allows the verified owner to assign an ordinary role",async()=>{
    const {service}=harness({role:"FINANCE",actorOwner:true,targetOwner:false});
    await expect(service.assignRole(context,targetId,roleId)).resolves.toBeUndefined();
  });
  it("protects the owner membership from losing its role",async()=>{
    const {service}=harness({role:"VIEWER",actorOwner:true,targetOwner:true});
    await expect(service.assignRole(context,targetId,roleId))
      .rejects.toBeInstanceOf(BadRequestException);
  });
  it("rejects cross-tenant or inactive target members",async()=>{
    const {service}=harness({role:"VIEWER",actorOwner:true,targetOwner:false,targetExists:false});
    await expect(service.assignRole(context,targetId,roleId))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
