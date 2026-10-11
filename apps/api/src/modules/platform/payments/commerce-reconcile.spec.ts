import {CommercePaymentsService} from "./commerce-payments.service";

const tenant="11111111-1111-4111-8111-111111111111";
const job={
  tenant_id:tenant,
  task_id:"22222222-2222-4222-8222-222222222222",
  intent_id:"33333333-3333-4333-8333-333333333333",
  refund_id:null,
  lease_id:"44444444-4444-4444-8444-444444444444"
};
function subject(status="SUCCEEDED",fiscal="SUCCEEDED"){
  const queries:string[]=[];
  const db={
    query:jest.fn(async()=>({rows:[job],rowCount:1})),
    withTenantTransaction:jest.fn(async(_ctx:any,run:any)=>run({
      query:jest.fn(async(sql:string)=>{
        queries.push(sql);
        if(sql.includes("FROM commerce_payment_intent")){
          if(sql.includes("SELECT *"))return {rows:[{
            id:job.intent_id,tenant_id:tenant,purpose:"SAAS",
            provider_payment_id:"psp-payment-123"
          }],rowCount:1};
          return {rows:[{status,fiscal_status:fiscal}],rowCount:1};
        }
        return {rows:[],rowCount:1};
      })
    }))
  };
  const service=new CommercePaymentsService(db as any,{} as any);
  return {service,db,queries};
}
describe("durable merchant payment recovery",()=>{
  afterEach(()=>jest.restoreAllMocks());
  it("reconciles only a leased job and completes a verified final state",async()=>{
    const x=subject();
    const reconcile=jest.spyOn(x.service as any,"reconcileIntent")
      .mockResolvedValue(undefined);
    await expect(x.service.reconcileDueBatch()).resolves.toBe(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(x.db.query).toHaveBeenCalledWith(
      "SELECT * FROM corebiz_claim_commerce_reconciliation($1)",[5]);
    const update=x.queries.find(sql=>sql.includes("UPDATE commerce_reconcile_task"));
    expect(update).toContain("lease_id=$3");
    expect(update).toContain("state=$4");
  });
  it("keeps a paid-but-unfiscalized receipt in the retry queue",async()=>{
    const x=subject("SUCCEEDED","PENDING");
    jest.spyOn(x.service as any,"reconcileIntent").mockResolvedValue(undefined);
    await x.service.reconcileDueBatch();
    expect(x.queries.some(sql=>sql.includes("interval '5 minutes'"))).toBe(true);
  });
  it("never marks a failed provider request as successful",async()=>{
    const x=subject();
    jest.spyOn(x.service as any,"reconcileIntent")
      .mockRejectedValue(new Error("provider credentials or private payment ID"));
    await expect(x.service.reconcileDueBatch()).resolves.toBe(1);
    expect(x.queries.some(sql=>
      sql.includes("PROVIDER_OR_LEDGER_ERROR"))).toBe(true);
  });
  it("does nothing when another batch is running",async()=>{
    const x=subject();
    (x.service as any).recoveryActive=true;
    await expect(x.service.reconcileDueBatch()).resolves.toBe(0);
    expect(x.db.query).not.toHaveBeenCalled();
  });
});
