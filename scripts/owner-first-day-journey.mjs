#!/usr/bin/env node
/**
 * OWNER DAY ONE: disposable local CoreBiz API only.
 * Exercises the owner path and negative payment/fulfilment gates.
 * Does not fake an external bank or carrier response.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES",
  "BLOCKED: set COREBIZ_CONFIRM_DISPOSABLE_DB=YES only on disposable stack");
assert.ok(process.env.COREBIZ_SMOKE_BASE_URL,
  "BLOCKED: COREBIZ_SMOKE_BASE_URL required");
const base=new URL(process.env.COREBIZ_SMOKE_BASE_URL);
assert.equal(base.protocol,"http:");
assert.ok(["localhost","127.0.0.1","[::1]"].includes(base.hostname),
  "BLOCKED: external/production targets forbidden");
const origin=process.env.COREBIZ_SMOKE_WEB_ORIGIN??"http://localhost:3000";
const run=randomUUID();
let cookie="";
const steps=[];
async function api(method,path,body,expected=200,publicRequest=false){
  const started=performance.now();
  const response=await fetch(new URL("/api/v1"+path,base),{
    method,headers:{Origin:origin,
      ...(!publicRequest&&cookie?{Cookie:cookie}:{}),
      ...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),
    redirect:"manual",signal:AbortSignal.timeout(20000)
  });
  const token=response.headers.get("set-cookie");
  if(token?.startsWith("corebiz_session="))cookie=token.split(";")[0];
  assert.equal(response.status,expected,method+" "+path+
    " returned "+response.status+" instead of "+expected);
  const payload=await response.json();
  if(expected===200)assert.equal(payload.ok,true,method+" "+path);
  else assert.equal(payload.ok,false,"Rejected requests must use error envelope");
  steps.push({step:method+" "+path.split("?")[0],status:response.status,
    latencyMs:Math.round(performance.now()-started)});
  return payload.data;
}
const email="owner-"+run+"@example.invalid";
const password="Disposable-"+randomUUID();
await api("GET","/health/ready");
const registration=await api("POST","/auth/register",{
  email,password,companyName:"Owner first-day "+run.slice(0,8)
});
assert.ok(registration.auth.tenantId);
await api("GET","/dashboard/workspace");
await api("GET","/dashboard/activation");
await api("PUT","/customization/business-profile",{profileCode:"ECOMMERCE"});
await api("PUT","/customization/business-vertical",
  {verticalCode:"ECOMMERCE_STORE"});

const warehouse=await api("POST","/inventory/warehouses",{
  name:"Disposable main warehouse",code:"OWNER"+run.slice(0,4).toUpperCase()
});
const product=await api("POST","/catalog/products",{
  name:"Owner smoke physical SKU",kind:"STOCKABLE",
  salePriceMinor:"5900",costPriceMinor:"1900"
});
await api("POST","/inventory/adjustments",{
  warehouseId:warehouse.id,skuId:product.skuId,quantityDeltaMilli:"2000",
  reason:"Disposable owner initial stock",
  idempotencyKey:"owner-stock-"+run
});
const site=await api("POST","/sites",{
  name:"Owner online store",publicSlug:"owner-"+run.replace(/-/g,"").slice(0,20)
});
await api("PUT","/storefront/site/"+site.id+"/config",{
  enabled:true,currency:"RUB"
});
await api("GET","/storefront/site/"+site.id+"/readiness");
const slug=site.publicSlug;
const methodsBefore=await api("GET",
  "/payments/storefront/"+slug+"/delivery",undefined,200,true);
assert.equal(methodsBefore.methods.length,0,
  "Fresh store must not have fictitious delivery method");
const catalog=await api("GET","/storefront/"+slug+"/catalog",undefined,200,true);
assert.ok(catalog.products.some(p=>p.sku_id===product.skuId));
const cart=await api("POST","/storefront/"+slug+"/carts",{},200,true);
await api("PUT","/storefront/carts/"+cart.cartKey+"/lines",{
  skuId:product.skuId,quantityMilli:"1000"
},200,true);
const buyer={
  idempotencyKey:"owner-buyer-"+run,name:"Disposable Buyer",
  phone:"+79990001122",email:"buyer-"+run+"@example.invalid"
};
await api("POST","/storefront/carts/"+cart.cartKey+"/checkout",buyer,400,true);
const pickup=await api("POST","/payments/stores/"+site.id+"/delivery",{
  code:"STORE_PICKUP",title:"Самовывоз",mode:"PICKUP",
  feeMinor:"0",active:true
});
assert.ok(pickup.id);
const methodsAfter=await api("GET",
  "/payments/storefront/"+slug+"/delivery",undefined,200,true);
assert.equal(methodsAfter.methods.filter(p=>p.id===pickup.id).length,1);
const checkout=await api("POST","/storefront/carts/"+cart.cartKey+"/checkout",
  {...buyer,deliveryMethodId:pickup.id},200,true);
assert.equal(checkout.accepted,true);
const replay=await api("POST","/storefront/carts/"+cart.cartKey+"/checkout",
  {...buyer,deliveryMethodId:pickup.id},200,true);
assert.equal(replay.salesOrderId,checkout.salesOrderId,
  "Payment/network replay must not create a second SalesOrder");
const orders=await api("GET","/sales/orders");
assert.equal(orders.filter(o=>o.id===checkout.salesOrderId).length,1);
await api("POST","/payments/storefront/carts/"+cart.cartKey+"/start",
  undefined,409,true);
const postPaymentOrders=await api("GET","/sales/orders");
assert.notEqual(postPaymentOrders.find(o=>o.id===checkout.salesOrderId)
  ?.paymentStatus,"PAID","Missing PSP credentials must never mark order PAID");
await api("GET","/dashboard/owner");
await api("GET","/dashboard/operational");
const different=await api("POST","/tenants",{
  name:"Isolated second company "+run.slice(0,8)
});
assert.notEqual(different.tenantId,registration.auth.tenantId);
const isolated=await api("GET","/sales/orders");
assert.ok(!isolated.some(o=>o.id===checkout.salesOrderId),
  "Other tenant must not see owner order");
process.stdout.write(JSON.stringify({
  result:"PASS",journey:"owner-first-day",
  note:"Disposable API only, PSP/carrier sandbox unverified",
  actions:steps.length,
  steps
},null,2)+"\n");
