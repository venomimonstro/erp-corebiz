import {BadRequestException} from "@nestjs/common";
import {CatalogService} from "./catalog.service";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
function harness(canViewCosts:boolean,items:Array<Record<string,unknown>>=[]){
  const query=jest.fn(async(sql:string,params:unknown[])=>{
    if(sql.includes("membership_role mr"))return {rows:[{allowed:canViewCosts}]};
    if(sql.includes("FROM sku s")&&sql.includes("ORDER BY s.id"))
      return {rows:items};
    throw new Error("Unexpected query: "+sql.slice(0,70));
  });
  const database={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn({query}))};
  return {service:new CatalogService(database as any),query,database};
}
const row=(i:number)=>({
  product_id:"product-"+i,product_name:"Товар "+i,kind:"STOCKABLE",
  variant_id:"variant-"+i,variant_name:"Основной",
  sku_id:"aaaaaaaa-aaaa-4aaa-8aaa-"+i.toString().padStart(12,"0"),
  sku_code:"SKU-"+i,barcode:null,
  sale_price_minor:"90000",cost_price_minor:"60000",
  currency:"RUB",track_inventory:true
});

describe("catalog million-SKU cursor and confidential cost fields",()=>{
  it("returns a stable 100-item page and next cursor without COUNT and OFFSET",async()=>{
    const rows=Array.from({length:101},(_,i)=>row(i));
    const {service,query}=harness(true,rows);
    const result=await service.page(ctx,{limit:100});
    expect(result.items).toHaveLength(100);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(rows[99].sku_id);
    const call=query.mock.calls.find(args=>args[0].includes("ORDER BY s.id"));
    expect(call?.[1]).toEqual([ctx.tenantId,null,null,101]);
    expect(call?.[0]).not.toContain("OFFSET");
    expect(call?.[0]).not.toContain("COUNT(*)");
  });

  it("never exposes purchase cost to catalog-only employees",async()=>{
    const {service}=harness(false,[row(1)]);
    const result=await service.page(ctx,{limit:10});
    expect(result.items[0].costPriceMinor).toBeNull();
    expect(result.items[0].salePriceMinor).toBe("90000");
  });

  it("does not treat a narrow own-scope finance grant as company-wide cost access",async()=>{
    const {service,query}=harness(false,[row(1)]);
    await service.page(ctx,{limit:25});
    const permissionCheck=query.mock.calls.find(args=>
      args[0].includes("membership_role mr"));
    expect(permissionCheck?.[0]).toContain("rp.scope='all'");
    expect(permissionCheck?.[0]).toContain("catalog.cost.read");
    expect(permissionCheck?.[1]).toEqual([ctx.tenantId,ctx.membershipId]);
  });

  it("allows authorized accountants to inspect cost",async()=>{
    const {service}=harness(true,[row(1)]);
    const result=await service.page(ctx,{limit:10});
    expect(result.items[0].costPriceMinor).toBe("60000");
  });

  it.each([
    [{limit:10000},"Размер страницы"],
    [{limit:0},"Размер страницы"],
    [{query:"a"},"от 3"],
    [{query:"x".repeat(101)},"от 3"],
    [{cursor:"';DROP TABLE sku;--"},"курсор"]
  ])("fails closed on invalid search input",async(input,message)=>{
    const {service,database}=harness(false);
    await expect(service.page(ctx,input as any)).rejects.toThrow(message);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });
});
