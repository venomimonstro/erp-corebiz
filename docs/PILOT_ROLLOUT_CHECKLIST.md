# CoreBiz — Pilot rollout checklist

Дата: 2026-10-10  
Статус: operational checklist для Sprint 74.

## Цель

Запустить 5–10 реальных компаний ограниченной когортой и доказать, что продукт стабильно работает в реальных бизнес-процессах до широкого коммерческого rollout.

Целевые профили: TRADE, ECOMMERCE, SERVICE, WAREHOUSE_3PL.

## Preconditions

Pilot tenant нельзя переводить в RUNNING, пока одновременно не выполнено:

- существует APPROVED release candidate именно той версии, на которой запускается pilot;
- RC verdict прошёл полную mandatory evidence matrix;
- Go-Live Center текущего tenant имеет READY=true;
- формально принято решение GO, tenant находится в HYPERCARE;
- миграция данных reconciled или миграция не требовалась;
- назначен ответственный за pilot;
- определена дата начала и плановая дата окончания.

## Обязательный контроль в hypercare

Не реже одного snapshot в сутки:

- заказы / записи / проведённые платежи;
- failed channel sync;
- failed marketing sync;
- failed workflow;
- WMS BLOCKED/FAILED tasks;
- urgent/open support tickets;
- runtime budget denials;
- открытые operational issues.

## Немедленный STOP / PAUSE

Pilot нельзя продолжать автоматически при любом P0:

- cross-tenant доступ или утечка данных;
- privilege escalation;
- потеря или дублирование денег;
- duplicate order/payment из-за replay;
- нарушение Inventory Ledger / отрицательная доступность из-за гонки;
- нарушение Accounting debit=credit;
- silent data corruption;
- backup не восстанавливается;
- массовая недоступность auth/ключевого рабочего сценария.

После STOP/PAUSE: исправление → новый RC/evidence при изменении кода → новый Go-Live review → явный resume.

## Exit gate

Pilot можно считать COMPLETED только если:

- нет открытых P0;
- нет незакрытых P1, которые препятствуют основному сценарию профиля;
- последний hypercare snapshot GREEN и не старше 24 часов;
- tenant readiness остаётся READY;
- основные golden-like сценарии подтверждены реальными операциями;
- support backlog управляем;
- владелец pilot tenant подтвердил, что ключевой процесс выполняется без обхода системы через Excel/старую систему;
- выполнен итоговый pilot review с решением COMPLETE.

## Что pilot не делает

Pilot не является автоматическим production deploy. Он не отключает RLS, не ослабляет release gates, не разрешает прямую правку ledger и не превращает индивидуальные пожелания клиента в Core без product review.
