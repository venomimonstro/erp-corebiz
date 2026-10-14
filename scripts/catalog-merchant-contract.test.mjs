import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const code=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const catalog=code("apps/api/src/modules/business/catalog/catalog.service.ts");
const controller=code("apps/api/src/modules/business/catalog/catalog.controller.ts");
const page=code("apps/web/app/app/catalog/products/page.tsx");
const css=code("apps/web/app/styles.css");
const migration=code("apps/api/src/modules/business/migration/migration.service.ts");
const migrationPage=code("apps/web/app/app/migration/page.tsx");
const procurement=code("apps/web/app/app/purchases/page.tsx");
const purchaseService=code("apps/api/src/modules/business/procurement/procurement.service.ts");
const owner=code("scripts/catalog-product-owner-e2e.mjs");
const csv=code("apps/web/public/templates/catalog-products.csv");

test("catalog uses existing product / variant / sku and never writes balances directly",()=>{
  assert.match(catalog,/INSERT INTO product\(/);
  assert.match(catalog,/INSERT INTO product_variant\(/);
  assert.match(catalog,/INSERT INTO sku\(/);
  assert.match(catalog,/UPDATE product_variant SET attributes/);
  assert.match(catalog,/UPDATE sku SET/);
  assert.doesNotMatch(catalog,/UPDATE inventory_balance SET/);
  assert.match(catalog,/FROM inventory_balance b/);
});

test("catalog supports categories, details, metadata, image, prices and safe archival",()=>{
  for(const route of [
    '@Get("categories")','@Post("categories")',
    '@Get(":productId")','@Patch(":productId")',
    '@Post(":productId/archive")'
  ])assert.ok(controller.includes(route),route);
  for(const feature of [
    "attributes", "category_id", "description", "image_url", "barcode",
    "sale_price_minor", "cost_price_minor"
  ])assert.ok(catalog.includes(feature),feature);
  assert.match(catalog,/Стоимость|Закупочная цена|закупочной цены/i);
  assert.match(catalog,/this\.mayReadCost\(client,context\)/);
  assert.match(catalog,/Есть остатки или резервы/);
  assert.match(catalog,/незавершённые заказы клиентов/);
  assert.match(catalog,/Сначала завершите закупки/);
  assert.match(catalog,/UPDATE sku SET status='ARCHIVED'/);
  assert.match(catalog,/UPDATE product_variant SET status='ARCHIVED'/);
  assert.match(catalog,/UPDATE product SET status='ARCHIVED'/);
});

test("owner UI provides real forms, no blocking browser prompts",()=>{
  for(const field of [
    "Название товара", "Категория", "Закупочная цена",
    "Штрихкод", "Характеристики", "Складские остатки",
    "Архивировать товар", "Импорт Excel / CSV"
  ])assert.ok(page.includes(field),field);
  assert.match(page,/className="catalog-product-grid"/);
  assert.match(page,/catalog-drawer-overlay/);
  assert.match(css,/catalog-product-tile/);
  assert.doesNotMatch(page,/window\.(?:prompt|confirm|alert)\(/);
});

test("CSV and Excel preview knows images, characteristics, categories and safe updates",()=>{
  for(const field of [
    "category:","description:","imageUrl:","attributes:","salePriceProvided",
    "costPriceProvided","attributesProvided","seenProducts","seenBarcodes"
  ])assert.ok(migration.includes(field),field);
  assert.match(migration,/decodeCsv\(buffer\)/);
  assert.match(migration,/windows-1251/);
  assert.match(migration,/utf-16le/);
  assert.match(migration,/new ExcelJS\.Workbook\(\)/);
  assert.match(migration,/get\("category"\)/);
  assert.match(migration,/get\("imageUrl"\)/);
  assert.match(migration,/updateExisting/);
  assert.match(migration,/costPriceProvided==="true"/);
  assert.match(migration,/else skipped \+= 1/);
  assert.match(migration,/ИМПОРТ|Импорт закупочных цен/i);
  assert.match(migrationPage,/updateExisting/);
  assert.match(migrationPage,/catalog-products\.csv/);
  assert.match(csv,/Характеристика: Цвет/);
  assert.match(csv,/Закупочная цена/);
});

test("real stock comes from procurement receipt, not CSV or price update",()=>{
  assert.match(procurement,/\/procurement\/orders/);
  assert.match(procurement,/\/receipts/);
  assert.match(procurement,/warehouseId/);
  assert.match(procurement,/idempotencyKey/);
  assert.match(procurement,/sessionStorage/);
  assert.match(procurement,/Подтверждаю факт поступления/);
  assert.doesNotMatch(procurement,/window\.(?:prompt|confirm|alert)\(/);
  assert.match(purchaseService,/postMovement/);
  assert.doesNotMatch(migration,/INSERT INTO inventory_balance/);
});

test("disposable owner E2E tests successful and negative cases without live payments",()=>{
  for(const x of [
    "COREBIZ_CONFIRM_DISPOSABLE_DB","localhost","127.0.0.1",
    "/catalog/products/categories","/migration/ingest",
    "updateExisting:true","/procurement/orders/",
    "/inventory/balances","receipt.receiptId",
    "noProductionReadinessClaimed:true"
  ])assert.ok(owner.includes(x),x);
  assert.doesNotMatch(owner,/process\.stdout\.write\(.+cookie/s);
});
