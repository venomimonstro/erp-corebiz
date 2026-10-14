import {BadRequestException,ForbiddenException} from "@nestjs/common";
import {CatalogService} from "./catalog.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const productId="44444444-4444-4444-8444-444444444444";
const skuId="55555555-5555-4555-8555-555555555555";
const variantId="66666666-6666-4666-8666-666666666666";

function fixture(
  responses:(sql:string)=>{rows:unknown[];rowCount:number}
){
  const query=jest.fn(async(sql:string)=>{
    return responses(sql);
  });
  const database={
    withTenantTransaction:jest.fn(async(_ctx:unknown,fn:(client:any)=>unknown)=>
      fn({query}))
  };
  return {catalog:new CatalogService(database as any),query,database};
}
describe("Shared product card: rights and data integrity",()=>{
  it("does not reveal purchase cost to catalog-only readers",async()=>{
    const {catalog}=fixture(sql=>{
      if(sql.includes("SELECT p.id AS product_id"))
        return {rows:[{
          product_id:productId,sku_id:skuId,variant_id:variantId,
          name:"Product",sale_price_minor:"250000",cost_price_minor:"110000",
          attributes:{Color:"Black"}
        }],rowCount:1};
      if(sql.includes("SELECT EXISTS("))
        return {rows:[{allowed:false}],rowCount:1};
      if(sql.includes("FROM inventory_balance b"))
        return {rows:[],rowCount:0};
      throw new Error("Unexpected SQL "+sql);
    });
    const details=await catalog.detail(context,productId);
    expect(details.cost_price_minor).toBeNull();
    expect(details.sale_price_minor).toBe("250000");
  });

  it("rejects editing secret purchase prices without finance permission",async()=>{
    const {catalog,query}=fixture(sql=>{
      if(sql.includes("FOR UPDATE OF p,v,s"))
        return {rows:[{variant_id:variantId,sku_id:skuId}],rowCount:1};
      if(sql.includes("SELECT EXISTS("))
        return {rows:[{allowed:false}],rowCount:1};
      throw new Error("Unexpected SQL "+sql);
    });
    await expect(catalog.update(context,productId,{
      costPriceMinor:"110000"
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(query.mock.calls.some(([sql])=>
      String(sql).includes("UPDATE sku"))).toBe(false);
  });

  it("prevents archiving a product while stock exists",async()=>{
    const {catalog,query}=fixture(sql=>{
      if(sql.includes("SELECT id FROM product"))
        return {rows:[{id:productId}],rowCount:1};
      if(sql.includes("FROM inventory_balance b"))
        return {rows:[{one:1}],rowCount:1};
      throw new Error("Unexpected SQL "+sql);
    });
    await expect(catalog.archive(context,productId))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(query.mock.calls.some(([sql])=>
      String(sql).includes("UPDATE product SET status"))).toBe(false);
  });

  it("archives product, variants and SKU together when no open orders",async()=>{
    const events:string[]=[];
    const {catalog}=fixture(sql=>{
      events.push(sql);
      if(sql.includes("SELECT id FROM product"))
        return {rows:[{id:productId}],rowCount:1};
      if(sql.includes("SELECT 1 FROM inventory_balance")||
         sql.includes("SELECT 1 FROM sku s JOIN product_variant")||
         sql.includes("SELECT 1 FROM purchase_order_line"))
        return {rows:[],rowCount:0};
      if(sql.includes("UPDATE")||sql.includes("INSERT INTO audit_event"))
        return {rows:[],rowCount:1};
      throw new Error("Unexpected SQL "+sql);
    });
    await expect(catalog.archive(context,productId))
      .resolves.toEqual({archived:true});
    expect(events.some(sql=>sql.includes("UPDATE sku SET status='ARCHIVED'")))
      .toBe(true);
    expect(events.some(sql=>sql.includes("UPDATE product_variant SET status='ARCHIVED'")))
      .toBe(true);
    expect(events.some(sql=>sql.includes("UPDATE product SET status='ARCHIVED'")))
      .toBe(true);
  });

  it("rejects invalid characteristics before database writes",async()=>{
    const {catalog,database}=fixture(()=>
      {throw new Error("Should not query the database")});
    await expect(catalog.update(context,productId,{
      attributes:{Color:"x".repeat(501)}
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("rejects invalid prices, including signed values and floating point",async()=>{
    const {catalog,database}=fixture(()=>
      {throw new Error("Should not query the database")});
    for(const cost of ["-1","1.5","9000000000000000000"]){
      await expect(catalog.update(context,productId,{
        costPriceMinor:cost
      })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
