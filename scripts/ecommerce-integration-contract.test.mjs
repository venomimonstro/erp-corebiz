import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=p=>readFileSync(new URL("../"+p,import.meta.url),"utf8");

const wizard=read("apps/web/app/app/commerce/launch/page.tsx");
const cms=read("apps/web/app/app/sites/page.tsx");
const homepage=read("apps/web/app/app/commerce/page.tsx");
const start=read("apps/web/app/app/start/page.tsx");
const sidebar=read("apps/web/components/app-sidebar.tsx");
const sites=read("apps/api/src/modules/business/sites/sites.service.ts");
const storefront=read("apps/api/src/modules/business/sites/storefront.service.ts");
const release=read("apps/api/src/modules/platform/go-live/commercial-checkout-policy.ts");
const e2e=read("scripts/ecommerce-cms-owner-e2e.mjs");
const controller=read("apps/api/src/modules/business/sites/sites.controller.ts");

test("One merchant entry connects niche, CMS and operational order control",()=>{
  assert.match(start,/ECOMMERCE_STORE:"\/app\/commerce\/launch"/);
  assert.match(sidebar,/\/app\/commerce\/launch/);
  assert.match(sidebar,/"commerce-launch": "sites.read"/);
  assert.match(homepage,/href="\/app\/commerce\/launch"/);
  assert.match(wizard,/href="\/app\/sales\/orders"/);
  assert.match(wizard,/href="\/app\/catalog\/products"/);
  assert.match(wizard,/href="\/app\/inventory\/stock"/);
  assert.match(wizard,/href="\/app\/sites\/payments"/);
  assert.match(wizard,/href="\/app\/settings\/go-live"/);
});

test("Internal CMS store is created over SKU and OMS, not a duplicate product catalog",()=>{
  assert.match(wizard,/template:"STORE"/);
  assert.match(sites,/INSERT INTO storefront_config/);
  assert.match(sites,/INSERT INTO site_block/);
  assert.match(sites,/PRODUCT_GRID/);
  assert.match(sites,/return \{\s*id: site\.id/);
  assert.match(controller,/@Post\(\)/);
  assert.match(storefront,/FROM sku s/);
  assert.match(storefront,/FROM inventory_balance b/);
  assert.match(storefront,/FROM inventory_policy ip/);
  assert.match(storefront,/this\.sales\.create\(context/);
  assert.match(storefront,/idempotencyKey: "storefront:cart:"/);
});

test("Store creation uses a cancellable form and never hides unknown commit state",()=>{
  assert.match(cms,/onSubmit=\{event=>void createSite\(event\)\}/);
  assert.match(cms,/siteCreating/);
  assert.match(cms,/setSiteId\(current=>rows\.some/);
  assert.doesNotMatch(cms,/window\.prompt\(\s*template === "STORE"/);
  assert.match(wizard,/Проверьте список сайтов перед повторным созданием/);
  assert.match(wizard,/setReadiness\(null\)/);
});

test("No delivery => no customer checkout, no paid green badge without E2E",()=>{
  assert.match(storefront,/&&site\.delivery_configured/);
  assert.match(storefront,/canLaunchWithOnlinePayments:false/);
  assert.match(wizard,/release\?\.ready/);
  assert.match(wizard,/canLaunchWithOnlinePayments/);
  assert.match(release,/PAYMENT_E2E/);
  assert.match(release,/FISCAL_E2E/);
  assert.match(release,/FULFILLMENT_E2E/);
  assert.match(e2e,/canLaunchWithOnlinePayments,false/);
});

test("Merchant e2e tests a real public cart and idempotent OMS order",()=>{
  assert.match(e2e,/COREBIZ_CONFIRM_DISPOSABLE_DB/);
  assert.match(e2e,/127\.0\.0\.1/);
  assert.match(e2e,/template:"STORE"/);
  assert.match(e2e,/versions\/"\+site\.versionId\+"\/publish"/);
  assert.match(e2e,/\/storefront\/carts\//);
  assert.match(e2e,/created\.salesOrderId/);
  assert.match(e2e,/retry\.salesOrderId,created\.salesOrderId/);
  assert.match(e2e,/\/inventory\/balances/);
  assert.match(e2e,/\/go-live\/readiness/);
});
