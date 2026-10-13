#!/usr/bin/env node
/**
 * Disposable local browser scenario: register salon owner, create service,
 * employee, shifts and customer, then exercise appointment journal.
 * No real PSP/fiscal/notification operation.
 */
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";

assert.equal(process.env.COREBIZ_CONFIRM_DISPOSABLE_DB,"YES",
  "BLOCKED: explicitly confirm disposable DB");
const raw=process.env.COREBIZ_SMOKE_WEB_URL;
assert.ok(raw,"COREBIZ_SMOKE_WEB_URL required");
const url=new URL(raw);
assert.equal(url.protocol,"http:");
assert.ok(["localhost","127.0.0.1","[::1]"].includes(url.hostname),
  "Only a local isolated API/Web test stack is allowed");
assert.equal(url.username,"");assert.equal(url.password,"");
assert.equal(url.search,"");assert.equal(url.hash,"");
const {chromium}=await import("playwright").catch(()=>{
  throw new Error("Playwright is required only on the disposable test environment");
});
const browser=await chromium.launch({headless:true});
try{
  // Deliberately use a timezone different from the salon's Moscow timezone:
  // the calendar and free slots must follow the resource, not the operator.
  const page=await browser.newPage({
    viewport:{width:1440,height:900},timezoneId:"America/New_York"
  });
  const email="service-ui-"+randomUUID()+"@example.invalid";
  const password="Disposable-"+randomUUID();
  const suffix=randomUUID().slice(0,8);
  await page.goto(new URL("/signup",url).href,{waitUntil:"domcontentloaded"});
  await page.getByLabel("Компания").fill("Disposable salon "+suffix);
  await page.getByLabel("Основной вид бизнеса").selectOption("BEAUTY_SALON");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Пароль").fill(password);
  await page.getByRole("button",{name:"Начать бесплатно"}).click();
  await page.waitForURL("**/app/start",{timeout:30000});
  await page.goto(new URL("/app/service/desk",url).href,{waitUntil:"domcontentloaded"});
  await page.getByRole("heading",{name:"Рабочее место"}).waitFor({timeout:20000});
  await page.getByRole("button",{name:"Настройка",exact:true}).click();
  const servicePanel=page.locator(".service-desk-panel").filter({
    has:page.getByRole("heading",{name:"Услуги и цены"})
  });
  await servicePanel.getByLabel("Название").fill("Тестовая стрижка "+suffix);
  await servicePanel.getByLabel("Минут").fill("45");
  await servicePanel.getByLabel("Цена, ₽").fill("1200");
  await servicePanel.getByRole("button",{name:"Добавить услугу"}).click();
  await servicePanel.getByText("В каталоге: 1").waitFor({timeout:20000});

  const staffPanel=page.locator(".service-desk-panel").filter({
    has:page.getByRole("heading",{name:"Специалисты"})
  });
  await staffPanel.getByLabel("Имя специалиста").fill("Тестовый мастер "+suffix);
  await staffPanel.getByRole("button",{name:"Добавить специалиста"}).click();
  await staffPanel.getByText("Специалистов: 1",{exact:false}).waitFor({timeout:20000});

  const schedulePanel=page.locator(".service-desk-panel").filter({
    has:page.getByRole("heading",{name:"Рабочие смены"})
  });
  await schedulePanel.getByLabel("Специалист").selectOption({index:1});
  await schedulePanel.getByRole("button",{name:"Установить шаблон смен"}).click();
  await page.getByText("Установлен график:",{exact:false}).waitFor({timeout:20000});

  const pricingPanel=page.locator(".service-desk-panel").filter({
    has:page.getByRole("heading",{name:"Правила услуги конкретного мастера"})
  });
  await pricingPanel.getByLabel("Услуга").selectOption({index:1});
  await pricingPanel.getByLabel("Специалист").selectOption({index:1});
  await pricingPanel.getByLabel("Цена, ₽").fill("1750");
  await pricingPanel.getByLabel("Длительность для мастера, минуты (необязательно)").fill("50");
  await pricingPanel.getByRole("button",{
    name:"Сохранить правило мастера"
  }).click();
  await page.getByText("Правило мастера сохранено.",{
    exact:false
  }).waitFor({timeout:20000});

  const customerPanel=page.locator(".service-desk-panel").filter({
    has:page.getByRole("heading",{name:"Первый клиент"})
  });
  await customerPanel.getByLabel("Имя").fill("Disposable Client "+suffix);
  await customerPanel.getByLabel("Телефон").fill("+79991112233");
  await customerPanel.getByRole("button",{name:"Создать клиента"}).click();
  await page.getByText("Клиент добавлен в CRM",{exact:false})
    .waitFor({timeout:20000});

  // The UI is now ready to book, but the server still exclusively decides
  // which employee/time combination is available.
  await page.getByRole("button",{name:"Журнал"}).click();
  await page.getByRole("button",{name:"+ Новая запись"}).click();
  const drawer=page.getByRole("dialog",{name:"Новая запись"});
  await drawer.getByLabel("Услуга").selectOption({index:1});
  await drawer.getByLabel("Специалист").selectOption({index:1});
  const target=new Date();
  target.setDate(target.getDate()+1);
  while(target.getDay()===0||target.getDay()===6)
    target.setDate(target.getDate()+1);
  const day=[target.getFullYear(),String(target.getMonth()+1).padStart(2,"0"),
    String(target.getDate()).padStart(2,"0")].join("-");
  await drawer.getByLabel("Дата").fill(day);
  const options=drawer.getByLabel("Свободное время").locator("option");
  // The option is produced only after the server validates the slot.
  await options.nth(1).waitFor({state:"attached",timeout:20000});
  await drawer.getByLabel("Свободное время").selectOption({index:1});
  await drawer.getByLabel("Клиент (необязательно)").selectOption({index:1});
  const responsePromise=page.waitForResponse(response=>
    response.url().includes("/api/v1/service/bookings")&&
    response.request().method()==="POST"
  );
  await drawer.getByRole("button",{name:"Сохранить запись"}).click();
  const bookingResponse=await responsePromise;
  assert.equal(bookingResponse.status(),201);
  const bookingBody=await bookingResponse.json();
  assert.ok(bookingBody.ok&&bookingBody.data?.id);
  await drawer.waitFor({state:"hidden",timeout:20000});
  const detailResponse=await page.request.get(
    new URL("/api/v1/service/bookings/"+
      encodeURIComponent(bookingBody.data.id),url).href
  );
  assert.equal(detailResponse.status(),200);
  const detailBody=await detailResponse.json();
  assert.equal(detailBody.data.price_minor_snapshot,"175000",
    "Individual master price must override catalog base price on booking");

  await page.getByRole("button",{name:"Клиенты",exact:true}).click();
  await page.locator(".service-desk-customer-list button")
    .filter({hasText:"Disposable Client "+suffix}).click();
  await page.getByRole("heading",{name:"Disposable Client "+suffix})
    .waitFor({timeout:20000});

  await page.getByRole("button",{name:"Экономика",exact:true}).click();
  await page.getByRole("heading",{name:"Экономика услуг"})
    .waitFor({timeout:20000});

  await page.setViewportSize({width:390,height:844});
  await page.getByRole("button",{name:"Журнал"}).click();
  await page.getByRole("heading",{name:"Журнал записи"})
    .waitFor({timeout:20000});
  const overflow=await page.evaluate(()=>({
    document:document.documentElement.scrollWidth,
    viewport:window.innerWidth
  }));
  assert.ok(overflow.document<=overflow.viewport+3,
    "Mobile page overflows viewport horizontally");
  console.log(JSON.stringify({
    result:"PASS",scenario:"salon owner service desk",
    verified:["sign-up","service price","employee","shifts","customer",
      "personal pricing","booking","customer history","economics","390px responsive"]
  }));
}finally{await browser.close();}
