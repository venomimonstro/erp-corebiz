#!/usr/bin/env node
/**
 * E-commerce owner acceptance, isolated API + disposable PostgreSQL/Redis ONLY.
 * Creates one merchant, 2 SKUs, stock, an internal CMS store, publishes it,
 * configures pickup and checks that public checkout produces ONE OMS order.
 * Does NOT use real payments, fiscal registers or shipping providers.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES",
  "BLOCKED: disposable database must be confirmed explicitly");
const address=process.env.COREBIZ_SMOKE_BASE_URL;
assert.ok(address,"COREBIZ_SMOKE_BASE_URL must identify an isolated local API");
const base=new URL(address);
assert.equal(base.protocol,"http:");
assert.ok(["localhost","127.0.0.1","[::1]"].includes(base.hostname));
assert.equal(base.username,"");assert.equal(base.password,"");
assert.equal(base.search,"");assert.equal(base.hash,"");
const origin=process.env.COREBIZ_SMOKE_WEB_ORIGIN??"http://localhost:3000";
const tag=randomUUID().replace(/-/g,"");
const owner={cookie:""};
const count={requests:0,denied:0};
let stage="connect";

async function call(method,path,body,expected=method==="POST"?201:200){
  const response=await fetch(new URL("/api/v1"+path,base),{
    method,redirect:"error",signal:AbortSignal.timeout(25000),
    headers:{
      Origin:origin,
      ...(owner.cookie?{Cookie:owner.cookie}:{}),
      ...(body===undefined?{}:{"Content-Type":"application/json"})
    },
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const cookie=response.headers.get("set-cookie");
  if(cookie?.startsWith("corebiz_session="))owner.cookie=cookie.split(";")[0];
  const codes=Array.isArray(expected)?expected:[expected];
  count.requests++;
  if(response.status>=400)count.denied++;
  assert.ok(codes.includes(response.status),
    stage+": "+method+" "+path.split("?")[0]+
    " HTTP "+response.status+" expected "+codes.join("/"));
  const value=await response.json();
  assert.equal(value.ok,response.status<300,stage+": JSON API envelope");
  return value.data;
}
const get=(p,expected=200)=>call("GET",p,undefined,expected);
const post=(p,b,expected=201)=>call("POST",p,b,expected);
const put=(p,b,expected=200)=>call("PUT",p,b,expected);

async function main(){
  stage="01 registered owner";
  assert.equal((await get("/health/ready")).status,"ok");
  const account=await post("/auth/register",{
    email:"ecom-owner-"+tag+"@example.invalid",
    password:"SafeOwner-"+tag,
    companyName:"Disposable Moscow electronics "+tag.slice(0,6)
  });
  assert.ok(account.auth.tenantId);
  const vertical=await put("/customization/business-vertical",{
    verticalCode:"ECOMMERCE_STORE"
  });
  assert.equal(vertical.profileCode,"ECOMMERCE");
  stage="02 one catalog and warehouse";
  const warehouse=await post("/inventory/warehouses",{
    name:"Main Moscow warehouse "+tag.slice(0,6),
    code:"S"+tag.slice(0,7).toUpperCase()
  });
  const phone=await post("/catalog/products",{
    name:"Disposable phone "+tag.slice(0,8),kind:"STOCKABLE",
    salePriceMinor:"3699000",costPriceMinor:"2900000",
    description:"Sandbox-only electronic product"
  });
  const caseProduct=await post("/catalog/products",{
    name:"Disposable case "+tag.slice(0,8),kind:"STOCKABLE",
    salePriceMinor:"49000",costPriceMinor:"18000"
  });
  assert.ok(phone.skuId&&caseProduct.skuId);
  for(const p of [phone,caseProduct]){
    await post("/inventory/adjustments",{
      warehouseId:warehouse.id,skuId:p.skuId,quantityDeltaMilli:"3000",
      reason:"Disposable opening stock",
      idempotencyKey:"ecommerce-opening-"+tag+"-"+p.skuId
    });
  }
  const balances=await get("/inventory/balances");
  assert.ok(balances.some(x=>x.skuId===phone.skuId&&
    BigInt(x.physicalMilli)===3000n));
  stage="03 CMS site created atomically with storefront";
  const site=await post("/sites",{
    name:"Магазин электроники "+tag.slice(0,6),
    template:"STORE",
    publicSlug:"corebiz-ecom-"+tag.slice(0,20)
  });
  assert.ok(site.id&&site.pageId&&site.versionId);
  const initial=await get("/storefront/site/"+site.id+"/readiness");
  assert.equal(initial.canTestOrders,false);
  assert.equal(initial.canLaunchWithOnlinePayments,false);
  assert.equal(initial.checks.find(x=>x.code==="STORE_ENABLED")?.done,true);
  assert.equal(initial.checks.find(x=>x.code==="HOME_PUBLISHED")?.done,false);
  const pages=await get("/sites/"+site.id+"/pages");
  assert.ok(pages.some(p=>p.id===site.pageId));
  const editor=await get("/sites/pages/"+site.pageId+"/editor");
  assert.ok(editor.blocks.some(x=>x.block_type==="PRODUCT_GRID"),
    "STORE template must use a live SKU-backed product block");
  // Publishing CMS is explicit and separate from accepting payments.
  const published=await post("/sites/pages/"+site.pageId+
    "/versions/"+site.versionId+"/publish",{});
  assert.ok(published);
  stage="04 pickup, currency and indexed catalog";
  const pickup=await post("/payments/stores/"+site.id+"/delivery",{
    code:"PICKUP",title:"Disposable pickup point",mode:"PICKUP",
    feeMinor:"0",active:true
  });
  assert.ok(pickup.id);
  const ready=await get("/storefront/site/"+site.id+"/readiness");
  assert.equal(ready.canTestOrders,true,
    "Stock, published CMS and at least one receiving method required");
  assert.equal(ready.canLaunchWithOnlinePayments,false,
    "Published CMS is NOT certified fiscal/payment readiness");
  const catalog=await get("/storefront/"+site.publicSlug+"/catalog");
  const item=catalog.products.find(x=>x.sku_id===phone.skuId);
  assert.ok(item);
  assert.equal(item.sale_price_minor,"3699000");
  assert.equal(BigInt(item.atp_milli)>=1000n,true);
  assert.ok(!JSON.stringify(catalog).includes("cost_price_minor"),
    "Public catalog must never expose cost price");
  const list=await get("/payments/storefront/"+site.publicSlug+"/delivery");
  assert.ok(list.methods.some(x=>x.id===pickup.id));
  stage="05 guest cart and guaranteed single OMS order";
  const cart=await post("/storefront/"+site.publicSlug+"/carts",{});
  assert.ok(cart.cartKey);
  const shopping=await put("/storefront/carts/"+encodeURIComponent(cart.cartKey)+"/lines",{
    skuId:phone.skuId,quantityMilli:"1000"
  });
  assert.equal(shopping.status,"OPEN");
  assert.equal(BigInt(shopping.totalMinor),3699000n);
  const checkout={
    idempotencyKey:"ecommerce-test-"+tag,
    name:"Disposable test buyer",phone:"+79991234567",
    email:"sandbox-"+tag+"@example.invalid",
    deliveryMethodId:pickup.id
  };
  const created=await post("/storefront/carts/"+
    encodeURIComponent(cart.cartKey)+"/checkout",checkout);
  assert.equal(created.accepted,true);
  assert.ok(created.salesOrderId);
  const retry=await post("/storefront/carts/"+
    encodeURIComponent(cart.cartKey)+"/checkout",checkout);
  assert.equal(retry.salesOrderId,created.salesOrderId,
    "Network retry must return same OMS order");
  const persisted=await get("/storefront/carts/"+
    encodeURIComponent(cart.cartKey));
  assert.equal(persisted.status,"CHECKED_OUT");
  const orders=await get("/sales/orders");
  assert.ok(orders.some(x=>x.id===created.salesOrderId),
    "Public checkout order must appear in the same ERP sales journal");
  const after=await get("/inventory/balances");
  const stock=after.find(x=>x.skuId===phone.skuId&&x.warehouseId===warehouse.id);
  assert.ok(stock);
  assert.ok(BigInt(stock.reservedMilli)>=1000n ||
    created.allocationState==="BACKORDER",
    "Reservation OR visible explicit backorder required");
  stage="06 immutable launch gate and business continuity";
  const final=await get("/storefront/site/"+site.id+"/readiness");
  assert.equal(final.canLaunchWithOnlinePayments,false);
  const goLive=await get("/go-live/readiness");
  assert.equal(goLive.ready,false,
    "The disposable unpaid order cannot prove PSP/fiscal/fulfillment E2E");
  process.stdout.write(JSON.stringify({
    status:"PASS_ONLY_IF_EXECUTED",
    environment:"DISPOSABLE_LOCAL_API",
    scenarios:[
      "signup_and_niche","catalog_2_skus","warehouse_stock",
      "cms_store_template","page_published","pickup",
      "public_catalog_price_no_cost","guest_cart","oms_order",
      "same_cart_replay_one_order","inventory_reservation_or_backorder",
      "production_payment_go_blocked"
    ],
    checks:count,createdSkuCount:2,storeId:site.id,
    orderId:created.salesOrderId,
    note:"No PSP, KKT, FNS, legal checkout or carrier test has been performed"
  },null,2)+"\n");
}
main().catch(error=>{
  process.stderr.write("ECOMMERCE_CMS_E2E_FAIL stage="+stage+
    " error="+String(error?.message??"unknown").slice(0,260)+"\n");
  process.exitCode=1;
});
