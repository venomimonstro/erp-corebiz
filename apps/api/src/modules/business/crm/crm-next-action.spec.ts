import {BadRequestException,ConflictException,NotFoundException} from "@nestjs/common";
import {CrmService} from "./crm.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const dealId="44444444-4444-4444-8444-444444444444";
const taskId="55555555-5555-4555-8555-555555555555";
const input={title:"Позвонить клиенту",dueAt:"2030-01-01T12:00:00.000Z",
  idempotencyKey:"action_123456789"};
describe("CRM next-action deal security",()=>{
  const valid={...input,dueAt:new Date(Date.now()+86400000).toISOString()};
  function setup(options:{visible?:boolean;retry?:boolean;scope?:string}={}){
    const sql:string[]=[];
    const q=jest.fn(async(text:string)=>{
      sql.push(text);
      if(text.includes("SELECT id,responsible_membership_id FROM crm_deal"))
        return {rows:options.visible===false?[]:[{
          id:dealId,responsible_membership_id:ctx.membershipId
        }],rowCount:options.visible===false?0:1};
      if(text.includes("SELECT task_id,payload_fingerprint FROM crm_next_action"))
        return {rows:[],rowCount:0};
      if(text.includes("INSERT INTO task("))
        return {rows:[{id:taskId}],rowCount:1};
      return {rows:[],rowCount:1};
    });
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>
      fn({query:q}))};
    const auth={
      resolveScope:jest.fn().mockResolvedValue(options.scope??"own"),
      membershipIdsForScope:jest.fn().mockResolvedValue([ctx.membershipId])
    };
    return {service:new CrmService(db as any,auth as any),sql,auth};
  }
  it("rejects malformed action before database access",async()=>{
    const t=setup();
    await expect(t.service.nextAction(ctx,dealId,{
      ...valid,idempotencyKey:"short"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(t.sql).toEqual([]);
  });
  it("fails closed for a deal outside the manager scope",async()=>{
    const t=setup({visible:false});
    await expect(t.service.nextAction(ctx,dealId,valid))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(t.sql.some(q=>q.includes("INSERT INTO task"))).toBe(false);
  });
  it("writes actual linked task, activity and next_action in one tenant transaction",async()=>{
    const t=setup();
    const result=await t.service.nextAction(ctx,dealId,valid);
    expect(result.taskId).toBe(taskId);
    expect(t.sql.some(q=>q.includes("INSERT INTO task("))).toBe(true);
    expect(t.sql.some(q=>q.includes("INSERT INTO crm_next_action"))).toBe(true);
    expect(t.sql.some(q=>q.includes("UPDATE crm_deal SET next_action_at"))).toBe(true);
    expect(t.sql.some(q=>q.includes("INSERT INTO crm_activity"))).toBe(true);
    expect(t.auth.membershipIdsForScope).toHaveBeenCalledWith(ctx,"own");
  });
});
