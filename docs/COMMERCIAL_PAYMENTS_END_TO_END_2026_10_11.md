# CoreBiz — реализация SaaS-оплаты, магазинов, доставки, чеков и возвратов
Дата: 2026-10-11. Ветка: `main`, без GitHub Actions/CI.

## Что реализовано

**SaaS / CoreBiz**: при выборе платного тарифа сервер создаёт платёж в
YooKassa из `billing_plan.monthly_price_minor`. Клиент перенаправляется
на платёжную форму провайдера. Подписка изменяется **только** после
авторизованного GET /v3/payments/:id и сравнения идентификатора
CoreBiz-intent, назначения, точной суммы и валюты. Повторный webhook
не продлевает подписку второй раз: используется заблокированная строка
intent и `billing_event.idempotency_key`. Самостоятельная активация
тарифа в старом `billing/select-plan` без платежа по-прежнему закрыта.

**Магазины арендаторов**: отдельный YooKassa shop ID и API-секрет у
каждого продавца, зашифрованный AES-256-GCM. Деньги покупателя НЕ
идут через платёжный аккаунт CoreBiz. Публичный checkout создаёт
SalesOrder/OMS, связывает склад и подтверждённый метод получения;
последующая онлайн-оплата записывается в `commerce_payment_intent`.
После проверки у PSP вызывается **существующий**
`FinanceService.receiveSalesPayment` с тем же idempotency key
при повторных уведомлениях.

**Доставка**: серверный справочник самовывоза (бесплатно) и
курьера продавца (фиксированный тариф), выбор метода/адреса, неизменяемый
снимок в `commerce_order_delivery`, отдельная платная строка доставки
в SalesOrder/чеке. Цена доставки с браузера не принимается. Оплата
возможна только при наличии настроенного способа получения. Пока
нет расчёта доставки по API СДЭК/Boxberry/Почты РФ и передачи отправлений.

**Фискализация**: в запрос YooKassa передаётся объект `receipt`,
построенный по реальным строкам SalesOrder и конфигурации продавца.
Доступны актуальные 2026 VAT коды включая 22% = 11 и 22/122 = 12.
Без явно включённой продавцом настройки подключения онлайн-кассы
новый PSP-платёж запрещён. Отдельно сохраняется
`fiscal_status`: `PENDING/SUCCEEDED/FAILED`, поэтому «оплачено»
не означает «чек зарегистрирован».

**Возвраты**: API продавца делает **полный** возврат YooKassa,
идемпотентный вызов PSP, повторную проверку GET /v3/refunds/:id,
после чего проводит возврат через
`FinanceService.refundSalesPayment`. Чек возврата в режиме чеков
от YooKassa подтверждается отдельно по `receipt_registration`.
Частичные возвраты сознательно НЕ включены до полноценного
позиционного пересчёта чеков.

## Настройки для стенда/production

Задать на API-сервере через секретное хранилище, не в Git:
```bash
COREBIZ_PAYMENT_ENCRYPTION_KEY=<64 hex chars from openssl rand -hex 32>
COREBIZ_PAYMENT_RETURN_ORIGIN=https://your-corebiz-domain.example
COREBIZ_SAAS_YOOKASSA_SHOP_ID=<platform shop numeric ID>
COREBIZ_SAAS_YOOKASSA_SECRET=<platform API secret>
COREBIZ_SAAS_FISCAL_ENABLED=true
COREBIZ_SAAS_FISCAL_VAT_CODE=11
COREBIZ_SAAS_TAX_SYSTEM_CODE=1
```
Использовать **собственные** подтверждённые ставки/режимы из данных
организации: значения выше являются только примером конфигурации,
а не универсальной рекомендацией по ставке НДС.
`COREBIZ_PAYMENT_ENCRYPTION_KEY` нельзя менять после сохранения
мерчант-ключей без процедуры перевыпуска/ротации: старые секреты
перестанут расшифровываться. Не печатать значения ключей в логах.

Каждый владелец магазина подключает **свои** shop ID и secret через
`/app/sites/payments`, указывает фискальную конфигурацию и способы
получения. Он должен отдельно подключить онлайн-кассу у оператора
фискальных данных / провайдера кассы, настроить обработку чеков
и убедиться, что YooKassa вправе регистрировать чеки.

Установить URL webhook **в каждом аккаунте YooKassa**:
`https://<api-public-host>/api/v1/payments/webhooks/yookassa`.
События: `payment.succeeded`, `payment.canceled`,
`refund.succeeded`. Важен действующий публичный HTTPS.
Сервер не доверяет полям webhook без последующего
авторизованного запроса к YooKassa. Нельзя выдавать подтверждение
оплаты просто по переходу на `return_url`.

## Пользовательские пути

- SaaS: `/app/settings/billing` → тариф → YooKassa →
  успешное подтверждение через API → продлённый `tenant_subscription`.
- Продавец: `/app/sites/payments` → shop ID, зашифрованный secret,
  ККТ/ставка → самовывоз/курьер → тест покупки.
- Покупатель: каталог → корзина → выбор метода/адреса →
  `storefront.checkout` → SalesOrder и OMS →
  `/payments/storefront/carts/:cartKey/start` → YooKassa →
  `/payments/storefront/carts/:cartKey/status` →
  Finance: `PAID` только после GET у PSP.
- Возврат продавца с правом `finance.write`:
  `POST /api/v1/payments/stores/orders/:orderId/full-refund`
  → provider full refund → GET provider status →
  запись `FinanceService.refundSalesPayment` →
  `GET /api/v1/payments/refunds/:refundId/status`.

## Обязательная сквозная приёмка на изолированном стенде

1. Отдельная PostgreSQL, non-owner non-BYPASSRLS app-роль и Redis;
   replay миграций 227, 228, 229 в корректном порядке.
2. Сборка `pnpm typecheck`, `pnpm test`, `pnpm build`,
   `pnpm stability:check`; тесты безопасности tenant RLS.
3. Две компании с двумя разными PSP merchants: компания А не видит
   и не списывает операции компании Б. Не использовать платформенный
   shop ID для платежей магазина.
4. На тестовых кошельках YooKassa провести SaaS оплату:
   попытка без webhook не активирует тариф; поддельный webhook не
   активирует; авторизованное подтверждение активирует один раз.
5. Повторить same webhook и return URL 10 раз, имитировать обрыв сети
   между create-provider и checkpoint в DB; один PSP charge / один ledger.
6. Проверить платёж товара с доставкой (стоимость и строки SalesOrder
   совпадают с receipt items), заказ с бесплатным самовывозом,
   некорректный email, архивный SKU, изменения корзины после checkout.
7. Проверить чеки `receipt_registration=succeeded`,
   ошибки `pending/failed` и попадание в ручную очередь обработки.
8. Проверить полный возврат, повторный refund webhook и появление
   **одной** обратной финансовой записи.
9. Конкурентные покупки последнего экземпляра на складе и
   просроченные неоплаченные резервы — ВАЖНЫЙ сценарий отдельной
   проверки; автоматическое освобождение просроченных резервов
   пока не завершено.
10. Проверить приложение на собственном домене/HTTPS,
    cookie/origin, редирект YooKassa и мобильную версию.
11. При включённом `app.tenant_id` выполнить
    `scripts/commerce_payments_reconcile.sql`,
    сверку банка и реестр фактических операций YooKassa.
12. Реальный выпуск допускается только после юридической проверки
    54-ФЗ, ККТ/ОФД и дополнительного чека зачёта предоплаты,
    когда товар передаётся позже оплаты.

## Команды проверки без CI

```bash
git checkout main && git pull --ff-only origin main
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build
pnpm stability:check
node scripts/migration-preflight.mjs
```

Полный `scripts/production-gate.sh` — только против disposable DB и
loopback staging URL; в нём есть тестовые мутации бизнес-данных.
В рабочей базе нельзя выполнять smoke/golden test с реальными деньгами.

## Что осталось P0, несмотря на реализацию API

- Не выполнены реальные миграции и end-to-end PSP tests: **нет PASS evidence**.
- Для цифровой SaaS-подписки сделаны разовые платежи и продление на месяц.
  Автоматическое рекуррентное списание не подключено.
- Чек зачёта предоплаты при отгрузке (если требуется применимым сценарием)
  не реализован; консультация специалиста по фискальным процессам обязательна.
- Нет интеграций ПВЗ/перевозчиков, печати этикеток и автоматических
  трек-номеров. Доступны только встроенные способы получения.
- Частичные возвраты и автоматическая сверка полного реестра
  PSP с выпиской банка требуют отдельной разработки.
- Нет полностью проверенного процесса автоматического освобождения
  резерва после неоплаты — нужен lifecycle-тест OMS.
- Не проверены реальный HTTPS на доменах арендаторов,
  обработка timeout и боевое восстановление.
- Нельзя обещать юридически полную 54-ФЗ совместимость,
  пока чеки, акт выдачи и возвраты не пройдут реальный сценарий.

**Итог: интеграционный код реализован, но массовый коммерческий запуск
остаётся NO-GO до runtime-приёмки и закрытия обозначенных P0.**

Документация:
- https://yookassa.ru/developers/payment-acceptance/getting-started/quick-start
- https://yookassa.ru/developers/using-api/webhooks
- https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/parameters-values
- https://yookassa.ru/developers/payment-acceptance/after-the-payment/refunds
- https://yookassa.ru/developers/payment-acceptance/receipts/54fz/yoomoney/refunds
