#!/usr/bin/env node
/**
 * Disposable e-commerce owner test: category -> product -> edit ->
 * CSV/XLSX-style staging -> update SKU -> supplier -> PO -> actual receipt.
 * No production data, money or external payment is ever touched.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES",
  "BLOCKED: use only isolated disposable database");
const raw=process.env.COREBIZ_SMOKE_BASE_URL;
assert.ok(raw,"COREBIZ_SMOKE_BASE_URL is required");
const origin=new URL(raw);
assert.equal(origin.protocol,"http:");
assert.ok(["localhost","127.0.0.1","[::1]"].includes(origin.hostname));
assert.equal(origin.username,"");assert.equal(origin.password,"");
assert.equal(origin.search,"");assert.equal(origin.hash,"");
const webOrigin=process.env.COREBIZ_SMOKE_WEB_ORIGIN??"http://localhost:3000";
const run=randomUUID();
let cookie="",phase="startup",checks=0;
async function request(method,path,body,expected=method==="POST"?201:200){
  const response=await fetch(new URL("/api/v1"+path,origin),{
    method,redirect:"error",signal:AbortSignal.timeout(25000),
    headers:{Origin:webOrigin,...(cookie?{Cookie:cookie}:{}),
      ...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const session=response.headers.get("set-cookie");
  if(session?.startsWith("corebiz_session="))cookie=session.split(";")[0];
  const status=Array.isArray(expected)?expected:[expected];
  assert.ok(status.includes(response.status),
    phase+" "+method+" "+path.split("?")[0]+
    " returned "+response.status+" expected "+status.join("/"));
  const result=await response.json();
  assert.equal(result.ok,response.status>=200&&response.status<300);
  checks++;
  return result.data;
}
const get=(path,expected)=>request("GET",path,undefined,expected??200);
const post=(path,data,expected)=>request("POST",path,data,expected??201);
const patch=(path,data,expected)=>request("PATCH",path,data,expected??200);
const rub=(number)=>String(BigInt(number)*100n);

async function main(){
  phase="owner registration";
  await get("/health/ready");
  const owner=await post("/auth/register",{
    email:"catalog-owner-"+run+"@example.invalid",
    password:"CatalogOwner-"+run,
    companyName:"Тестовый магазин "+run.slice(0,7)
  });
  assert.equal(owner.auth.isOwner,true);
  await request("PUT","/customization/business-vertical",{
    verticalCode:"ECOMMERCE_STORE"
  });

  phase="category and rich product";
  const category=await post("/catalog/products/categories",{
    name:"Товары для танцев "+run.slice(0,6)
  });
  const product=await post("/catalog/products",{
    name:"Футболка учебная",kind:"STOCKABLE",
    sku:"CAT-"+run.slice(0,12),
    salePriceMinor:rub(2400),costPriceMinor:rub(1100),
    barcode:"TEST"+run.slice(0,14),
    description:"Футболка для тренировок",
    categoryId:category.id,
    imageUrl:"https://example.com/product-test.jpg",
    attributes:{Размер:"M",Цвет:"Чёрный"}
  });
  assert.ok(product.productId&&product.skuId);
  const data=await get("/catalog/products/"+product.productId);
  assert.equal(data.category_id,category.id);
  assert.equal(data.cost_price_minor,rub(1100));
  assert.equal(data.attributes.Размер,"M");
  assert.equal(data.stock.length,0);

  phase="product edit and duplicate prevention";
  await patch("/catalog/products/"+product.productId,{
    name:"Футболка учебная улучшенная",
    description:"Новая редакция карточки",
    salePriceMinor:rub(2500),
    attributes:{Размер:"L",Цвет:"Чёрный"}
  });
  const after=await get("/catalog/products/"+product.productId);
  assert.equal(after.sale_price_minor,rub(2500));
  assert.equal(after.cost_price_minor,rub(1100));
  assert.equal(after.attributes.Размер,"L");
  await post("/catalog/products",{
    name:"Дубль",sku:product.sku.toLowerCase()
  },400);

  phase="CSV import with preview and update";
  const anotherSku="WATER-"+run.slice(0,10);
  const csv=[
    "Название;Артикул;Цена;Закупочная цена;Категория;Описание;Фото;Характеристика: Цвет",
    "Футболка обновлена;"+product.sku+";2600;;Товары для танцев "+
      run.slice(0,6)+";;;Синий",
    "Бутылка тренировочная;"+anotherSku+";900;350;Аксессуары;750 мл;;Белый"
  ].join("\r\n");
  const input={
    entityType:"PRODUCTS",filename:"catalog-products.csv",
    contentBase64:Buffer.from("\uFEFF"+csv,"utf8").toString("base64"),
    idempotencyKey:"catalog-batch-"+run
  };
  const batch=await post("/migration/ingest",input);
  assert.equal(batch.validCount,2);
  assert.equal(batch.errorCount,0);
  const preview=await get("/migration/"+batch.batchId+"/preview");
  assert.equal(preview.rows.length,2);
  assert.ok(preview.rows[0].normalized_data.attributes.includes("Цвет"));
  const imported=await post("/migration/"+batch.batchId+"/import",{
    updateExisting:true
  });
  assert.equal(imported.updated,1);
  assert.equal(imported.imported,2);
  assert.equal(imported.reconciliation.balanced,true);
  const updated=await get("/catalog/products/"+product.productId);
  assert.equal(updated.sale_price_minor,rub(2600));
  // Empty cost cell never changes previously saved confidential cost.
  assert.equal(updated.cost_price_minor,rub(1100));
  assert.equal(updated.attributes.Цвет,"Синий");
  const listed=await get("/catalog/products");
  const bottle=listed.find(row=>row.sku===anotherSku);
  assert.ok(bottle,"Second SKU from CSV must be in shared catalog");
  const replay=await post("/migration/"+batch.batchId+"/import",{
    updateExisting:true
  });
  assert.equal(replay.reconciliation.balanced,true);
  const afterReplay=await get("/catalog/products");
  assert.equal(afterReplay.filter(row=>row.sku===anotherSku).length,1);

  phase="warehouse and purchase order";
  const warehouse=await post("/inventory/warehouses",{
    name:"Тестовый склад "+run.slice(0,6),code:"ST-"+run.slice(0,6)
  });
  const supplier=await post("/procurement/suppliers",{
    displayName:"Тестовый поставщик "+run.slice(0,6),type:"ORGANIZATION"
  });
  const purchase=await post("/procurement/orders",{
    supplierPartyId:supplier.id,destinationWarehouseId:warehouse.id,
    lines:[{skuId:product.skuId,quantityMilli:"5000",unitCostMinor:rub(1050)}]
  });
  assert.equal(purchase.version,1);
  const beforeReceipt=await get("/inventory/balances");
  assert.ok(!beforeReceipt.some(x=>x.skuId===product.skuId&&
    BigInt(x.physicalMilli)>0n),"Purchase order is not physical stock");
  await patch("/procurement/orders/"+purchase.id+"/confirm",{version:1});
  const lines=await get("/procurement/orders/"+purchase.id+"/lines");
  assert.equal(lines.length,1);
  const key="catalog-receipt-"+run;
  const payload={
    idempotencyKey:key,
    lines:[{purchaseOrderLineId:lines[0].id,quantityMilli:"5000"}]
  };
  const receipt=await post("/procurement/orders/"+purchase.id+"/receipts",payload);
  const repeated=await post("/procurement/orders/"+purchase.id+"/receipts",payload);
  assert.equal(receipt.receiptId,repeated.receiptId);
  const afterReceipt=await get("/inventory/balances");
  const stocked=afterReceipt.find(x=>x.warehouseId===warehouse.id&&
    x.skuId===product.skuId);
  assert.equal(stocked.physicalMilli,"5000");
  assert.equal(stocked.availableMilli,"5000");
  await post("/catalog/products/"+product.productId+"/archive",{},400);

  process.stdout.write(JSON.stringify({
    result:"PASS",mode:"DISPOSABLE_CATALOG_OWNER_E2E",
    roles:["OWNER"],checks,createdSKUs:2,warehouses:1,receipts:1,
    safeguards:["preview","SKU dedupe","non-destructive price update",
      "no fake stock on PO","idempotent goods receipt","no archive with stock"],
    noPSPtested:true,noProductionReadinessClaimed:true
  })+"\n");
}
main().catch(error=>{
  process.stderr.write("CATALOG_E2E_FAIL "+phase+": "+
    String(error?.message??"unknown").slice(0,350)+"\n");
  process.exitCode=1;
});
