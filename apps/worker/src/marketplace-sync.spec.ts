import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOzonPosting, normalizeWbOrder, normalizeYandexOrder } from "./marketplace-sync.js";

test("Wildberries FBS: raw finalPrice is already expressed in kopecks",()=>{
  const order=normalizeWbOrder({
    id:123,article:"ABC-01",finalPrice:129900,convertedCurrencyCode:643,
    createdAt:"2026-10-01T11:00:00Z"
  },"new");
  assert.equal(order?.lines[0]?.unitPriceMinor,"129900");
  assert.equal(order?.lines[0]?.externalOfferId,"ABC-01");
  assert.equal(order?.currency,"RUB");
});

test("Yandex FBS: per-line payment of 4500 RUB for three units must be divided",()=>{
  const order=normalizeYandexOrder({
    orderId:5001,programType:"FBS",fake:false,status:"PROCESSING",
    items:[{id:5,offerId:"SHOP-001",count:3,
      prices:{payment:{value:4500,currencyId:"RUR"}}}]
  });
  assert.equal(order?.lines[0]?.quantityMilli,"3000");
  assert.equal(order?.lines[0]?.unitPriceMinor,"150000");
  assert.equal(order?.currency,"RUB");
});

test("Yandex must not treat FBY stock as seller-managed FBS stock",()=>{
  assert.equal(normalizeYandexOrder({
    orderId:2,programType:"FBY",items:[{offerId:"SKU",count:1}]
  }),null);
});

test("Yandex fake orders are ignored for physical stock shadow demand",()=>{
  assert.equal(normalizeYandexOrder({
    orderId:2,programType:"FBS",fake:true,
    items:[{offerId:"SKU",count:1}]
  }),null);
});

test("Yandex refuses invalid quantities and empty line sets",()=>{
  assert.equal(normalizeYandexOrder({
    orderId:2,programType:"FBS",items:[{offerId:"SKU",count:-7}]
  }),null);
});

test("Ozon FBS preserves offer mapping and quantity without duplicating a SKU",()=>{
  const order=normalizeOzonPosting({
    posting_number:"P-1",status:"awaiting_packaging",products:[
      {offer_id:"ARTICLE-1",quantity:2,price:"199.90",product_id:12}
    ]
  });
  assert.equal(order?.externalOrderId,"P-1");
  assert.equal(order?.lines[0]?.quantityMilli,"2000");
  assert.equal(order?.lines[0]?.unitPriceMinor,"19990");
});

test("Ozon empty order cannot generate a phantom reservation",()=>{
  assert.equal(normalizeOzonPosting({
    posting_number:"P-EMPTY",products:[]
  }),null);
});
