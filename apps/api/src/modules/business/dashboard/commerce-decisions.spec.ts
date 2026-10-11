import { CommerceDecisionsService } from "./commerce-decisions.service";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};

describe("commerce owner insights remain read-only",()=>{
  it("uses tenant-scoped snapshots and never creates a purchase or moves stock",async()=>{
    const calls:Array<{sql:string;args:unknown[]}>= [];
    const client={query:jest.fn(async(sql:string,args:unknown[]=[])=>{
      calls.push({sql,args});
      if(sql.includes("FROM sales_order WHERE tenant_id"))
        return {rows:[{pending_fulfillment:"6",payment_review:"3"}]};
      if(sql.includes("FROM purchase_order WHERE tenant_id"))
        return {rows:[{count:"2"}]};
      if(sql.includes("WITH demand AS"))
        return {rows:[{
          sku_id:"44444444-4444-4444-8444-444444444444",
          sku:"SKU-1",product_name:"Товар",
          ordered_milli_30d:"30000",sellable_milli:"3000",inbound_milli:"2000",
          target_milli_14d:"14000",suggested_milli:"9000",
          stock_cover_days:"3.0",urgency:"CRITICAL"
        }]};
      throw new Error("Unexpected SQL: "+sql);
    })};
    const db={withTenantTransaction:jest.fn(async(_context:unknown,handler:any)=>handler(client))};
    const snapshot=await new CommerceDecisionsService(db as any).snapshot(context);
    expect(snapshot.pendingFulfillment).toBe(6);
    expect(snapshot.paymentReview).toBe(3);
    expect(snapshot.openSupplierOrders).toBe(2);
    expect(snapshot.replenishment[0]?.suggestedMilli).toBe("9000");
    expect(snapshot.targetDays).toBe(14);
    expect(db.withTenantTransaction).toHaveBeenCalledWith(context,expect.any(Function));
    expect(calls).toHaveLength(3);
    for(const call of calls){
      expect(call.args).toEqual([context.tenantId]);
      expect(call.sql).toMatch(/^\s*(SELECT|WITH)\b/i);
      expect(call.sql).toContain("tenant_id");
      expect(call.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
    }
  });

  it("gives no fake suggestions when there is no demand history",async()=>{
    const db={withTenantTransaction:jest.fn(async(_context:unknown,handler:any)=>{
      let queries=0;
      return handler({query:jest.fn(async()=>{
        queries++;
        if(queries===1) return {rows:[{
          pending_fulfillment:"0",payment_review:"0"
        }]};
        if(queries===2)return {rows:[{count:"0"}]};
        return {rows:[]};
      })});
    })};
    const snapshot=await new CommerceDecisionsService(db as any).snapshot(context);
    expect(snapshot.replenishment).toEqual([]);
    expect(snapshot.method).toContain("не прогноз");
    expect(snapshot.method).toContain("Ничего не закупается автоматически");
  });
});
