import {ConflictException} from "@nestjs/common";
import {MerchantConnectorService} from "./merchant-connector.service";
import {sealMerchantSecret} from "../payments/yookassa.gateway";

const context={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const site="44444444-4444-4444-8444-444444444444";
const order="55555555-5555-4555-8555-555555555555";
const quote="66666666-6666-4666-8666-666666666666";
const shipment="77777777-7777-4777-8777-777777777777";
const input={
  orderId:order,quoteId:quote,recipientName:"Иван Иванов",
  recipientPhone:"+79998887766",lengthCm:20,widthCm:15,heightCm:12
};

function fixture(known=false,canShip=true,postalExists=false){
  const statements:string[]=[];
  const client={
    query:jest.fn(async(sql:string)=>{
      statements.push(sql);
      if(sql.includes("SELECT * FROM commerce_provider_connection"))
        return {rows:[{id:"88888888-8888-4888-8888-888888888888",
          environment:"SANDBOX",encrypted_credentials:"ciphertext",
          enabled:true,state:"VERIFIED"}],rowCount:1};
      if(sql.includes("FROM sales_order o")&&sql.includes("FOR UPDATE OF o"))
        return {rows:canShip?[{id:order,delivery_address:"Москва, ул. Ленина 1"}]:[],rowCount:canShip?1:0};
      if(sql.includes("FROM commerce_shipping_quote q"))
        return {rows:[{tariff_code:136,from_city_code:44,to_city_code:137,
          package_weight_grams:1000,amount_minor:"55000"}],rowCount:1};
      if(sql.includes("FROM sales_order_line l JOIN sku s"))
        return {rows:[{description:"Ноутбук",quantity_milli:"1000",
          line_total_minor:"4500000",sku_code:"NOTEBOOK-1"}],rowCount:1};
      if(sql.includes("FROM commerce_post_shipment"))
        return {rows:postalExists?[{id:shipment}]:[],
          rowCount:postalExists?1:0};
      if(sql.includes("FROM commerce_shipment")&&sql.includes("FOR UPDATE"))
        return {rows:known?[{id:shipment,payload_digest:"different"}]:[],
          rowCount:known?1:0};
      if(sql.includes("INSERT INTO commerce_shipment"))
        return {rows:[{id:shipment}],rowCount:1};
      return {rows:[],rowCount:1};
    })
  };
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>fn(client))};
  const auth={resolveScope:jest.fn().mockResolvedValue("all")};
  const service=new MerchantConnectorService(db as any,auth as any);
  return {service,statements};
}
describe("carrier booking authorization and idempotency",()=>{
  it("refuses orders lacking confirmed bank payment, fiscal proof or stock",async()=>{
    const t=fixture(false,false);
    await expect(t.service.bookShipment(context,site,input))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.statements.some(s=>s.includes("fiscal_status='SUCCEEDED'")))
      .toBe(true);
    expect(t.statements.some(s=>s.includes("finance_payment_id IS NOT NULL")))
      .toBe(true);
    expect(t.statements.some(s=>s.includes("INSERT INTO commerce_shipment")))
      .toBe(false);
  });
  it("refuses altered request for the same sales order",async()=>{
    const t=fixture(true);
    await expect(t.service.bookShipment(context,site,input))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.statements.some(s=>s.includes("INSERT INTO commerce_shipment")))
      .toBe(false);
  });
  it("checks merchant secret continuity for booking quote",async()=>{
    const t=fixture(true);
    await expect(t.service.bookShipment(context,site,input))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.statements.some(sql=>sql.includes("cp.encrypted_credentials=$5"))).toBe(true);
  });
  it("blocks CDEK booking if Russian Post has already claimed the order",async()=>{
    const t=fixture(false,true,true);
    await expect(t.service.bookShipment(context,site,input))
      .rejects.toBeInstanceOf(ConflictException);
    expect(t.statements.some(sql=>sql.includes(
      "FROM commerce_post_shipment"))).toBe(true);
    expect(t.statements.some(sql=>sql.includes(
      "INSERT INTO commerce_shipment"))).toBe(false);
  });
  it("denies malformed order identifiers",async()=>{
    const t=fixture();
    await expect(t.service.bookShipment(context,site,{
      ...input,orderId:"invalid"
    })).rejects.toBeDefined();
    expect(t.statements).toEqual([]);
  });
});

describe("carrier status evidence cannot regress shipment state",()=>{
  it("preserves NOT_DELIVERED and reads committed status instead of optimistic input",async()=>{
    const before=process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
    process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY="a".repeat(64);
    try{
      const encrypted=sealMerchantSecret(JSON.stringify({
        clientId:"test",clientSecret:"test-secret"
      }));
      const query=jest.fn(async(sql:string,_params?:unknown[])=>{
        if(sql.includes("FROM commerce_shipment WHERE"))
          return {rows:[{
            id:shipment,sales_order_id:order,
            provider_order_uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            state:"IN_TRANSIT"
          }],rowCount:1};
        if(sql.includes("SELECT * FROM commerce_provider_connection"))
          return {rows:[{id:"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            encrypted_credentials:encrypted,environment:"SANDBOX",
            state:"VERIFIED",enabled:true}],rowCount:1};
        if(sql.includes("UPDATE commerce_shipment"))
          return {rows:[{state:"NOT_DELIVERED",provider_number:"CDEK-123"}],
            rowCount:1};
        return {rows:[],rowCount:0};
      });
      const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>
        fn({query}))};
      const auth={resolveScope:jest.fn().mockResolvedValue("all")};
      const svc=new MerchantConnectorService(db as any,auth as any);
      jest.spyOn((svc as any).cdek,"orderStatus").mockResolvedValue({
        uuid:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clientOrderNumber:order,cdekNumber:"CDEK-123",state:"NOT_DELIVERED"
      });
      const verified=await svc.verifyShipment(context,site,shipment);
      expect(verified.state).toBe("NOT_DELIVERED");
      expect(verified.trackingNumber).toBe("CDEK-123");
      const update=query.mock.calls.find(([sql])=>sql.includes(
        "UPDATE commerce_shipment"));
      expect(update?.[0]).toContain("WHEN state IN ('DELIVERED','NOT_DELIVERED'");
      expect(update?.[1]?.[5]).toBe("NOT_DELIVERED");
    }finally{
      if(before===undefined)delete process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY;
      else process.env.COREBIZ_PAYMENT_ENCRYPTION_KEY=before;
      jest.restoreAllMocks();
    }
  });
});
