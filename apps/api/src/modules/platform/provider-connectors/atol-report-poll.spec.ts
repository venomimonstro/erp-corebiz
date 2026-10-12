import {AtolReceiptsService} from "./atol-receipts.service";

const job={
  tenant_id:"11111111-1111-4111-8111-111111111111",
  task_id:"22222222-2222-4222-8222-222222222222",
  document_id:"33333333-3333-4333-8333-333333333333",
  site_id:"44444444-4444-4444-8444-444444444444",
  lease_id:"55555555-5555-4555-8555-555555555555"
};

function setup(jobs:typeof job[]= [job]){
  const calls:string[]=[];
  const db={
    query:jest.fn(async()=>({rows:jobs,rowCount:jobs.length})),
    withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>
      fn({query:jest.fn(async(sql:string)=>{
        calls.push(sql);return {rows:[],rowCount:1};
      })}))
  };
  const authorization={resolveScope:jest.fn().mockResolvedValue("all")};
  const service=new AtolReceiptsService(db as any,authorization as any);
  return {service,db,calls};
}
describe("ATOL fiscal GET-only background report recovery",()=>{
  afterEach(()=>jest.restoreAllMocks());

  it("does not send any provider operation when there is no due job",async()=>{
    const t=setup([]);
    await expect(t.service.pollReports()).resolves.toBe(0);
    expect(t.calls).toEqual([]);
    expect(t.db.query).toHaveBeenCalledWith(
      "SELECT * FROM corebiz_claim_atol_fiscal_reconciliation($1)",[5]);
  });
  it("marks a confirmed report DONE using a matching lease",async()=>{
    const t=setup();
    const report=jest.spyOn(t.service as any,"verifyDocument")
      .mockResolvedValue({state:"DONE"});
    await expect(t.service.pollReports()).resolves.toBe(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({tenantId:job.tenant_id}),
      job.site_id,job.document_id
    );
    expect(t.calls.some(x=>x.includes("state=$4")&&
      x.includes("lease_id=$3"))).toBe(true);
  });
  it("keeps a WAIT document due without sending any new receipt",async()=>{
    const t=setup();
    jest.spyOn(t.service as any,"verifyDocument")
      .mockResolvedValue({state:"WAIT"});
    await t.service.pollReports();
    expect(t.calls.some(x=>x.includes("interval '90 seconds'"))).toBe(true);
    expect(t.calls.some(x=>x.includes("registerSell"))).toBe(false);
  });
  it("treats provider FAIL as final but does not alter payment ledger",async()=>{
    const t=setup();
    jest.spyOn(t.service as any,"verifyDocument")
      .mockResolvedValue({state:"FAIL"});
    await t.service.pollReports();
    expect(t.calls.some(x=>x.includes("UPDATE commerce_fiscal_reconcile_task")))
      .toBe(true);
    expect(t.calls.some(x=>x.includes("UPDATE commerce_payment_intent")))
      .toBe(false);
  });
  it("retries identity mismatch with sanitized errors, never reissues POST",async()=>{
    const t=setup();
    const report=jest.spyOn(t.service as any,"verifyDocument")
      .mockRejectedValue(new Error("private URL password and buyer phone"));
    await expect(t.service.pollReports()).resolves.toBe(1);
    expect(report).toHaveBeenCalledTimes(1);
    expect(t.calls.some(x=>x.includes("REPORT_OR_IDENTITY_MISMATCH"))).toBe(true);
    expect(t.calls.join("\n")).not.toContain("private URL password");
  });
  it("does not run overlapping reconciliations within one API process",async()=>{
    const t=setup();
    (t.service as any).reportBusy=true;
    await expect(t.service.pollReports()).resolves.toBe(0);
    expect(t.db.query).not.toHaveBeenCalled();
  });
});
