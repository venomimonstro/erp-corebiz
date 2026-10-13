import {ForbiddenException} from "@nestjs/common";
import {ResourcesService} from "./resources.service";
const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const resourceId="44444444-4444-4444-8444-444444444444";
function fixture(executive=true){
  const query=jest.fn(async(sql:string)=>{
    if(sql.includes("UPDATE service_resource"))
      return {rows:[{id:resourceId}],rowCount:1};
    if(sql.includes("INSERT INTO audit_event"))
      return {rows:[],rowCount:1};
    throw new Error("Unrecognized SQL: "+sql);
  });
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))};
  const authorization={resolveScope:jest.fn(async()=>executive?"all":"own")};
  const subject=new ResourcesService(db as any,authorization as any);
  (subject as any).serviceScope=jest.fn().mockResolvedValue({
    scope:executive?"all":"own",membershipIds:executive?null:[ctx.membershipId]
  });
  return {subject,db,query};
}
describe("YCLIENTS-style online visibility separate from staff diary",()=>{
  it("allows owner to hide online booking without archiving staff",async()=>{
    const {subject,query}=fixture();
    expect(await subject.updateOnlinePolicy(ctx,resourceId,{
      enabled:false,minimumNoticeMinutes:120
    })).toEqual({enabled:false,minimumNoticeMinutes:120});
    const update=query.mock.calls.find(x=>String(x[0]).includes("UPDATE service_resource"));
    expect(update?.[1]).toEqual([ctx.tenantId,resourceId,false,120]);
    expect(update?.[0]).not.toMatch(/status='ARCHIVED'/);
  });
  it("denies receptionist from changing public booking visibility",async()=>{
    const {subject,db}=fixture(false);
    await expect(subject.updateOnlinePolicy(ctx,resourceId,{
      enabled:false,minimumNoticeMinutes:15
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it.each([-1,10081,3.25,Number.NaN])("rejects invalid advance time %s",
    async value=>{
      const {subject,db}=fixture();
      await expect(subject.updateOnlinePolicy(ctx,resourceId,{
        enabled:true,minimumNoticeMinutes:value
      })).rejects.toThrow("Некорректные настройки");
      expect(db.withTenantTransaction).not.toHaveBeenCalled();
    });
});
