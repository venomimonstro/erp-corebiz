# Product & UX

## 1. Главная идея UX

Пользователь не должен видеть устройство ERP.

Владелец спрашивает: **где деньги и где проблема?**  
Менеджер: **что делать дальше?**  
Администратор услуг: **кто и когда записан?**  
Закупщик: **что купить?**  
Кладовщик: **что делать сейчас?**

## 2. Workspace Engine

### Owner
- деньги;
- продажи;
- валовая прибыль;
- дебиторка;
- запасы;
- риски/отклонения.

### Sales Manager
- My Work;
- Deals Kanban;
- Tasks;
- Customers.

### Sales Head
- pipeline;
- team load;
- stale deals;
- conversion.

### Service Administrator
- day/week calendar;
- booking;
- resource availability;
- no-show;
- client history.

### Procurement
- demand;
- incoming;
- supplier orders.

### Warehouse
- next operation/task;
- receiving/shipment;
- stock discrepancy.

### Finance
- cash;
- receivable/payable;
- payment calendar.

### Accountant
- primary docs;
- bank reconciliation;
- VAT/tax;
- close period issues.

## 3. Навигация

Навигация строится по Capability + Role.

Нельзя показывать 70 пунктов меню и ожидать, что пользователь проигнорирует лишние.

## 4. Общая shell

Слева:
- role/capability navigation.

Сверху:
- global search / Ctrl+K;
- + Создать;
- Action Queue;
- notifications;
- tenant/branch selector;
- profile.

## 5. CRM Kanban

Карточка:
- deal name;
- party;
- amount;
- responsible;
- next action;
- overdue/attention marker.

Drag-and-drop:
- optimistic UI;
- backend MoveDealCommand;
- rollback UI при reject;
- объяснение причины и CTA исправления.

## 6. Deal Card

Header:
- title;
- amount;
- stage;
- customer;
- responsible;
- next action.

Actions:
- + Task;
- + Note;
- Create/Open Order.

Tabs/areas:
- fields;
- timeline;
- tasks;
- orders;
- documents.

## 7. Tasks

Core states:
OPEN / IN_PROGRESS / WAITING / DONE / CANCELLED.

Filters:
Today / Overdue / Week / Mine / Team.

После Complete система предлагает создать next action.

## 8. Owner Dashboard

Не более 6 главных KPI.

Блок `Требует решения` важнее вторичных графиков.

Пример:
- 5 клиентов просрочили 1.2 млн ₽;
- 8 SKU уйдут в stockout;
- 3 сделки >300k без next action;
- Direct campaign потратила 35k без оплаченных продаж.

## 9. Error UX

Не:
`Error 422`.

А:
`Нельзя отгрузить заказ: доступно только 8 из 10 шт.`

CTA:
- Отгрузить 8;
- Найти на другом складе;
- Создать закупку;
- Backorder, если разрешён.

## 10. Progressive disclosure

Редкие функции скрыты под `Дополнительно`.

Expert Mode позже может включать:
- dense tables;
- shortcuts;
- bulk actions.

## 11. Универсальные таблицы

- resize/reorder;
- pin/hide;
- sort/filter;
- saved views;
- bulk actions;
- export permission;
- empty/loading/error states.

## 12. Public SaaS

Основные страницы:
- home;
- CRM;
- inventory;
- services;
- analytics;
- pricing;
- migration;
- security;
- docs;
- status.

Главная CTA:
`Начать бесплатно`.

Ключевой тезис:
`Перенесите клиентов и товары и начните работать за один день.`

