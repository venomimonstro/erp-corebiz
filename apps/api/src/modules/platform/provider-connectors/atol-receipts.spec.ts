import {BadRequestException,ConflictException} from "@nestjs/common";
import {AtolReceiptsService} from "./atol-receipts.service";
import {sealMerchantSecret} from "../payments/yookassa.gateway";

const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const site="44444444-4444-4444-8444-444444444444";
const payment="55555555-5555-4555-8555-555555555555";
const document="66666666-6666-4666-8666-666666666666";
const carrierUuid="77777777-7777-4777-8777-777777777777";
const external="corebiz_"+payment+"_prepayment";
function fixture(options:{scope?:string;eligible?:boolean;old?:boolean;amount?:string}={}){
  const sql:string[]=[];
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,callback:any)=>
    callback({query:jest.fn(async(q:string)=>{
      sql.push(q);
      if(q.includes("FROM commerce_payment_intent i")&&q.includes("FOR UPDATE OF i"))
        return {rows:options.eligible===false?[]:[{
          id:payment,amount_minor:options.amount??"15000",
          customer_email:"buyer@example.ru",
          connection_id:"88888888-8888-4888-8888-888888888888",
          environment:"SANDBOX",encrypted_credentials:"ciphertext",
          public_config:{fiscalCompany:{
            inn:"7700000000",email:"seller@example.ru",
            sno:"usn_income",paymentAddress:"https://shop.example.ru",
            vatType:"none"
          }}
        }],rowCount:options.eligible===false?0:1};
      if(q.includes("FROM commerce_fiscal_document")&&q.includes("FOR UPDATE"))
        return {rows:options.old?[{id:document,state:"WAIT"}]:[],
          rowCount:options.old?1:0};
      if(q.includes("FROM retail_serial_unit"))
        return {rows:[],rowCount:0};
      if(q.includes("FROM sales_order_line l JOIN commerce_payment_intent"))
        return {rows:[{description:"Доставка: курьер",quantity_milli:"1000",
          line_total_minor:"15000"}],rowCount:1};
      if(q.includes("INSERT INTO commerce_fiscal_document"))
        return {rows:[{id:document}],rowCount:1};
      if(q.includes("FROM commerce_fiscal_document d"))
        return {rows:[{
          id:document,payment_intent_id:payment,external_id:external,
          provider_uuid:carrierUuid,state:"WAIT",environment:"SANDBOX",
          encrypted_credentials:sealMerchantSecret(JSON.stringify({
            login:"test",password:"testpass",groupCode:"testgroup"
          })),amount_minor:options.amount??"15000"
        }],rowCount:1};
      return {rows:[],rowCount:1};
    })}))};
  const auth={resolveScope:jest.fn().mockResolvedValue(options.scope??"all")};
  const svc=new AtolReceiptsService(db as any,auth as any);
  return {svc,sql};
}
describe("ATOL confirmed-payment fiscalization",()=>{
  const savedKey=process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
  const savedEnabled=process.env.COREBIZ_ATOL_RECEIPTS_ENABLED;
  beforeAll(()=>{
    process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY="f".repeat(64);
    process.env.COREBIZ_ATOL_RECEIPTS_ENABLED="true";
  });
  afterAll(()=>{
    if(savedKey===undefined)delete process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
    else process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY=savedKey;
    if(savedEnabled===undefined)delete process.env.COREBIZ_ATOL_RECEIPTS_ENABLED;
    else process.env.COREBIZ_ATOL_RECEIPTS_ENABLED=savedEnabled;
  });
  it("rejects requests from a manager lacking full-company permission",async()=>{
    const t=fixture({scope:"own"});
    await expect(t.svc.issue(ctx,site,payment,true))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(t.sql).toEqual([]);
  });
  it("fails closed when merchant has not confirmed unmarked goods",async()=>{
    const t=fixture();
    await expect(t.svc.issue(ctx,site,payment,false))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.sql).toEqual([]);
  });
  it("does not produce a tax receipt for a non-captured bank payment",async()=>{
    const t=fixture({eligible:false});
    await expect(t.svc.issue(ctx,site,payment,true))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.sql.some(q=>q.includes("INSERT INTO commerce_fiscal_document")))
      .toBe(false);
  });
  it("returns the existing receipt without issuing again",async()=>{
    const t=fixture({old:true});
    const result=await t.svc.issue(ctx,site,payment,true);
    expect(result).toMatchObject({documentId:document,state:"WAIT"});
    expect(t.sql.some(q=>q.includes("INSERT INTO commerce_fiscal_document")))
      .toBe(false);
  });
  it("rejects a provider report with a different amount",async()=>{
    const t=fixture();
    jest.spyOn((t.svc as any).atol,"report").mockResolvedValue({
      uuid:carrierUuid,state:"DONE",externalId:external,
      fnNumber:"1234567890123456",documentNumber:12,
      fiscalSign:"12345",amountMinor:"1000"
    });
    await expect(t.svc.verify(ctx,site,document))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.sql.some(q=>q.includes("UPDATE commerce_payment_intent")))
      .toBe(false);
  });
  it("marks a fiscal operation paid only after matching provider FN FD FP",async()=>{
    const t=fixture();
    jest.spyOn((t.svc as any).atol,"report").mockResolvedValue({
      uuid:carrierUuid,state:"DONE",externalId:external,
      fnNumber:"1234567890123456",documentNumber:12,
      fiscalSign:"12345",amountMinor:"15000"
    });
    const result=await t.svc.verify(ctx,site,document);
    expect(result.state).toBe("DONE");
    expect(t.sql.some(q=>q.includes("UPDATE commerce_payment_intent SET fiscal_status='SUCCEEDED'")))
      .toBe(true);
  });
});
