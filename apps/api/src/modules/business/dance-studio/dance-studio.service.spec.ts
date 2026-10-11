import {BadRequestException} from "@nestjs/common";
import {DanceStudioService} from "./dance-studio.service";

describe("dance studio — commercial safety regressions",()=>{
  const context={
    tenantId:"00000000-0000-4000-8000-000000000001",
    userId:"00000000-0000-4000-8000-000000000002",
    membershipId:"00000000-0000-4000-8000-000000000003"
  };
  const authorization={
    resolveScope:jest.fn(),
    membershipIdsForScope:jest.fn().mockResolvedValue(null)
  };
  const database={withTenantTransaction:jest.fn()};
  let studio:DanceStudioService;
  beforeEach(()=>{
    authorization.resolveScope.mockReset().mockResolvedValue("all");
    database.withTenantTransaction.mockReset();
    studio=new DanceStudioService(database as any,authorization as any);
  });

  it("rejects noninteger group capacity before accessing the database",async()=>{
    await expect(studio.createGroup(context as any,{
      programId:"p",trainerResourceId:"t",name:"Contemporary",
      capacity:15.5,breakEvenMembers:7
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("rejects invalid dates and reversed group terms before a write",async()=>{
    await expect(studio.createGroup(context as any,{
      programId:"p",trainerResourceId:"t",name:"Hip-hop",
      capacity:12,startsOn:"2026-02-31"
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(studio.createGroup(context as any,{
      programId:"p",trainerResourceId:"t",name:"Hip-hop",
      capacity:12,startsOn:"2026-10-21",endsOn:"2026-10-01"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("does not generate a year of lessons from a mistaken import",async()=>{
    await expect(studio.generateGroupLessons(context as any,"group-1",{
      from:"2026-01-01",to:"2026-12-31"
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("blocks invalid attendance status and stale version before changing payment reservations",async()=>{
    await expect(studio.markAttendance(context as any,"l","p",{
      status:"PAID" as any,version:1
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(studio.markAttendance(context as any,"l","p",{
      status:"ATTENDED",version:0
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("redacts family balances for trainers even when the database returns them",async()=>{
    authorization.resolveScope.mockImplementation(async (_c:any,permission:string)=>
      permission==="finance.read"?null:"all");
    database.withTenantTransaction.mockImplementation(async (_ctx:any,fn:any)=>
      fn({query:async()=>({rows:[{
        id:"student-1",display_name:"Ученик",family_debt_minor:"500000",
        family_overdue_minor:"120000",debt_minor:"500000",overdue_minor:"120000",
        active_groups:2,family_children_count:2,family_overdue_count:1,
        overdue_count:1,open_charge_count:2
      }]})}));
    const rows=await studio.students(context as any);
    expect(rows[0].display_name).toBe("Ученик");
    expect(rows[0].active_groups).toBe(2);
    expect(rows[0].family_debt_minor).toBeNull();
    expect(rows[0].family_overdue_minor).toBeNull();
    expect(rows[0].open_charge_count).toBeNull();
  });
  it("preserves a financial reader's debt values",async()=>{
    database.withTenantTransaction.mockImplementation(async (_ctx:any,fn:any)=>
      fn({query:async()=>({rows:[{id:"s",family_debt_minor:"500000"}]})}));
    const rows=await studio.students(context as any);
    expect(rows[0].family_debt_minor).toBe("500000");
  });
});
