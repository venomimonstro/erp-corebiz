import { CommercePaymentsService } from "./commerce-payments.service";

const tenant="11111111-1111-4111-8111-111111111111";
const site="22222222-2222-4222-8222-222222222222";
const order="33333333-3333-4333-8333-333333333333";
const intent={
  id:"44444444-4444-4444-8444-444444444444",
  tenant_id:tenant,site_id:site,amount_minor:"9900",
  currency:"RUB",purpose:"STOREFRONT" as const,
  sales_order_id:order,plan_id:null,
  provider_payment_id:"provider-payment-abcdefgh",
  provider_idempotency_key:"idempotent-key",confirmation_url:null,
  status:"PENDING",customer_email:"buyer@example.test"
};

describe("verified provider -> Finance business journey",()=>{
  function setup(status:"pending"|"succeeded",amount="99.00"){
    const sql:string[]=[];
    const query=jest.fn(async(q:string)=>{
      sql.push(q);
      if(q.includes("SELECT m.user_id,m.id FROM storefront_config"))return {
        rows:[{user_id:"55555555-5555-4555-8555-555555555555",
          id:"66666666-6666-4666-8666-666666666666"}],rowCount:1
      };
      return {rows:[],rowCount:1};
    });
    const db={
      withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>
        fn({query}))
    };
    const finance={
      receiveSalesPayment:jest.fn().mockResolvedValue({
        paymentId:"77777777-7777-4777-8777-777777777777",
        number:"PAY-001",paymentStatus:"PAID"
      })
    };
    const service=new CommercePaymentsService(db as any,finance as any);
    jest.spyOn(service as any,"sellerConfig").mockResolvedValue({
      shop_id:"123456",encrypted_secret:"encrypted",enabled:true,fiscal_enabled:true,
      vat_code:11,tax_system_code:1
    });
    jest.spyOn(service as any,"seller").mockReturnValue({shopId:"123456",secret:"private"});
    jest.spyOn((service as any).gateway,"get").mockResolvedValue({
      id:intent.provider_payment_id,status,paid:status==="succeeded",
      amount:{value:amount,currency:"RUB"},
      metadata:{corebiz_intent_id:intent.id,corebiz_purpose:"STOREFRONT"},
      receipt_registration:"succeeded"
    });
    return {service,finance,sql};
  }
  it("cannot change an ERP order or post money while PSP says pending",async()=>{
    const x=setup("pending");
    await (x.service as any).reconcileIntent(intent);
    expect(x.finance.receiveSalesPayment).not.toHaveBeenCalled();
    expect(x.sql.every(q=>!q.includes("UPDATE commerce_payment_intent")))
      .toBe(true);
  });
  it("refuses a mismatched PSP amount before a ledger posting",async()=>{
    const x=setup("succeeded","99.01");
    await expect((x.service as any).reconcileIntent(intent))
      .rejects.toThrow("Данные оплаты не совпадают");
    expect(x.finance.receiveSalesPayment).not.toHaveBeenCalled();
  });
  it("posts the exact full amount to the canonical Finance idempotency key",async()=>{
    const x=setup("succeeded");
    await (x.service as any).reconcileIntent(intent);
    expect(x.finance.receiveSalesPayment).toHaveBeenCalledWith(
      {tenantId:tenant,userId:"55555555-5555-4555-8555-555555555555",
        membershipId:"66666666-6666-4666-8666-666666666666"},
      expect.objectContaining({
        orderId:order,amountMinor:"9900",
        idempotencyKey:"yookassa:"+intent.id
      })
    );
    expect(x.sql.some(q=>q.includes("status='SUCCEEDED'"))).toBe(true);
  });
});
