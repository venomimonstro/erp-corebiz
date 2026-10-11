import {BadRequestException,ForbiddenException} from "@nestjs/common";
import {AutomotiveService} from "./automotive.service";
const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const orderId="44444444-4444-4444-8444-444444444444";
const lineId="55555555-5555-4555-8555-555555555555";
function harness(options:{financeRead?:boolean;financeWrite?:boolean;line?:Record<string,unknown>}={}){
  const calls:string[]=[];
  const query=jest.fn(async(sql:string)=>{
    calls.push(sql);
    if(sql.includes("FROM automotive_work_order_line l")&&sql.includes("FOR UPDATE"))
      return {rows:[{
        id:lineId,order_status:"IN_PROGRESS",approved:true,completed:false,
        unit_price_minor:"10000",unit_cost_minor:"5000",...options.line
      }],rowCount:1};
    if(sql.includes("FROM automotive_work_order")&&sql.includes("count(*)"))
      return {rows:[{open_orders:3,waiting_parts:1,overdue:0,delivered_revenue_minor:"150000"}],rowCount:1};
    if(sql.includes("FROM automotive_donor_vehicle")&&sql.includes("count"))
      return {rows:[{active_donors:1,invested_minor:"80000"}],rowCount:1};
    if(sql.includes("FROM automotive_dismantled_part")&&sql.includes("count"))
      return {rows:[{available_parts:2,stock_cost_minor:"12000",stock_asking_minor:"20000"}],rowCount:1};
    return {rows:[],rowCount:0};
  });
  const db={withTenantTransaction:jest.fn(async(_c:unknown,fn:any)=>fn({query}))};
  const auth={
    resolveScope:jest.fn(async(_ctx:unknown,p:string)=>
      p==="finance.read"&&options.financeRead?"all":
      p==="finance.write"&&options.financeWrite?"all":null)
  };
  return {service:new AutomotiveService(db as any,{} as any,auth as any),db,query,calls};
}
describe("automotive: commercial authorization and finance protection",()=>{
  it.each(["NaN","-1000","Infinity","1.4","10000000000000000000"])(
    "rejects invalid shop-floor quantity %s without opening a transaction",async q=>{
      const {service,db}=harness();
      await expect(service.addWorkOrderLine(ctx,orderId,{
        lineType:"PART",description:"Подшипник",quantityMilli:q
      })).rejects.toBeInstanceOf(BadRequestException);
      expect(db.withTenantTransaction).not.toHaveBeenCalled();
    }
  );
  it("changing cost requires finance.write, even for a general workshop manager",async()=>{
    const {service,db}=harness();
    await expect(service.updateWorkOrderLine(ctx,orderId,lineId,{
      unitCostMinor:20000
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.withTenantTransaction).not.toHaveBeenCalled();
  });
  it("cannot silently raise an already customer-approved repair price",async()=>{
    const {service,calls}=harness();
    await expect(service.updateWorkOrderLine(ctx,orderId,lineId,{
      unitPriceMinor:25000
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.some(sql=>sql.startsWith("UPDATE automotive_work_order_line"))).toBe(false);
  });
  it("delivered repair line needs a correction document instead of rewriting approved totals",async()=>{
    const {service,calls}=harness({line:{completed:true}});
    await expect(service.updateWorkOrderLine(ctx,orderId,lineId,{
      unitPriceMinor:23000,approved:false
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(calls.some(sql=>sql.startsWith("UPDATE automotive_work_order_line"))).toBe(false);
  });
  it("mechanic sees the workshop queue without purchase costs or revenue",async()=>{
    const {service}=harness();
    const dashboard=await service.dashboard(ctx);
    expect(dashboard.orders.open_orders).toBe(3);
    expect(dashboard.orders.delivered_revenue_minor).toBeNull();
    expect(dashboard.donors.invested_minor).toBeNull();
    expect(dashboard.parts.stock_cost_minor).toBeNull();
  });
  it("owner with financial rights sees the real profit-driving amounts",async()=>{
    const {service}=harness({financeRead:true});
    const dashboard=await service.dashboard(ctx);
    expect(dashboard.orders.delivered_revenue_minor).toBe("150000");
    expect(dashboard.parts.stock_cost_minor).toBe("12000");
  });
});
