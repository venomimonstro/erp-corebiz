import {ForbiddenException} from "@nestjs/common";
import {DanceCustomerPortalService} from "./dance-customer-portal.service";
const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const payer="44444444-4444-4444-8444-444444444444";
const studentParty="55555555-5555-4555-8555-555555555555";
const studentId="66666666-6666-4666-8666-666666666666";
function fixture(permission:string|null="own",identity=true){
  const calls:Array<{sql:string;args:unknown[]}>= [];
  const client={
    query:jest.fn(async(sql:string,args:unknown[])=>{
      calls.push({sql,args});
      if(sql.includes("FROM dance_customer_account a"))
        return {rows:identity?[{party_id:payer,display_name:"Parent"}]:[],rowCount:identity?1:0};
      if(sql.includes("FROM dance_student s")&&sql.includes("party_relationship"))
        return {rows:[{id:studentId,party_id:studentParty,
          display_name:"Child",status:"ACTIVE"}],rowCount:1};
      if(sql.includes("FROM dance_group_member gm"))
        return {rows:[{student_id:studentId,group_name:"Hip-hop"}],rowCount:1};
      if(sql.includes("FROM dance_lesson_participant lp"))
        return {rows:[{student_id:studentId,lesson_id:"lesson-id"}],rowCount:1};
      if(sql.includes("FROM service_package sp"))
        return {rows:[{id:"package",plan_name:"10 visits"}],rowCount:1};
      if(sql.includes("FROM dance_student_charge c"))
        return {rows:[{student_id:studentId,amount_minor:"700000",
          paid_minor:"0",remaining_minor:"700000"}],rowCount:1};
      throw new Error("Unexpected SQL: "+sql.slice(0,80));
    })
  };
  const database={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>
    cb(client))};
  const authorization={
    resolveScope:jest.fn(async(_ctx:unknown,p:string)=>p==="dance.portal.read"
      ?permission:p==="dance.write"?"all":p==="users.manage"?"all":null)
  };
  return {instance:new DanceCustomerPortalService(database as any,authorization as any),
    calls,client,database,authorization};
}
describe("Dance family customer portal, no insecure client supplied IDs",()=>{
  it("requires a minimal own-scope customer permission",async()=>{
    const {instance,database}=fixture(null);
    await expect(instance.self(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("denies unlinked accounts even when their JWT is active",async()=>{
    const {instance}=fixture("own",false);
    await expect(instance.self(ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });
  it("uses authenticated tenant/member/user + server-linked payer to fetch family",async()=>{
    const {instance,calls}=fixture();
    const result=await instance.self(ctx);
    expect(result.person.name).toBe("Parent");
    expect(result.students.map(x=>x.id)).toEqual([studentId]);
    expect(result.groups).toHaveLength(1);
    expect(result.visits).toHaveLength(1);
    expect(result.packages).toHaveLength(1);
    expect(result.charges[0].remaining_minor).toBe("700000");
    const identity=calls.find(x=>x.sql.includes("FROM dance_customer_account a"));
    expect(identity?.args).toEqual([ctx.tenantId,ctx.membershipId,ctx.userId]);
    expect(identity?.sql).toContain("another.role_id<>mr.role_id");
    const authorized=calls.find(x=>x.sql.includes("party_relationship"));
    expect(authorized?.args).toEqual([ctx.tenantId,payer]);
    for(const call of calls.filter(x=>x.sql.includes("ANY($2::uuid[])"))){
      const expectedId=call.sql.includes("FROM service_package sp")
        ?studentParty:studentId;
      expect(call.args[1]).toEqual(expect.arrayContaining([expectedId]));
      expect(JSON.stringify(call.args)).not.toContain("other-tenant");
    }
  });
  it("cannot link arbitrary customer identity without management rights",async()=>{
    const f=fixture();
    f.authorization.resolveScope=jest.fn().mockResolvedValue("own");
    await expect(f.instance.link(ctx,{
      membershipId:ctx.membershipId,partyId:payer
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("rejects client-controlled malformed membership and party IDs",async()=>{
    const {instance}=fixture();
    await expect(instance.link(ctx,{
      membershipId:"abc",partyId:payer
    })).rejects.toThrow("Укажите пользователя");
  });
  it("restricts the account directory to authorized owner and tenant",async()=>{
    const f=fixture();
    (f.client.query as jest.Mock).mockImplementation(async(sql:string,args:unknown[])=>{
      f.calls.push({sql,args});
      if(sql.includes("FROM dance_customer_account a")){
        return {rows:[{membership_id:ctx.membershipId,
          display_name:"Parent",status:"ACTIVE"}],rowCount:1};
      }
      throw new Error("Unexpected SQL");
    });
    const result=await f.instance.accounts(ctx);
    expect(result).toHaveLength(1);
    expect(f.calls[0]!.args).toEqual([ctx.tenantId]);
    expect(f.calls[0]!.sql).toContain("a.tenant_id=$1");
    f.authorization.resolveScope=jest.fn().mockResolvedValue("own");
    await expect(f.instance.accounts(ctx)).rejects
      .toBeInstanceOf(ForbiddenException);
  });
  it("revokes portal access transactionally without deleting attendance",async()=>{
    const f=fixture();
    (f.client.query as jest.Mock).mockImplementation(async(sql:string,args:unknown[])=>{
      f.calls.push({sql,args});
      if(sql.includes("UPDATE dance_customer_account"))
        return {rows:[{id:"revoked-binding"}],rowCount:1};
      if(sql.includes("INSERT INTO audit_event"))
        return {rows:[],rowCount:1};
      throw new Error("Unexpected SQL");
    });
    const result=await f.instance.revoke(ctx,ctx.membershipId);
    expect(result).toEqual({revoked:true});
    const revoke=f.calls.find(x=>x.sql.includes("UPDATE dance_customer_account"));
    expect(revoke?.args).toEqual([ctx.tenantId,ctx.membershipId]);
    expect(revoke?.sql).toContain("status='REVOKED'");
    expect(f.calls.some(x=>x.sql.includes("DELETE FROM dance_student"))).toBe(false);
    expect(f.calls.some(x=>x.sql.includes("dance.portal_revoked"))).toBe(true);
  });
  it("rejects malformed or unauthorized revocation",async()=>{
    const f=fixture();
    await expect(f.instance.revoke(ctx,"invalid-uuid")).rejects.toThrow();
    expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
    f.authorization.resolveScope=jest.fn().mockResolvedValue("own");
    await expect(f.instance.revoke(ctx,ctx.membershipId))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
  });

});
