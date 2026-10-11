import {BadRequestException,ConflictException,NotFoundException} from "@nestjs/common";
import {TenantsService} from "./tenants.service";
import {AuthService} from "../auth/auth.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const roleId="44444444-4444-4444-8444-444444444444";
describe("team invitation security and accept lifecycle",()=>{
  function setup(options:{roleCode?:string;memberExists?:boolean;manager?:boolean;
    elevated?:boolean}={}){
    const executed:string[]=[];
    const query=jest.fn(async(sql:string)=>{
      executed.push(sql);
      if(sql.includes("SELECT 1")&&sql.includes("rp.permission_code IN ('*','users.manage')"))
        return {rows:[],rowCount:options.manager===false?0:1};
      if(sql.includes("JOIN app_user u ON u.id = m.user_id"))
        return {rows:[],rowCount:options.memberExists?1:0};
      if(sql.includes("SELECT code FROM tenant_role"))
        return {rows:[{code:options.roleCode??"WAREHOUSE"}],rowCount:1};
      if(sql.includes("SELECT tm.is_owner"))
        return {rows:[{is_owner:false}],rowCount:1};
      if(sql.includes("SELECT 1 FROM role_permission target"))
        return {rows:[],rowCount:options.elevated?1:0};
      if(sql.includes("INSERT INTO tenant_invitation("))
        return {rows:[{id:"55555555-5555-4555-8555-555555555555",
          expires_at:new Date("2030-01-01T00:00:00.000Z")}],rowCount:1};
      if(sql.includes("UPDATE tenant_invitation SET status='REVOKED'"))
        return {rows:[{id:roleId}],rowCount:1};
      return {rows:[],rowCount:0};
    });
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))};
    return {service:new TenantsService(db as any),executed,db};
  }
  it("rejects invitation without all-company users.manage permission",async()=>{
    const t=setup({manager:false});
    await expect(t.service.createInvitation(ctx,"user@example.com"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(t.executed.some(x=>x.includes("INSERT INTO tenant_invitation("))).toBe(false);
  });
  it("never allows invitation to assign an owner role",async()=>{
    const t=setup({roleCode:"OWNER"});
    await expect(t.service.createInvitation(ctx,"user@example.com",roleId))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(t.executed.some(x=>x.includes("INSERT INTO tenant_invitation("))).toBe(false);
  });
  it("rejects a role with privileges above the invitation manager",async()=>{
    const t=setup({elevated:true});
    await expect(t.service.createInvitation(ctx,"user@example.com",roleId))
      .rejects.toBeInstanceOf(BadRequestException);
  });
  it("only stores a hashed invitation secret and never returns secret on listing",async()=>{
    const t=setup();
    const created=await t.service.createInvitation(ctx,"user@example.com",roleId);
    expect(created.token.length).toBeGreaterThanOrEqual(32);
    expect(t.executed.some(x=>x.includes("INSERT INTO tenant_invitation("))).toBe(true);
    expect(t.executed.some(x=>x.includes("token_hash"))).toBe(true);
  });
  it("rejects invalid revocation identifiers before database use",async()=>{
    const t=setup();
    await expect(t.service.revokeInvitation(ctx,"not-a-uuid"))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(t.executed).toEqual([]);
  });
});
