import {BadRequestException,NotFoundException} from "@nestjs/common";
import {WmsOperationsService} from "./wms-operations.service";
import {encodeStockCursor} from "./wms-operations.logic";

const tenant={
  tenantId:"11111111-1111-4111-8111-111111111111",
  membershipId:"22222222-2222-4222-8222-222222222222",
  userId:"33333333-3333-4333-8333-333333333333"
};
const warehouseId="44444444-4444-4444-8444-444444444444";
const item=(i:number)=>({
  sku_id:"aaaa0000-0000-4000-8000-"+String(i).padStart(12,"0"),
  sku_code:"SKU-"+String(i).padStart(4,"0"),
  product_name:"Product "+String(i).padStart(4,"0"),
  physical_milli:"5000",reserved_milli:"1000",
  expected_milli:"2000",safety_milli:"3000",sourcing_enabled:true
});
function fixture(options:{warehouse?:boolean;rows?:number}={}){
  const calls:Array<{sql:string;params:unknown[]}>= [];
  const client={
    query:jest.fn(async(sql:string,params:unknown[])=>{
      calls.push({sql,params});
      if(sql.includes("SELECT name FROM warehouse"))
        return {rows:options.warehouse===false?[]:[{name:"Central"}],
          rowCount:options.warehouse===false?0:1};
      if(sql.includes("WITH unique_branch_warehouse"))
        return {rows:Array.from({length:options.rows??11},(_,i)=>item(i)),
          rowCount:options.rows??11};
      throw new Error("unexpected query "+sql);
    })
  };
  const database={withTenantTransaction:jest.fn(async(_ctx:any,fn:any)=>fn(client))};
  return {service:new WmsOperationsService(database as any),client,calls,database};
}
describe("MySklad + AXELOT real-time stock report",()=>{
  it("paginates entire inventory, does not use only first 500 SKUs",async()=>{
    const {service,calls}=fixture({rows:11});
    const report=await service.stockPage(tenant,warehouseId,{
      limit:10,query:"Product",onlyProblems:true
    });
    expect(report.items).toHaveLength(10);
    expect(report.hasMore).toBe(true);
    expect(report.nextCursor).toEqual(expect.any(String));
    expect(report.stockSource).toBe("INVENTORY_LEDGER");
    const statement=calls.find(c=>c.sql.includes("WITH unique_branch_warehouse"))!;
    expect(statement.sql).toContain("LIMIT $8");
    expect(statement.sql).toContain("coalesce(po.destination_warehouse_id,ub.warehouse_id)");
    expect(statement.params).toEqual([
      tenant.tenantId,warehouseId,"Product",true,null,null,null,11
    ]);
    expect(report.items[0]).toMatchObject({
      physicalMilli:"5000",reservedMilli:"1000",expectedMilli:"2000",
      availableNowMilli:"4000",projectedPlanningMilli:"6000",
      stockIsPhysicalOnly:true
    });
  });
  it("binds page cursor to both warehouse and all filters",async()=>{
    const {service,calls,database}=fixture({rows:1});
    const token=encodeStockCursor({
      warehouseId,name:"Product 0009",sku:"SKU-0009",
      skuId:item(9).sku_id,query:"Product",onlyProblems:true
    });
    await expect(service.stockPage(tenant,warehouseId,{
      cursor:token,query:"Another",onlyProblems:true
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(database.withTenantTransaction).not.toHaveBeenCalled();
    const page=await service.stockPage(tenant,warehouseId,{
      cursor:token,query:"Product",onlyProblems:true
    });
    expect(page.hasMore).toBe(false);
    const statement=calls.find(c=>c.sql.includes("WITH unique_branch_warehouse"))!;
    expect(statement.params[4]).toBe("Product 0009");
    expect(statement.params[5]).toBe("SKU-0009");
    expect(statement.params[6]).toBe(item(9).sku_id);
  });
  it("rejects tampered cursor, unknown warehouse, excessive query or limit",async()=>{
    const {service}=fixture({warehouse:false});
    await expect(service.stockPage(tenant,warehouseId,{
      cursor:"!!!"
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.stockPage(tenant,warehouseId,{
      limit:100000
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.stockPage(tenant,warehouseId,{
      query:"Q".repeat(81)
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.stockPage(tenant,warehouseId,{}))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
