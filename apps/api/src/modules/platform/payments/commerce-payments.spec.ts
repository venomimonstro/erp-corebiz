import {
  BadRequestException, ConflictException, ServiceUnavailableException
} from "@nestjs/common";
import { CommercePaymentsService } from "./commerce-payments.service";
import {
  moneyToMinor, minorToMoney, sealMerchantSecret, openMerchantSecret,
  providerIdempotencyKey, YooKassaGateway
} from "./yookassa.gateway";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
describe("regulated provider boundary",()=>{
  it("converts RUB kopeks exactly, without float arithmetic",()=>{
    expect(moneyToMinor("100.23")).toBe("10023");
    expect(minorToMoney("10023")).toBe("100.23");
    expect(()=>moneyToMinor("100.231")).toThrow();
    expect(()=>moneyToMinor("-1.00")).toThrow();
  });
  it("seals merchant secrets with authenticated encryption and never stores plaintext",()=>{
    const before=process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
    process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY="a".repeat(64);
    try{
      const sealed=sealMerchantSecret("merchant-super-secret");
      expect(sealed).toMatch(/^v1:/);
      expect(sealed).not.toContain("merchant-super-secret");
      expect(openMerchantSecret(sealed)).toBe("merchant-super-secret");
      expect(()=>openMerchantSecret(sealed.slice(0,-3)+"AAA"))
        .toThrow(ServiceUnavailableException);
    }finally{
      if(before===undefined)delete process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
      else process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY=before;
    }
  });
  it("uses deterministic bounded PSP idempotency keys",()=>{
    expect(providerIdempotencyKey("order-A")).toBe(providerIdempotencyKey("order-A"));
    expect(providerIdempotencyKey("order-A")).not.toBe(providerIdempotencyKey("order-B"));
    expect(providerIdempotencyKey("order-A")).toHaveLength(64);
  });
  it("rejects provider callback amount and identity tampering",()=>{
    const svc=new CommercePaymentsService({} as any,{} as any);
    const intent={
      id:"55555555-5555-4555-8555-555555555555",
      purpose:"STOREFRONT",amount_minor:"12000",currency:"RUB"
    };
    const payment={
      id:"provider-111111111",status:"succeeded",paid:true,
      amount:{value:"100.00",currency:"RUB"},
      metadata:{corebiz_intent_id:intent.id,corebiz_purpose:"STOREFRONT"}
    };
    expect(()=>(svc as any).verifyAmount(intent,payment))
      .toThrow(ConflictException);
    payment.amount.value="120.00";
    payment.metadata.corebiz_intent_id="other-intent";
    expect(()=>(svc as any).verifyAmount(intent,payment))
      .toThrow(ConflictException);
    payment.metadata.corebiz_intent_id=intent.id;
    expect(()=>(svc as any).verifyAmount(intent,payment)).not.toThrow();
  });
  it("validates malformed checkout keys before querying a tenant",async()=>{
    const db={query:jest.fn(),withTenantTransaction:jest.fn()};
    const svc=new CommercePaymentsService(db as any,{} as any);
    await expect(svc.beginStore("public-guess")).rejects.toBeInstanceOf(BadRequestException);
    expect(db.query).not.toHaveBeenCalled();
  });
  it("requires real merchant tax and fiscal configuration",()=>{
    const svc=new CommercePaymentsService({} as any,{} as any);
    expect(()=>(svc as any).seller({
      shop_id:"123456",encrypted_secret:"secret",vat_code:11,
      enabled:true,fiscal_enabled:false
    })).toThrow(ConflictException);
  });
  it("never trusts an unsigned refund notification status alone",async()=>{
    const get=jest.fn().mockResolvedValue({rows:[]});
    const svc=new CommercePaymentsService({query:get} as any,{} as any);
    const result=await svc.webhook({
      event:"refund.succeeded",object:{id:"provider-refund-12345678"}
    });
    expect(result).toEqual({accepted:true});
    expect(get).toHaveBeenCalledWith(
      "SELECT * FROM corebiz_resolve_refund_tenant($1)",
      ["provider-refund-12345678"]
    );
  });
  it("never sends a network request without correctly scoped PSP credentials",async()=>{
    const gateway=new YooKassaGateway();
    await expect(gateway.get({shopId:"injected-shop",secret:"secret"},
      "provider_payment_12345")).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
