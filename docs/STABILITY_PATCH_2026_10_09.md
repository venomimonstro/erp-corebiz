# CoreBiz: пакет стабилизации — 9 октября 2026

**Ветка:** `main` без CI/GitHub Actions.  
**Статус:** source-level исправления внесены; полноценная production-приёмка **НЕ подтверждена**.  
**Приоритет:** сохранность денег, заказов, складских записей, tenant isolation и работа публичных форм.

## Исправлено

1. **Публичная онлайн-запись.** В Site Builder требуется выбрать активный ресурс. Backend запрещает создание `BOOKING` binding с пустым `resourceIds`, проверяет service и resources в текущем tenant. Ранее пустой список приводил к отсутствию слотов и невозможности оформить запись.
2. **Checkout concurrency.** Миграция `118_storefront_checkout_claim.sql` добавляет `PROCESSING`, lease token и checkpoint `checkout_party_id`. Каждый cart может иметь только одну активную попытку оформления. При повторном запросе используется неизменный Sales idempotency key `storefront:cart:<cart_id>`, подтверждённый заказ не подтверждается вторично. После прерывания старый lease можно забрать через пять минут. Это не гарантирует отсутствия побочных дубликатов Party при падении между Party.create и checkpoint; такие случаи требуют reconciler/операторской сверки.
3. **Cart mutation race.** `setLine()` берёт `SELECT ... FOR UPDATE` по родительской корзине в той же транзакции. Checkout claim и изменение строк сериализуются одной DB-row блокировкой.
4. **Роль PostgreSQL и readiness.** В production `/api/v1/health/ready` проверяет, что SQL-role не SUPERUSER/BYPASSRLS и не владелец tenant-таблиц без FORCE RLS; также проверяет наличие включённого RLS и политик. При отказе возвращается HTTP 503. Это проверка инфраструктурных предпосылок, **не замена cross-tenant integration-тестов**.
5. **Идемпотентность форм.** Клиент сохраняет submission key при сетевой ошибке и не создаёт новую заявку простым повторным нажатием.
6. **Целостность миграций.** Новые SQL-миграции записываются с SHA-256 checksum. Изменение уже применённого файла с checksum останавливает migrator. Исторические миграции без сохранённого checksum остаются явно не верифицированными. Применённые имена, отсутствующие в Git, блокируют запуск мигратора.
7. **Операторская диагностика.** `scripts/public_commerce_booking_diagnostics.sql` проверяет зависшие корзины, закрытые корзины без SalesOrder, повторные ключи заказов, публичные формы записи без ресурсов и незавершённые submissions (read-only).
8. **Regression tests.** `apps/api/src/modules/business/sites/public-commerce-safety.spec.ts` покрывает checkout-lock, запрет мутации корзины во время оформления и запрет пустого ресурса для формы записи.

## Что НЕ доказано и остаётся блокером

- Нет результата `pnpm typecheck`, `pnpm test`, `pnpm build` из реального клона репозитория с установленными зависимостями. Никаких «тесты прошли» до фактического запуска.
- Повторяющиеся числовые префиксы исторических миграций `026, 028, 040, 043, 044, 054, 055, 056, 070, 072` учитываются как WARN в `migration-preflight` (реальный replay миграций по-прежнему обязателен). **Не переименовывать** уже применённые SQL без сравнения записей `schema_migration` по всем окружениям и disposable replay.
- В production runtime SQL role необходимо отделить от роли владельца/миграций. Использование PostgreSQL owner/superuser для API опасно и теперь должно давать 503 readiness.
- Не выполнены clean database replay, cross-tenant E2E, двукратное конкурентное оформление реальной корзины, rollback/restart/restore drill, платежная и складская сверка.
- Старые BOOKING bindings с пустым `resourceIds` не модифицируются автоматически. Они отображаются SQL-диагностикой и требуют перенастройки владельцем.
- Повторная отправка публичной формы с `FAILED` submission требует отдельной стратегии восстановления промежуточных доменных операций; **не сбрасывать FAILED в RECEIVED массово**.

## Ручная проверка без CI/Actions

В клоне репозитория с Node.js 22+, pnpm и на изолированном сервере:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node scripts/migration-preflight.mjs
```

`migration-preflight` теперь должен сигнализировать WARN для исторических повторов, без автоматического BLOCK по номерам. Не обходить проверку в production и не менять применённые имена миграций наугад.

После согласования истории миграций на **полностью одноразовой** БД:

```bash
export COREBIZ_DISPOSABLE_DATABASE_URL='postgresql://... disposable only ...'
export COREBIZ_CONFIRM_DISPOSABLE_DB=YES
pnpm release:check
```

Read-only запросы в тестовой или в контролируемой production-диагностике:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/security_postgres_rls_diagnostic.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/public_commerce_booking_diagnostics.sql
```

Использовать для миграций отдельно привилегированный `DATABASE_URL` и для API ограниченную DB-role, без SUPERUSER/BYPASSRLS и без владения tenant-таблицами. Не публиковать секреты в логах.

## Приёмочные сценарии

1. Два одновременных POST checkout одной корзины: максимум **один** созданный SalesOrder; второй запрос — 409 или ссылка на уже оформленный.
2. PUT количества и POST checkout одной корзины одновременно: либо PUT завершён первым и вошёл в заказ, либо PUT возвращает 409; никакого изменения после claim.
3. Сбой между SalesOrder.create/confirm и фиксацией cart: повторное оформление использует существующий SalesOrder, без повторного создания обязательства.
4. Онлайн-запись: нельзя создать binding без ресурса; с активным ресурсом слот виден и создаёт одну Booking с занятостью ресурса.
5. Проверить 2 отдельных tenant для GET/POST/экспорта; ни один пользователь не видит и не изменяет данные другого.
6. Статусы `/health` (liveness) и `/health/ready` (readiness) отличаются при опасной production DB-role: второй возвращает 503.
7. Проверить восстановление backup и бухгалтерско-складскую сверку на staging.

**Решение по релизу: NO-GO**, пока вышеуказанные DB/тестовые gates не закрыты фактически.
