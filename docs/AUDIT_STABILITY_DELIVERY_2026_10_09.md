# CoreBiz — стабилизация и приёмка (2026-10-09)

Repository: venomimonstro/erp-corebiz; direct commits into main, no GitHub Actions.

## Выполнено в исходниках
- Finance P0: все четыре вида платежей (счёт, заказ, закупка, возврат) сериализуют повтор ключа посредством PostgreSQL advisory transaction lock. Повтор сравнивает документ, сумму, направление, вид платежа и при указанном счёте — account ID; несовпадение = 409.
- Public API: тела заявок, настроек форм, корзины, checkout и магазина отбрасывают некорректные типы до SQL. Отмена подписки принимает только boolean.
- RLS: runtime readiness сверяет привилегии на пять auth functions в дополнение к политикам RLS и роли PostgreSQL; migration 119 делает узкие auth lookups.
- Migrations: historical duplicate ordinal numbering yields WARN (ordering by full filename deterministic), destructive SQL still blocks, manual release-check executes standalone regression test.
- UX: мобильное меню и локальный профиль бизнес-навигации, три быстрых сценария на пустом экране владельца.
- Tests added: auth, public forms, cart, finance idempotency, billing and API/customer simulation scripts; headless Playwright browser smoke is optional on a local disposable host.

## Не проверено / остаётся
- pnpm install, typecheck, tests, build, migration replay 001–119, RLS with least-privileged runtime role, full browser E2E, load and backup restore.
- Сквозное исполнение WMS/OMS под нагрузкой, callbacks сторонних сервисов, сертификация бухгалтерии РФ и зарплаты, POS/54-ФЗ, маркировка и MRP остаются отдельными задачами.
- Никаких заявлений о production PASS до реального протокола тестирования и подтверждённого DB backup/restore.

## Проверки только на одноразовом стенде
corepack enable; pnpm install --frozen-lockfile
node --test scripts/migration-preflight.test.mjs
node scripts/migration-preflight.mjs
pnpm typecheck && pnpm test && pnpm build
export COREBIZ_DISPOSABLE_DATABASE_URL=postgresql://...; export COREBIZ_CONFIRM_DISPOSABLE_DB=YES
pnpm release:check
COREBIZ_SMOKE_BASE_URL=http://127.0.0.1:4000 node scripts/smoke-user-journey.mjs
COREBIZ_SMOKE_WEB_URL=http://127.0.0.1:3000 node scripts/smoke-browser-journey.mjs (requires Playwright/Chromium)

Production NO-GO until all gates are executed and reviewed.
