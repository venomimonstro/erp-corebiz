import {commercialCheckoutChecks, type CommerceReadinessFacts} from "./commercial-checkout-policy";

function facts(verticalCode:string,
  passing:string[]=[],overrides:Partial<CommerceReadinessFacts>={}):CommerceReadinessFacts{
  return {
    verticalCode,
    storefrontPublished:true,merchantConfigured:true,fiscalConfigured:true,
    deliveryMethodConfigured:true,activeRetailLocations:2,
    evidence:(component,kind)=>passing.includes(component+":"+kind),
    ...overrides
  };
}
describe("commercial go-live policy: independent payment, fiscal and delivery",()=>{
  it("never marks a webshop ready just because credentials and delivery are configured",()=>{
    const checks=commercialCheckoutChecks(facts("ECOMMERCE_STORE"));
    expect(checks.find(x=>x.code==="WEB_ACQUIRING_CONFIG")?.ok).toBe(true);
    for(const code of ["WEB_PAYMENT_E2E","WEB_FISCAL_E2E","WEB_FULFILLMENT_E2E"]){
      expect(checks.find(x=>x.code===code)).toMatchObject({
        ok:false,blocking:true
      });
    }
  });
  it("rejects webshop when a public site or carrier method is unavailable",()=>{
    const checks=commercialCheckoutChecks(facts("ECOMMERCE_STORE",[],{
      storefrontPublished:false,deliveryMethodConfigured:false
    }));
    expect(checks.find(x=>x.code==="WEB_SHOP_PUBLISHED")?.ok).toBe(false);
    expect(checks.find(x=>x.code==="WEB_DELIVERY_CONFIG")?.ok).toBe(false);
  });
  it("requires 54-FZ proof and bank terminal separately for physical stores",()=>{
    const checks=commercialCheckoutChecks(facts("RETAIL_STORE"));
    expect(checks.find(x=>x.code==="POS_LOCATION")?.ok).toBe(true);
    expect(checks.find(x=>x.code==="POS_BANK_E2E")?.ok).toBe(false);
    expect(checks.find(x=>x.code==="POS_FISCAL_E2E")?.ok).toBe(false);
    expect(checks.find(x=>x.code==="WEB_PAYMENT_E2E")).toBeUndefined();
  });
  it("requires chosen-store warehouse locking and electronics marking review for omnichannel",()=>{
    const checks=commercialCheckoutChecks(facts("OMNICHANNEL_RETAIL"));
    expect(checks.find(x=>x.code==="OMNI_WAREHOUSE_PICKUP")?.ok).toBe(false);
    expect(checks.find(x=>x.code==="ELECTRONICS_MARKING_REVIEW")?.ok).toBe(false);
    expect(checks.filter(x=>x.blocking).length).toBeGreaterThanOrEqual(10);
  });
  it("does not require a bank acquiring integration for marketplace-only merchants",()=>{
    const checks=commercialCheckoutChecks(facts("MARKETPLACE_SELLER"));
    expect(checks.map(x=>x.code)).toEqual(["MARKETPLACE_ORDER_E2E"]);
  });
  it("passes only with independent verified evidence",()=>{
    const checks=commercialCheckoutChecks(facts("ECOMMERCE_STORE",[
      "COMMERCE:PAYMENT_E2E","COMMERCE:FISCAL_E2E",
      "COMMERCE:FULFILLMENT_E2E"
    ]));
    expect(checks.every(x=>x.ok)).toBe(true);
  });
  it("does not impose retail checkout checks on a professional services tenant",()=>{
    expect(commercialCheckoutChecks(facts("PROFESSIONAL_SERVICES"))).toEqual([]);
  });
});
