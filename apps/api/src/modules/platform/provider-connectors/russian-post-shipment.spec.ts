import {ConflictException} from "@nestjs/common";
import {RussianPostService} from "./russian-post.service";
const ctx={
  tenantId:"11111111-1111-4111-8111-111111111111",
  userId:"22222222-2222-4222-8222-222222222222",
  membershipId:"33333333-3333-4333-8333-333333333333"
};
const siteId="44444444-4444-4444-8444-444444444444";
const orderId="55555555-5555-4555-8555-555555555555";
const quoteId="66666666-6666-4666-8666-666666666666";
const payload={
  orderId,quoteId,recipientName:"Иван Иванов",recipientPhone:"+79991112233",
  destination:{index:"101000",region:"Москва",place:"Москва",
    street:"Ленина",house:"1"}
};
function fixture(paid=true,existing=false,cdekExists=false){
  const statements:string[]=[];
  const conn={id:"77777777-7777-4777-8777-777777777777",
    site_id:siteId,encrypted_credentials:"ciphertext",public_config:{
      fromPostcode:"190000"},state:"VERIFIED",enabled:true,verified_at:new Date()};
  const query=jest.fn(async(sql:string)=>{
    statements.push(sql);
    if(sql.includes("FROM commerce_provider_connection ")&&
       sql.includes("provider='POCHTA_RUSSIA'"))
      return {rows:[conn],rowCount:1};
    if(sql.includes("FROM sales_order o")&&sql.includes("FOR UPDATE OF o"))
      return {rows:paid?[{id:orderId,address:"Москва, улица Ленина, дом 1"}]:[],
        rowCount:paid?1:0};
    if(sql.includes("FROM commerce_post_tariff_quote q"))
      return {rows:[{to_postcode:"101000",mass_grams:1000,
        amount_minor:"35000"}],rowCount:1};
    if(sql.includes("FROM commerce_shipment"))
      return {rows:cdekExists?[{id:"88888888-8888-4888-8888-888888888888"}]:[],
        rowCount:cdekExists?1:0};
    if(sql.includes("FROM commerce_post_shipment")&&sql.includes("FOR UPDATE"))
      return {rows:existing?[{id:"88888888-8888-4888-8888-888888888888",
        payload_digest:"different"}]:[],rowCount:existing?1:0};
    return {rows:[],rowCount:0};
  });
  const db={withTenantTransaction:jest.fn(async(_ctx:unknown,fn:any)=>
    fn({query}))};
  const authorization={resolveScope:jest.fn().mockResolvedValue("all")};
  return {service:new RussianPostService(db as any,authorization as any),
    statements};
}
describe("Russian Post order authorization and claims",()=>{
  it("refuses posting unconfirmed or unfiscalized sales order",async()=>{
    const f=fixture(false);
    await expect(f.service.book(ctx,siteId,payload))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.statements.some(s=>s.includes("pi.fiscal_status='SUCCEEDED'")))
      .toBe(true);
    expect(f.statements.some(s=>s.includes("INSERT INTO commerce_post_shipment")))
      .toBe(false);
  });
  it("won't silently create a different postal order after first claim",async()=>{
    const f=fixture(true,true);
    await expect(f.service.book(ctx,siteId,payload))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.statements.some(s=>s.includes("INSERT INTO commerce_post_shipment")))
      .toBe(false);
  });
  it("refuses Russian Post when CDEK has already claimed shipping",async()=>{
    const f=fixture(true,false,true);
    await expect(f.service.book(ctx,siteId,payload))
      .rejects.toBeInstanceOf(ConflictException);
    expect(f.statements.some(s=>s.includes("FROM commerce_shipment"))).toBe(true);
    expect(f.statements.some(s=>s.includes(
      "INSERT INTO commerce_post_shipment"))).toBe(false);
  });
  it("requires original checkout address, verified quote and current secret",async()=>{
    const f=fixture();
    await expect(f.service.book(ctx,siteId,{
      ...payload,destination:{...payload.destination,street:"Другая улица"}
    })).rejects.toBeInstanceOf(ConflictException);
    expect(f.statements.some(s=>s.includes("INSERT INTO commerce_post_shipment")))
      .toBe(false);
  });
});
