# Accounting RU — доменная спецификация

## 1. Назначение

Регламентированный бухгалтерский и налоговый контур РФ — отдельный bounded context.

Он не заменяет Finance Lite и не владеет операционными объектами CRM/Sales/Inventory.

```
Business Event
→ Posting Rule (versioned, effective-dated)
→ Accounting Document
→ Accounting Entry
→ Tax/Register Effects
```

LLM не выбирает проводки и не рассчитывает налоги.

## 2. Безопасная стратегия запуска

Этап 1:
- Business OS operational core;
- бухгалтер продолжает 1С;
- экспорт/интеграция операций.

Этап 2:
- параллельный Accounting RU;
- один и тот же период рассчитывается в 1С и Business OS;
- reconciliation.

Этап 3:
- минимум 1–2 закрытых периода совпадают по контрольным показателям;
- только после sign-off разрешён production cutover.

## 3. Сущности

- AccountingPolicy
- ChartOfAccounts
- Account
- PostingRule
- AccountingDocument
- AccountingEntry
- EntryLine
- TaxRegister
- TaxRule
- ReportingPeriod
- PeriodLock
- ReconciliationCase
- CloseChecklist
- FixedAsset (позже)
- VATDocument / Invoice/UPD linkage
- EDOEnvelope (позже)

## 4. Double-entry invariant

Каждый AccountingEntry:
- immutable после posting;
- сумма Debit == сумма Credit;
- связан с BusinessEvent/source object;
- содержит rule_version;
- содержит business_date;
- содержит legal_entity.

Исправление:
```
Original
→ Reversal
→ Correct Entry
```

UPDATE проведённой проводки запрещён.

## 5. Posting Rules

Rule version:
- code;
- valid_from;
- valid_to;
- condition;
- debit account expression;
- credit account expression;
- amount expression;
- analytics dimensions;
- tax effects.

Изменение правила сегодня не меняет прошлый закрытый период.

## 6. Business Events первой очереди

- sale.shipped
- sale.returned
- purchase.received
- payment.received
- payment.sent
- inventory.adjusted
- payroll.accrued (позже)
- tax.assessed (позже)

Один event может сформировать несколько entries.

## 7. Legal Entity

Accounting всегда работает в контексте конкретного LegalEntity.

Tenant может иметь несколько LegalEntity.

Разрешённые режимы и настройки хранятся в AccountingPolicy.

## 8. Налоговые режимы

Порядок разработки:
1. УСН базовый сценарий;
2. ОСНО + НДС;
3. дополнительные режимы только после domain review.

Правила должны быть versioned и подтверждены профильным бухгалтерским/налоговым специалистом перед production.

## 9. Первичные документы

Document Service предоставляет операционные документы.

Accounting связывает их с:
- хозяйственной операцией;
- проводкой;
- налоговым регистром;
- статусом проверки.

Не создавать независимые копии одного и того же документа в каждом модуле.

## 10. VAT / НДС

Отдельные сущности/регистры:
- исходящий НДС;
- входящий НДС;
- основание;
- счёт-фактура/УПД;
- дата принятия;
- корректировки.

НДС не рассчитывается UI-формулой.

## 11. Period Close

Workspace бухгалтера:
- Bank
- AR
- AP
- Inventory
- Payroll
- Fixed Assets
- VAT
- Taxes

Status:
- NOT_STARTED
- IN_PROGRESS
- ERROR
- DONE

Каждый error должен иметь link на конкретное расхождение.

## 12. Period Locks

- SOFT
- ACCOUNTING
- TAX
- HARD

Hard reopen:
- специальный permission;
- step-up auth;
- обязательная причина;
- audit;
- recomputation/reconciliation plan.

## 13. Reconciliation Center

Сверки:
- bank statement vs payments;
- AR/AP;
- inventory balances vs accounting balances;
- sales/purchases totals;
- VAT registers;
- opening/closing balances.

Issue никогда не исправляется молча.

## 14. UI бухгалтера

Меню:
- Главная
- Первичка
- Банк
- Касса
- Продажи
- Покупки
- Проводки
- НДС
- Налоги
- Закрытие месяца
- Отчётность
- Ошибки/сверка

Главная показывает прежде всего то, что мешает закрытию.

## 15. Permissions

Отдельно:
- accounting.read
- accounting.post
- accounting.reverse
- accounting.period.close
- accounting.period.reopen
- accounting.policy.manage
- tax.read/manage
- reports.generate/export

## 16. Gate перед production

Запрещён production Accounting RU пока нет:
- accountant domain review;
- automated debit=credit invariants;
- effective-date tests;
- reconciliation;
- historical correction tests;
- period lock tests;
- parallel-run validation with reference accounting data;
- legal/regulatory update process.
