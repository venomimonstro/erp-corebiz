import {ConflictException} from "@nestjs/common";
import {ProjectsService} from "./projects.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const projectId="44444444-4444-4444-8444-444444444444";

function fixture(blockers:{
  milestones:number;tasks:number;deliverables:number;approvals:number
}){
  const queries:string[]=[];
  const client={
    query:jest.fn(async(sql:string)=>{
      queries.push(sql);
      if(sql.includes("FROM work_project\n"))return {
        rows:[{status:"ACTIVE",version:3}],rowCount:1
      };
      if(sql.includes("AS milestones"))return {rows:[{
        milestones:String(blockers.milestones),tasks:String(blockers.tasks),
        deliverables:String(blockers.deliverables),
        approvals:String(blockers.approvals)
      }],rowCount:1};
      if(sql.includes("UPDATE work_project"))return {
        rows:[{status:"COMPLETED",version:4}],rowCount:1
      };
      return {rows:[],rowCount:0};
    })
  };
  const service=Object.create(ProjectsService.prototype) as any;
  service.membershipIdsForScope=jest.fn().mockResolvedValue(null);
  service.assertWritableProject=jest.fn().mockResolvedValue(undefined);
  service.audit=jest.fn().mockResolvedValue(undefined);
  service.database={withTenantTransaction:jest.fn(async(_context:unknown,fn:any)=>fn(client))};
  return {service,queries,client};
}

describe("web studios and agencies: honest project completion",()=>{
  it.each([
    [{milestones:1,tasks:0,deliverables:0,approvals:0},"milestone"],
    [{milestones:0,tasks:1,deliverables:0,approvals:0},"task"],
    [{milestones:0,tasks:0,deliverables:1,approvals:0},"unaccepted deliverable"],
    [{milestones:0,tasks:0,deliverables:0,approvals:1},"pending client sign-off"]
  ])("cannot close when %s is unresolved",async(blockers,_label)=>{
    const {service,queries}=fixture(blockers);
    await expect(service.changeStatus(context,projectId,{
      status:"COMPLETED",version:3
    })).rejects.toBeInstanceOf(ConflictException);
    expect(queries.some(sql=>sql.includes("UPDATE work_project"))).toBe(false);
  });
  it("completes after milestones, tasks, deliverables and approvals are resolved",async()=>{
    const {service,queries}=fixture({
      milestones:0,tasks:0,deliverables:0,approvals:0
    });
    const result=await service.changeStatus(context,projectId,{
      status:"COMPLETED",version:3
    });
    expect(result).toEqual({status:"COMPLETED",version:4});
    expect(queries.some(sql=>sql.includes("work_project_client_approval"))).toBe(true);
    expect(service.audit).toHaveBeenCalledTimes(1);
  });
});
