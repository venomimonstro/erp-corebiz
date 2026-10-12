# CoreBiz — комплексный аудит критических узлов и усиление RC (12.10.2026)

**Статус:** исправления непосредственно в `main`, без GitHub Actions.
**Production:** `NO-GO`, пока не получены измеримые доказательства на
изолированном стенде и реальных договорных sandbox-интеграциях.

Это аудит исходников с целевым ревью платформенных узлов и бизнес-путей,
**не** утверждение, что выполнены тесты на production или проверена каждая
строка репозитория. На момент изменений GitHub предоставлял исходники,
но в среде аудитора не был доступен работающий CoreBiz/его PostgreSQL и
не удалось выполнить полный `pnpm test/typecheck/build` или реальную
нагрузку. Статическая проверка сохранённых исходников не заменяет это.

## 1. Исправленные обнаруженные дефекты

| Приоритет | Контур | Причина / угроза | Реализация |
|---|---|---|---|
| P0 | API / PostgreSQL | `pg.Pool` без обработчика ошибки отключившегося idle-клиента: необработанный EventEmitter `error` может завершить процесс Node | `DatabaseService` ловит ошибку пула; транзакция сохраняет исходное исключение, неисправное соединение отбрасывается |
| P0 | Worker / PostgreSQL | Worker имел тот же риск аварийной остановки idle-пула | Явная обработка `pool.on('error')`, ограничения подключения/таймаута/пула |
| P0 | Workflow/outbox | При падении Worker запись навсегда оставалась `PROCESSING`, а tenant-RLS на outbox отсутствовал | Миграция `245` включает RLS, атомарный SECURITY DEFINER claim, аварийное восстановление через 15 минут, права EXECUTE только app-role |
| P0 | Workflow/outbox concurrency | Два обработчика могли одновременно выполнить действия после возврата старой аренды | `processEvent` сверяет `locked_at` и блокирует строку `FOR UPDATE` до COMMIT; старый обработчик не выполняет действия |
| P0 | Workflow failures | Неудачное действие возвращало event в `FAILED` через глобальный SQL вне tenant context | Отдельная scoped транзакция статуса `FAILED` после ROLLBACK, fencing по `locked_at`, sanitized error code |
| P1 | Auth / anti-bruteforce | Лимит login был только на пару IP+email: перебор новых email снимал ограничение расхода Argon2 | Добавлен общий бюджет 100 login за 15 минут для одного IP, без раскрытия IP/почты в Redis |
| P1 | Auth / DB load | Каждая авторизованная операция запускала UPDATE `user_session.last_seen_at`, создавая WAL/row contention | Bounded cache на процесс, не чаще 1 раза в 5 минут на сессию, дополнительное SQL условие времени; проверка валидности/отзыва остаётся при каждом запросе |
| P1 | Owner UX | Ошибка вспомогательной активации через `Promise.all` делала пустым весь главный dashboard | `Promise.allSettled`: показатели владельца доступны даже при 503 подсказок первого запуска |
| P0 release integrity | Production-gate раньше отмечал `CORE:PERFORMANCE` как PASS только по тесту Redis-семафоров | Теперь нужен отдельный `load-1000-sessions.mjs` на 1000 уникальных disposable cookie; без тестовых сессий gate блокируется |

Из предыдущих этапов дополнительно остаются: защита двух перевозчиков
на один заказ (миграция `244`), safe checkout без неопределённой доставки,
сверка по платёжным и почтовым `UNKNOWN`.

## 2. Матрица критических бизнес-операций

| Путь владельца | Исходная реализация в коде | Что должно доказать окружение |
|---|---|---|
| Регистрация → создание tenant → владелец | auth, Membership, session, RBAC | Нет утечки между компаниями; повторный вход/приглашение/отзыв прав |
| Настройка ниши, каталог и цены | профили/вертикали, catalog | Первый рабочий результат, изменение настроек не ломает существующие объекты |
| CRM → сделка → заказ → деньги | Kanban, Sales, Finance | Перевод статусов, недопустимость дублей и ошибочного `PAID` |
| Интернет-магазин | storefront, buyer checkout, OMS | Невозможность оплаты без доставки/чека; конкуренция и цены только с сервера |
| Склад, WMS, 3PL | inventory ledger, reservations, shipping | Нет отрицательного ATP, двойного списания, утечек owner-dimension |
| Онлайн-оплата, фискализация | YooKassa/ATOL/возвраты | Сверенные `SUCCEEDED`, финпроводка, ОФД/чеки, таймауты без дублей |
| СДЭК и Почта России | provider connections, claims | Настоящее оформление/сверка, идентичность получателя, никакой второй накладной |
| Автоматизации | outbox, workflow, tenant RLS | Рестарт Worker на `PROCESSING`, повтор без дублирования действий |
| Владельческий интерфейс | dashboard, activation, Go-Live | Пользователь видит деньги и задачи, даже если второстепенный API недоступен |

## 3. Доказательство на изолированном стенде

Существующие в репозитории проверки расширены:

- `database.service.spec.ts`: ошибка idle-сокета, rollback, discard pool.
- `auth-rate-limit.service.spec.ts`: 10 попыток одной учётной записи,
  100 попыток по разным email с одного IP, reset без обхода IP-лимита.
- `auth-session-touch.spec.ts`: 50 параллельных запросов → не более
  одного last-seen UPDATE, отзыв session проверяется немедленно.
- `smoke-browser-journey.mjs`: принудительный 503 вспомогательной
  активации не скрывает показатели владельца.
- `workflow-lease-recovery-drill.sql`: в рамках **ROLLBACK** создаёт
  synthetic `PROCESSING` возрастом 20 минут и проверяет единственный
  успешный reclaim, без провайдеров или внешних денежных операций.
- `worker-outbox-release-gate.sql`: fail при зависших арендах,
  исчерпанных повторах и RLS-off.
- `security_runtime_function_gate.sql`: проверяет scoped EXECUTE и
  отсутствие публичного доступа к функции cross-tenant claim.
- `production-gate.sh`: никакого performance PASS без успешного
  1000-session load сценария.

**Приоритет для runtime acceptance:** PostgreSQL migration replay,
tenant-RLS под `corebiz_app`, Worker crash/kill/restart,
идемпотентная оплата и склад, Go-Live маршруты 8 ниш, 100 concurrent
business actors, независимые 1000 read-sessions, DB backup→restore.

## 4. Обязательный порядок обновления worker / миграции 245

Миграция 245 и код worker должны вводиться **одним согласованным релизом**.
Старый Worker не сможет напрямую получить outbox после RLS, а новый
Worker ожидает наличие `corebiz_claim_domain_event()`.

1. Сделать verified backup + restore drill на отдельной базе.
2. На staging изолировать worker и проверить replay всех миграций до 245.
3. Установить новый API и Worker одной версии; во время переключения
   остановить старый worker, применить штатным мигратором `245`, запустить
   только новый worker.
4. Проверить, что tenant RLS разрешает действия своему tenant и запрещает
   чужому, что упавший `PROCESSING` восстанавливается и действия не
   дублируются при параллельном claim.
5. Не объявлять GO, пока результат `production-gate.sh` не PASS и
   сверки Finance/WMS/касс не закрыты.

Для чтения на сервере без запуска/изменения БД:

```bash
git checkout main && git pull --ff-only origin main
corepack enable && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm build && pnpm stability:check
```

Для полного `bash scripts/production-gate.sh` нужны отдельно:
`COREBIZ_DISPOSABLE_DATABASE_URL`, `COREBIZ_RESTORE_DATABASE_URL`,
`COREBIZ_SMOKE_BASE_URL`, `COREBIZ_SMOKE_WEB_URL`, `REDIS_URL`,
`COREBIZ_CONFIRM_DISPOSABLE_DB=YES` и
`COREBIZ_LOAD_SESSIONS_FILE` (1000 **реальных независимых тестовых**
сессий только на disposable окружении). Выполнение gate создаёт объекты,
изменяет disposable DB и прогоняет restore; **не запускать на production**.

## 5. Оставшиеся P0/P1 до коммерческого релиза

**P0:**
- полный `pnpm typecheck/test/build` с реальным окружением;
- fail-closed tenant RLS и права service / worker runtime SQL-ролей;
- миграция 245 + crash drill на PostgreSQL с реальными worker процессами;
- end-to-end sandbox YooKassa, ATOL, CDEK, Почта России, возвраты,
  потерянные webhooks/ответ после timeout;
- независимые контролируемые замеры p95/p99 и нагрузочная модель;
- дата восстановления RPO/RTO + корректность Finance/OMS/WMS после restore.

**P1:**
- выделенная роль БД для глобальных cross-tenant worker claims вместо
  общей роли API/worker;
- продуктовые browser journeys на 390/768/1440 px для разных ниш,
  медленные сети, невалидные данные, неработающие API;
- мониторинг PostgreSQL pool saturation, количество `FAILED/EXHAUSTED`
  очередей, stale `PROCESSING`, дублей платежей/накладных;
- алертинг вне обслуживаемого сервера и живой pilot 5–10 организаций.

## 6. Цель 99,9%

99,9% за 30 дней = не более **43,2 минуты** недоступности.
`scripts/slo-availability.mjs` измеряет готовность API поминутно,
но это **один SLI**, а не доступность всех бизнес-функций.
Нужны отдельно success rate оформления заказа/оплаты/фискализации,
приемлемая длительность восстановления, независимый мониторинг
и собранные за 30 дней данные.

На единственном VPS без HA PostgreSQL/Redis/API, автоматического
восстановления и проверенных бэкапов гарантировать 99,9% нельзя.

**Вердикт:** исходные дефекты исправлены, evidence-инструменты усилены;
фактический runtime PASS, пилот и 99,9% **пока не доказаны**.
