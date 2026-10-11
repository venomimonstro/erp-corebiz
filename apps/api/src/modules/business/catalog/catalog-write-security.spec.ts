import {BadRequestException,ForbiddenException} from "@nestjs/common";
import {CatalogService} from "./catalog.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};

function harness(canWriteCost:boolean){
  const sqlCalls:string[]=[];
  let created=0;
  const query=jest.fn(async(sql:string)=>{
    sqlCalls.push(sql);
    if(sql.includes("membership_role mr"))
      return {rows:[{allowed:canWriteCost}],rowCount:1};
    if(sql.includes("SELECT 1 FROM sku"))
      return {rows:[],rowCount:0};
    if(sql.includes("INSERT INTO product(")||sql.includes("INSERT INTO product_variant(")||
       sql.includes("INSERT INTO sku(")){
      created++;
      return {rows:[{id:`record-${created}`,code:"SC-100"}],rowCount:1};
    }
    if(sql.includes("INSERT INTO audit_event"))return {rows:[],rowCount:1};
    throw new Error("Unexpected SQL "+sql.slice(0,95));
  });
  const database={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))};
  return {service:new CatalogService(database as any),database,query,sqlCalls};
}

describe("catalog cost-price security and input integrity",()=>{
  it("allows a catalog employee to create a product at a public selling price",async()=>{
    const {service,sqlCalls}=harness(false);
    const result=await service.create(ctx,{
      name:"Товар",sku:"SC-100",salePriceMinor:"350000"
    });
    expect(result.sku).toBe("SC-100");
    expect(sqlCalls.some(sql=>sql.includes("INSERT INTO product("))).toBe(true);
    expect(sqlCalls.some(sql=>sql.includes("membership_role mr"))).toBe(false);
  });

  it("rejects unauthorized cost modification BEFORE any product or SKU insert",async()=>{
    const {service,sqlCalls}=harness(false);
    await expect(service.create(ctx,{
      name:"Товар",sku:"SC-100",salePriceMinor:"350000",
      costPriceMinor:"210000"
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(sqlCalls.some(sql=>sql.includes("INSERT INTO product("))).toBe(false);
    expect(sqlCalls.some(sql=>sql.includes("INSERT INTO sku("))).toBe(false);
  });

  it("permits cost pricing for authorized all-scope finance roles",async()=>{
    const {service,sqlCalls}=harness(true);
    await service.create(ctx,{name:"Товар",costPriceMinor:"210000"});
    expect(sqlCalls.some(sql=>sql.includes("INSERT INTO sku("))).toBe(true);
  });

  it.each([
    [{name:"X"},"название"],
    [{name:"Товар",kind:"UNEXPECTED"},"тип товара"],
    [{name:"Товар",salePriceMinor:"9".repeat(19)},"цена"],
    [{name:"Товар",costPriceMinor:"-1"},"цена"],
    [{name:"Товар",sku:"X".repeat(129)},"длинный"],
    [{name:"Товар",description:"A".repeat(10001)},"длинный"]
  ])("rejects malformed or oversized product payloads before SQL",async(input,message)=>{
    const {service,database}=harness(false);
    await expect(service.create(ctx,input as any)).rejects.toThrow(message);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
