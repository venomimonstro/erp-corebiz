import {BadRequestException,ConflictException} from "@nestjs/common";
import {WmsService} from "./wms.service";

const tenant={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const reviewer={...tenant,membershipId:"44444444-4444-4444-8444-444444444444"};
const id="55555555-5555-4555-8555-555555555555";
const line={
  id,task_id:"66666666-6666-4666-8666-666666666666",
  count_id:"77777777-7777-4777-8777-777777777777",
  warehouse_id:"88888888-8888-4888-8888-888888888888",
  location_id:"99999999-9999-4999-8999-999999999999",
  sku_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status:"REVIEW_REQUIRED",count_status:"REVIEW_REQUIRED",
  expected_milli:"1000",counted_milli:"800",variance_milli:"-200",
  counted_by_membership_id:tenant.membershipId
};
function setup(overrides:Partial<typeof line>={}){
  const queries:Array<{sql:string;args:unknown[]}>= [];
  const client={query:jest.fn(async(sql:string,args:unknown[]=[])=>{
    queries.push({sql,args});
    if(sql.includes("FROM wms_cycle_count_line l")&&
      sql.includes("JOIN wms_cycle_count c"))
      return {rows:[{...line,...overrides}],rowCount:1};
    if(sql.includes("FROM warehouse_location_balance")&&sql.includes("FOR UPDATE"))
      return {rows:[{physical_milli:"1000"}],rowCount:1};
    if(sql.includes("SELECT EXISTS(")&&sql.includes("wms_cycle_count_line"))
      return {rows:[{unfinished:false}],rowCount:1};
    if(sql.includes("bool_or(status='OPEN')"))
      return {rows:[{has_open:false,has_review:true}],rowCount:1};
    if(sql.includes("FROM warehouse_task t")&&sql.includes("wms_cycle_count_line l"))
      return {rows:[{task_status:"CLAIMED",
        claimed_by_membership_id:tenant.membershipId,
        line_id:line.id,count_id:line.count_id,count_status:"OPEN",
        line_status:"OPEN",warehouse_id:line.warehouse_id,
        location_id:line.location_id,sku_id:line.sku_id,
        expected_milli:"1000"}],rowCount:1};
    return {rows:[],rowCount:1};
  })};
  const inventory={applyWmsCountAdjustment:jest.fn().mockResolvedValue(undefined)};
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,cb:any)=>cb(client))};
  const svc=new WmsService(db as any,inventory as any);
  (svc as any).audit=jest.fn().mockResolvedValue(undefined);
  (svc as any).assertLocationReconciliation=jest.fn().mockResolvedValue(undefined);
  return {svc,queries,inventory,client};
}
describe("AXELOT two-person WMS cycle count approval",()=>{
  it("records a discrepancy without posting ANY inventory or location ledger",async()=>{
    const f=setup();
    const result=await f.svc.completeCycleCountTask(
      tenant,line.task_id,"800");
    expect(result).toMatchObject({varianceMilli:"-200",countCompleted:false});
    expect(f.inventory.applyWmsCountAdjustment).not.toHaveBeenCalled();
    expect(f.queries.some(q=>q.sql.includes("INSERT INTO wms_location_movement")))
      .toBe(false);
    expect(f.queries.some(q=>q.sql.includes("UPDATE warehouse_location_balance")))
      .toBe(false);
    expect(f.queries.some(q=>q.sql.includes("status=CASE WHEN $4::bigint=0"))).toBe(true);
  });
  it("requires another membership to approve a loss",async()=>{
    const f=setup();
    await expect(f.svc.reviewCountVariance(tenant,id,{
      decision:"APPROVE",note:"Проверено по акту"
    })).rejects.toBeInstanceOf(ConflictException);
    expect(f.inventory.applyWmsCountAdjustment).not.toHaveBeenCalled();
  });
  it("rejects blank justification before connecting to PostgreSQL",async()=>{
    const f=setup();
    await expect(f.svc.reviewCountVariance(reviewer,id,{
      decision:"APPROVE",note:""
    })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.client.query).not.toHaveBeenCalled();
  });
  it("approval posts physical, location and audit in one tenant transaction",async()=>{
    const f=setup();
    const result=await f.svc.reviewCountVariance(reviewer,id,{
      decision:"APPROVE",note:"Расхождение подтверждено"
    });
    expect(result).toEqual({status:"POSTED",varianceMilli:"-200"});
    expect(f.inventory.applyWmsCountAdjustment).toHaveBeenCalledTimes(1);
    expect(f.inventory.applyWmsCountAdjustment).toHaveBeenCalledWith(
      f.client,reviewer,expect.objectContaining({
        countLineId:id,quantityDeltaMilli:-200n,
        idempotencyKey:"wms-count-adjust:"+id
      })
    );
    expect(f.queries.some(q=>q.sql.includes("UPDATE warehouse_location_balance")))
      .toBe(true);
    expect(f.queries.some(q=>q.sql.includes("INSERT INTO wms_location_movement")))
      .toBe(true);
    expect(f.queries.some(q=>q.sql.includes("SET status='POSTED',posted_at=now()")))
      .toBe(true);
  });
  it("recount reopens the same task, leaving stock untouched",async()=>{
    const f=setup();
    const result=await f.svc.reviewCountVariance(reviewer,id,{
      decision:"RECOUNT",note:"Необходима независимая проверка"
    });
    expect(result.status).toBe("OPEN");
    expect(f.inventory.applyWmsCountAdjustment).not.toHaveBeenCalled();
    expect(f.queries.some(q=>q.sql.includes("status='OPEN',")&&
      q.sql.includes("claimed_by_membership_id=NULL"))).toBe(true);
    expect(f.queries.some(q=>q.sql.includes("UPDATE warehouse_location_balance")))
      .toBe(false);
  });
  it("idempotent approval of an already posted line does not post again",async()=>{
    const f=setup({status:"POSTED",count_status:"POSTED"});
    expect(await f.svc.reviewCountVariance(reviewer,id,{
      decision:"APPROVE",note:"Перепроверить ранее принятое"
    })).toMatchObject({status:"POSTED"});
    expect(f.inventory.applyWmsCountAdjustment).not.toHaveBeenCalled();
  });
});
