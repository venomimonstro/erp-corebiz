import {orderPickRoute,warehouseStockIndicators} from "./wms-operations.logic";
import {WmsOperationsService} from "./wms-operations.service";

describe("MoySklad-style inventory promise on CoreBiz ledger",()=>{
  it("never treats confirmed supplier arrival as stock already physically available",()=>{
    const x=warehouseStockIndicators({
      physicalMilli:"10000",reservedMilli:"8000",
      expectedMilli:"20000",safetyMilli:"1000",sourcingEnabled:true
    });
    expect(x).toMatchObject({
      physicalMilli:"10000",reservedMilli:"8000",expectedMilli:"20000",
      availableNowMilli:"2000",projectedPlanningMilli:"22000",
      sellableNowMilli:"1000",recommendedPurchaseMilli:"0",
      stockIsPhysicalOnly:true
    });
  });
  it("reports over-reservation and replenishment without silent clamping",()=>{
    const x=warehouseStockIndicators({
      physicalMilli:"1000",reservedMilli:"3000",
      expectedMilli:"0",safetyMilli:"2000",sourcingEnabled:true
    });
    expect(x).toMatchObject({
      availableNowMilli:"-2000",sellableNowMilli:"0",
      recommendedPurchaseMilli:"4000",state:"RESERVATION_SHORTAGE"
    });
  });
  it("does not accidentally activate sales of disabled SKU",()=>{
    const x=warehouseStockIndicators({
      physicalMilli:"4000",reservedMilli:"0",
      expectedMilli:"1000",safetyMilli:"0",sourcingEnabled:false
    });
    expect(x.sellableNowMilli).toBe("0");
    expect(x.recommendedPurchaseMilli).toBe("0");
  });
  it("preserves exact bigint quantities above JS safe integer",()=>{
    const x=warehouseStockIndicators({
      physicalMilli:"9007199254740993000",reservedMilli:"1000",
      expectedMilli:"1000",safetyMilli:"0",sourcingEnabled:true
    });
    expect(x.availableNowMilli).toBe("9007199254740992000");
    expect(x.projectedPlanningMilli).toBe("9007199254740993000");
  });
  it("rejects malformed SQL quantity rather than hiding data corruption",()=>{
    expect(()=>warehouseStockIndicators({
      physicalMilli:"bad",reservedMilli:"0",
      expectedMilli:"0",safetyMilli:"0",sourcingEnabled:true
    })).toThrow("Invalid physical");
  });
});
describe("AXELOT-inspired guided picker route",()=>{
  const sample=[
    {taskId:"b",zonePriority:2,pickSequence:10,priority:50,
      locationCode:"Z2-R1",skuCode:"B",quantityMilli:"1000",
      orderId:null,status:"OPEN"},
    {taskId:"c",zonePriority:1,pickSequence:40,priority:2,
      locationCode:"Z1-R3",skuCode:"C",quantityMilli:"2000",
      orderId:"order",status:"CLAIMED"},
    {taskId:"a",zonePriority:1,pickSequence:5,priority:99,
      locationCode:"Z1-R1",skuCode:"A",quantityMilli:"3000",
      orderId:null,status:"OPEN"}
  ];
  it("orders zone priority and pick sequence without mutating the input",()=>{
    const ordered=orderPickRoute(sample);
    expect(ordered.map(x=>x.taskId)).toEqual(["a","c","b"]);
    expect(sample[0].taskId).toBe("b");
  });
});
describe("tenant-safe read-only warehouse operations",()=>{
  const tenant={
    tenantId:"11111111-1111-4111-8111-111111111111",
    userId:"22222222-2222-4222-8222-222222222222",
    membershipId:"33333333-3333-4333-8333-333333333333"
  };
  const warehouseId="44444444-4444-4444-8444-444444444444";
  function fixture(){
    const calls:Array<{sql:string;args:unknown[]}>= [];
    const client={query:jest.fn(async(sql:string,args:unknown[])=>{
      calls.push({sql,args});
      if(sql.includes("FROM warehouse\n"))return {rows:[{name:"Store A",branch_id:null}],rowCount:1};
      if(sql.includes("FROM warehouse WHERE"))return {rows:[{id:warehouseId}],rowCount:1};
      if(sql.includes("FROM all_skus sku_set"))return {
        rows:[{sku_id:"sku",sku_code:"SKU",product_name:"Product",
          physical_milli:"1000",reserved_milli:"500",expected_milli:"0",
          safety_milli:"0",sourcing_enabled:true}],rowCount:1
      };
      if(sql.includes("FROM warehouse_task t"))return {
        rows:[{id:"task",priority:100,status:"OPEN",zone_priority:1,
          pick_sequence:12,location_code:"A-1-1",sku_code:"SKU",
          quantity_milli:"500",order_id:null}],rowCount:1
      };
      throw new Error("Unexpected SQL");
    })};
    const db={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>cb(client))};
    return {service:new WmsOperationsService(db as any),calls};
  }
  it("enforces warehouse and tenant in one transaction and produces ledger-based stock",async()=>{
    const {service,calls}=fixture();
    const stock=await service.stock(tenant,warehouseId);
    expect(stock.items).toHaveLength(1);
    expect(stock.items[0].availableNowMilli).toBe("500");
    expect(stock.stockSource).toBe("INVENTORY_LEDGER");
    expect(stock.planningExpectedIsNotPhysical).toBe(true);
    expect(calls.every(x=>x.args[0]===tenant.tenantId)).toBe(true);
    expect(calls.every(x=>/^\s*(SELECT|WITH)/i.test(x.sql))).toBe(true);
  });
  it("cannot request another company's wave route without querying tenant scope",async()=>{
    const {service,calls}=fixture();
    const route=await service.pickRoute(tenant,warehouseId);
    expect(route.tasks[0].locationCode).toBe("A-1-1");
    expect(route.globallyOptimal).toBe(false);
    expect(calls.every(x=>x.args[0]===tenant.tenantId)).toBe(true);
    expect(calls.some(x=>x.sql.includes("t.task_type='PICK'"))).toBe(true);
  });
  it("rejects invalid identifiers before issuing SQL",async()=>{
    const {service,calls}=fixture();
    await expect(service.stock(tenant,"bad")).rejects.toThrow("Некорректный склад");
    await expect(service.pickRoute(tenant,warehouseId,"invalid")).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
