import {BadRequestException} from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";
const ctx={
 tenantId:"11111111-1111-4111-8111-111111111111",
 membershipId:"22222222-2222-4222-8222-222222222222",
 userId:"33333333-3333-4333-8333-333333333333"
};
const healthy={
 branches:2,trainers:54,halls:4,groups:12,directions:12,
 lessons:50,plans:2,coaches_with_services:52,groups_without_resources:0,
 managers:2,contracts:3,coach_payroll:52,clients:17,client_logins:10,
 unverified_charges:0
};
function fixture(counts:Record<string,number>){
 const client={query:jest.fn(async()=>({rows:[counts],rowCount:1}))};
 const database={withTenantTransaction:jest.fn(async(_ctx:unknown,callback:any)=>callback(client))};
 const service=Object.create(DanceStudioService.prototype) as any;
 service.database=database;
 service.requireAll=jest.fn().mockResolvedValue(undefined);
 return {service:service as DanceStudioService,client,database};
}
describe("two-branch dance studio onboarding diagnosis",()=>{
 it("always distinguishes completed data entry from real commercial go-live",async()=>{
   const f=fixture(healthy);
   const response=await f.service.setupDoctor(ctx,"two_branch_52");
   expect(response.checks.every(x=>x.ok)).toBe(true);
   expect(response.operationalSetupComplete).toBe(true);
   expect(response.commercialReady).toBe(false);
   expect(response.externalGates.length).toBeGreaterThanOrEqual(3);
   expect(f.client.query.mock.calls[0][1]).toEqual([ctx.tenantId]);
 });
 it("finds data gaps and gives direct owner next action",async()=>{
   const f=fixture({...healthy,branches:1,trainers:3,groups:0,
     coaches_with_services:0,managers:0,lessons:0,plans:0});
   const result=await f.service.setupDoctor(ctx,"two_branch_52");
   expect(result.operationalSetupComplete).toBe(false);
   expect(result.commercialReady).toBe(false);
   expect(result.nextAction?.id).toBe("branches");
   expect(result.nextAction?.href).toBe("/app/settings");
   expect(result.blockers.map(x=>x.id)).toEqual(expect.arrayContaining([
     "branches","trainers","group","delivery_rules","lessons","managers","plans"
   ]));
   for(const check of result.blockers)expect(check.fix.length).toBeGreaterThan(12);
 });
 it("does not count conflicting bookings or unmatched financial debt as complete",async()=>{
   const f=fixture({...healthy,groups_without_resources:2,unverified_charges:4,
     coach_payroll:20});
   const result=await f.service.setupDoctor(ctx,"two_branch_52");
   expect(result.blockers.some(x=>x.id==="missing_resources")).toBe(true);
   expect(result.warnings.some(x=>x.id==="reconcile")).toBe(true);
   expect(result.warnings.some(x=>x.id==="payroll")).toBe(true);
   expect(result.commercialReady).toBe(false);
 });
 it("rejects unsupported niche scenario before reading tenant data",async()=>{
   const f=fixture(healthy);
   await expect(f.service.setupDoctor(ctx,"unknown"))
     .rejects.toBeInstanceOf(BadRequestException);
   expect(f.database.withTenantTransaction).not.toHaveBeenCalled();
 });
});