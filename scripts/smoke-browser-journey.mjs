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
  await page.getByRole("button", { name: "Начать бесплатно" }).click();
  await page.waitForURL("**/app", { timeout: 20000 });
  await page.getByRole("heading", { name: "Сегодня" }).waitFor();
  await page.getByRole("heading", { name: "Начните с одной операции" }).waitFor();

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

  await page.goto(new URL("/login", url).href, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button", { name: "Войти" }).click();
  await page.waitForURL("**/app", { timeout: 20000 });
  await page.getByRole("heading", { name: "Сегодня" }).waitFor();

  console.log("PASS: signup → first dashboard → profile setting → responsive menu → login");
  console.log("Local disposable environment only. This is not a production sign-off.");
} finally {
  await browser?.close();
}
