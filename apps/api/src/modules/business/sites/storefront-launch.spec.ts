import { BadRequestException } from "@nestjs/common";
import { StorefrontService } from "./storefront.service";
import { SitesService } from "./sites.service";

const context = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  membershipId: "33333333-3333-4333-8333-333333333333"
};
const siteId = "44444444-4444-4444-8444-444444444444";

function storefront(database:any) {
  return new StorefrontService(database,{} as any,{} as any,{} as any);
}

describe("ecommerce launch safety", () => {
  it("rejects malformed public catalog paging before SQL",async()=>{
    const database={query:jest.fn(),withTenantTransaction:jest.fn()};
    const service=storefront(database);
    await expect(service.catalog("shop",{limit:100000}))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.catalog("shop",{cursor:"../../other"}))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.catalog("shop",{q:"a"}))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(database.query).not.toHaveBeenCalled();
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
  });

  it("pages after the SKU limit and never exposes costs",async()=>{
    const rows=[1,2,3].map(n=>({
      product_id:siteId,product_name:"Product",description:null,image_url:null,
      sku_id:"00000000-0000-4000-8000-00000000000"+n,
      sku_code:"SKU"+n,barcode:null,
      sale_price_minor:"1200",currency:"RUB",atp_milli:"1000"
    }));
    const pageQuery=jest.fn(async(_sql:string,_params:unknown[])=>({rows}));
    const database={
      query:jest.fn(async()=>({rows:[{
        site_id:siteId,tenant_id:context.tenantId,
        responsible_membership_id:context.membershipId,currency:"RUB"
      }]})),
      withTenantTransaction:jest.fn(async(_context:any,run:any)=>
        run({query:pageQuery}))
    };
    const result:any=await storefront(database).catalog("shop",{limit:2,q:"Prod"});
    expect(result.products).toHaveLength(2);
    expect(result.nextCursor).toBe(rows[1]!.sku_id);
    const [sql,params]=pageQuery.mock.calls[0] as [string,unknown[]];
    expect(sql).toContain("WITH items AS");
    expect(sql).toContain("AND s.currency=$2");
    expect(sql).toContain("w.status='ACTIVE'");
    expect(sql).toContain("COALESCE(ip.enabled,true)");
    expect(sql).toContain("ORDER BY s.id");
    expect(sql).not.toContain("cost_price_minor");
    expect(params).toEqual([context.tenantId,"RUB",null,"Prod",3]);
  });

  it("discloses launch blockers, even when the technical checklist is complete",async()=>{
    const row={
      public_slug:"test-shop",store_enabled:true,home_published:true,
      catalog_published:true,priced_sku:true,available_sku:true,
      primary_domain:"shop.example.com",
      acquiring_configured:true,fiscal_configured:true,delivery_configured:true
    };
    const database={
      withTenantTransaction:jest.fn(async(_context:any,run:any)=>
        run({query:jest.fn(async()=>({rows:[row]}))}))
    };
    const result:any=await storefront(database).readiness(context,siteId);
    expect(result.canTestOrders).toBe(true);
    expect(result.canLaunchWithOnlinePayments).toBe(false);
    expect(result.checks.some((check:any)=>
      check.code==="ACQUIRING_CONFIGURED" && check.done)).toBe(true);
    expect(result.checks).toHaveLength(9);
    expect(result.externalBlockers).toHaveLength(4);
    // No PSP is inferred from published pages or a verified domain.
  });

  it("builds a store catalog and storefront config in the same transaction",async()=>{
    const statements:string[]=[];
    const client={query:jest.fn(async(sql:string)=>{
      statements.push(sql);
      if(sql.includes("INSERT INTO site("))return {rows:[{
        id:siteId,code:"shop",public_slug:"shop-unique"
      }]};
      if(sql.includes("INSERT INTO site_page("))return {rows:[{id:siteId}]};
      if(sql.includes("INSERT INTO site_page_version("))return {rows:[{id:siteId}]};
      return {rows:[],rowCount:1};
    })};
    const database={
      withTenantTransaction:jest.fn(async(_context:any,run:any)=>run(client))
    };
    const result=await new SitesService(database as any).createSite(context,{
      name:"My Shop",template:"STORE"
    });
    expect(result.id).toBe(siteId);
    expect(statements.filter(s=>s.includes("INSERT INTO site_block("))).toHaveLength(3);
    expect(statements.some(s=>s.includes("INSERT INTO storefront_config("))).toBe(true);
    expect(database.withTenantTransaction).toHaveBeenCalledTimes(1);
  });
});
