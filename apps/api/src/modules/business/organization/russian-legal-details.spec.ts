import {BadRequestException} from "@nestjs/common";
import {validRussianInn,validRussianKpp} from "./russian-legal-details";
import {OrganizationService} from "./organization.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};

describe("Owner registration: Russian legal details",()=>{
  it("accepts checksum-valid 10-digit and 12-digit INN",()=>{
    expect(validRussianInn("1234567894")).toBe(true);
    expect(validRussianInn("123456789047")).toBe(true);
  });
  it("rejects malformed, all-zero and bad-checksum INN",()=>{
    for(const value of [
      "", "0000000000", "1234567890","123456789048",
      "12345678","123456789x","1234567890123"
    ])expect(validRussianInn(value)).toBe(false);
  });
  it("validates KPP as format only",()=>{
    expect(validRussianKpp("770701001")).toBe(true);
    expect(validRussianKpp("7707AA001")).toBe(true);
    expect(validRussianKpp("7707@A001")).toBe(false);
    expect(validRussianKpp("77070101")).toBe(false);
  });
  it("refuses malformed owner-supplied identifiers before any DB write",async()=>{
    const db={withTenantTransaction:jest.fn()};
    const service=new OrganizationService(db as any);
    for(const body of [
      {name:"Example",inn:"1234567890"},
      {name:"Example",inn:1234567894},
      {name:"Example",inn:"123456789047",kpp:"770701001"},
      {name:"Example",kpp:"invalid"},
      {name:3}
    ]){
      await expect(service.createLegalEntity(ctx,body as any))
        .rejects.toBeInstanceOf(BadRequestException);
    }
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("normalizes KPP and preserves test INN without numeric conversion",async()=>{
    const queries:unknown[][]=[];
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,callback:any)=>
      callback({query:jest.fn(async(_sql:string,args:any[])=>{
        queries.push(args);
        return {rows:[{id:"x",name:"Example"}],rowCount:1};
      })}))};
    const service=new OrganizationService(db as any);
    await service.createLegalEntity(ctx,{
      name:" Example ",inn:"1234567894",kpp:"7707aa001"
    });
    expect(queries[0]?.[2]).toBe("1234567894");
    expect(queries[0]?.[3]).toBe("7707AA001");
  });
});
