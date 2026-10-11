import {ForbiddenException} from "@nestjs/common";
import {DanceEconomicsService} from "./dance-economics.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

describe("dance charge authorization",()=>{
  it("never returns client debts to a trainer with dance.read only",async()=>{
    const database={withTenantTransaction:jest.fn()};
    const authorization={
      resolveScope:jest.fn(async (_ctx:unknown,permission:string)=>
        permission==="dance.read"?"own":null),
      membershipIdsForScope:jest.fn(async()=>[ctx.membershipId])
    };
    const service=new DanceEconomicsService(database as any,authorization as any,{} as any);
    await expect(service.charges(ctx)).rejects.toBeInstanceOf(ForbiddenException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
