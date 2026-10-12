#!/usr/bin/env node
/**
 * Browser journey on a disposable LOCAL stack only. Requires a local
 * "playwright" dependency and an installed Chromium browser. No CI/Actions.
 *
 * COREBIZ_CONFIRM_DISPOSABLE_DB=YES \
 * COREBIZ_SMOKE_WEB_URL=http://localhost:3000 \
 * node scripts/smoke-browser-journey.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

if (process.env.COREBIZ_CONFIRM_DISPOSABLE_DB !== "YES") {
  throw new Error("BLOCKED: a disposable DB must be explicitly confirmed");
}
const raw = process.env.COREBIZ_SMOKE_WEB_URL;
if (!raw) throw new Error("BLOCKED: COREBIZ_SMOKE_WEB_URL required");
const url = new URL(raw);
if (url.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
  throw new Error("BLOCKED: browser smoke tests require local HTTP only");
}

const { chromium } = await import("playwright").catch(() => {
  throw new Error("Playwright is not installed locally; add it only to the test environment");
});

let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const email = "ui-smoke-" + randomUUID() + "@example.invalid";
  const password = "SmokeUser-" + randomUUID();

  await page.goto(new URL("/signup", url).href, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Компания").fill("Test Browser Company");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill(password);
  // Signup now requires a business vertical, and routes to /app/start.
  await page.getByLabel("Основной вид бизнеса").selectOption("ECOMMERCE_STORE");
  await page.getByRole("button", { name: "Начать бесплатно" }).click();
  await page.waitForURL("**/app/start", { timeout: 20000 });
  await page.getByRole("heading", {
    name:"Настройте бизнес, а не программу"
  }).waitFor();
  await page.getByRole("link",{name:"Мой кабинет →"}).click();
  await page.waitForURL("**/app", { timeout: 20000 });
  await page.getByRole("heading", { name: "Сегодня" }).waitFor();
  await page.getByText("Ваше рабочее место").waitFor();

  const profile = page.getByLabel("Показывать разделы для");
  await profile.selectOption("service");
  assert.equal(await profile.inputValue(), "service");
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.getByLabel("Показывать разделы для").inputValue(), "service",
    "business menu must persist across reloads");

  await page.setViewportSize({ width: 390, height: 844 });
  const menu = page.getByRole("button", { name: "Открыть меню" });
  await menu.click();
  const navigation = page.getByRole("navigation", { name: "Разделы системы" });
  await navigation.waitFor({ state: "visible" });
  await page.getByRole("link", { name: "Сегодня", exact: true }).first().click();
  await page.getByRole("heading", { name: "Сегодня" }).waitFor();

  // Owner navigates the concrete setup screens after registration.
  // Validate client routes render with the selected niche/tenant.
  for(const [route,heading] of [
    ["/app/start","Настройте бизнес, а не программу"],
    ["/app/settings/team","Сотрудники и приглашения"],
    ["/app/catalog/products","Товары"],
    ["/app/inventory/stock","Остатки"],
    ["/app/sites","Сайты"]
  ]) {
    await page.goto(new URL(route,url).href,{waitUntil:"domcontentloaded"});
    await page.getByRole("heading",{name:heading,exact:true})
      .waitFor({timeout:20000});
  }
  await page.goto(new URL("/app",url).href,{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Сегодня"}).waitFor();

  // A fresh browser session is required to validate actual re-login.
  // Reopening /login with an authenticated cookie may auto-redirect.
  await page.context().clearCookies();
  await page.goto(new URL("/login", url).href, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL("**/app", { timeout: 20000 });
  await page.getByRole("heading", { name: "Сегодня" }).waitFor();

  // Exercise resilience: onboarding temporarily returns 503, but the owner
  // must retain operational KPIs instead of receiving a blank dashboard.
  await page.route("**/api/v1/dashboard/activation",async route=>{
    await route.fulfill({
      status:503,contentType:"application/json",
      body:JSON.stringify({ok:false,error:{message:"DISPOSABLE_ONBOARDING_DOWN"}})
    });
  });
  await page.reload({waitUntil:"domcontentloaded"});
  await page.locator(".owner-kpi").first().waitFor({timeout:20000});
  await page.getByText(
    "Подсказки первого запуска временно недоступны.",
    {exact:false}
  ).waitFor({timeout:20000});
  await page.unroute("**/api/v1/dashboard/activation");

  console.log("PASS: signup → owner dashboard → profile → mobile navigation → login → onboarding outage resilience");
  console.log("Local disposable environment only. This is not a production sign-off.");
} finally {
  await browser?.close();
}
