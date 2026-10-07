# Growth Analytics — сквозная аналитика

## 1. Цель

Показать владельцу не клики и лиды, а полный путь рекламного рубля до фактической прибыли.

```
Ad Spend
→ Visitor
→ Session
→ Touchpoint
→ Lead
→ Party
→ Deal
→ SalesOrder / Booking
→ Payment
→ Revenue
→ COGS
→ Marketing Cost
→ Contribution Profit
```

## 2. Почему это сильнее отдельного аналитического SaaS

Business OS уже владеет:
- CRM;
- заказом;
- оплатой;
- возвратом;
- себестоимостью;
- складом;
- Finance.

Поэтому не требуется “угадывать” конечную продажу через внешнюю CRM-интеграцию.

## 3. Сущности

- TrafficSource
- MarketingAccount
- Campaign
- AdGroup
- Ad
- Keyword/SearchTerm where available
- MarketingCost
- Visitor
- Session
- Touchpoint
- WebEvent
- LeadSourceLink
- AttributionResult
- ConversionExportJob
- MarketingAlert

## 4. Tracking

Для собственных Business OS Sites tracker встроен.

Для внешнего сайта — JS tracker.

Tracker фиксирует только разрешённые данные:
- anonymous visitor id;
- session;
- landing;
- referrer;
- UTM;
- campaign identifiers;
- events;
- consent state.

Не строить продукт вокруг скрытого fingerprinting.

## 5. Identity resolution

До лида:
`Visitor`.

После формы/звонка:
`Visitor → Lead`.

После квалификации:
`Lead → Party`.

Связка должна быть auditable и иметь confidence/source.

## 6. Yandex Direct — первая рекламная интеграция

Получаем:
- campaign;
- ad group;
- ad where API allows;
- impressions;
- clicks;
- spend;
- identifiers for attribution.

Расходы сохраняются как MarketingCost с source timestamp и sync status.

## 7. Call tracking

На первом этапе:
- интеграции с внешними calltracking/telephony providers;
- call id;
- visitor/session binding;
- duration;
- outcome;
- source.

Собственную номерную ёмкость/телефонию не строить в MVP.

## 8. Attribution models V1

- FIRST_TOUCH
- LAST_TOUCH
- LAST_PAID_TOUCH

Raw Touchpoint immutable.

AttributionResult — производная интерпретация и может пересчитываться.

Каждый dashboard показывает выбранную модель.

## 9. Метрики

- Spend
- Impressions
- Clicks
- CPC
- Leads
- CPL
- Orders
- CPO
- New Customers
- CAC
- Revenue
- ROAS
- Gross Profit
- Contribution Profit
- ROMI
- Repeat Revenue
- LTV later

Формулы находятся в Semantic Metrics Layer.

## 10. Прибыль

Не считать рекламную эффективность только от Revenue.

Минимальный Profitability Spine:
```
Revenue
- COGS
- Returns
- Discounts
- Direct Logistics Cost (если доступен)
- Marketing Cost
= Contribution Profit
```

Каждый показатель должен иметь явное определение.

## 11. Dashboard

Owner:
- Spend;
- Leads;
- Paid Orders;
- Revenue;
- Gross Profit;
- Contribution Profit;
- CAC;
- ROMI.

Drill-down:
Source → Campaign → AdGroup → Ad/Keyword.

## 12. Funnel

```
Visits
→ Leads
→ Qualified
→ Orders
→ Paid
→ Repeat
```

Каждый переход должен быть связан с конкретными domain objects, а не только агрегатом.

## 13. Alerts

Примеры:
- campaign spend > X and paid orders = 0;
- CPL > threshold;
- CAC > margin threshold;
- ROMI < 0;
- spend increased while contribution profit declined.

Action & Exception Engine создаёт actionable item.

## 14. Offline conversion export

Позже:
- подтверждённая продажа/оплата может отправляться обратно в рекламную систему;
- только разрешённые данные;
- idempotency;
- consent/privacy policy;
- execution log.

## 15. Analytics architecture

Marketing events не нагружают OLTP.

```
Tracker/Integrations
→ ingestion
→ event store/queue
→ analytical storage
→ semantic metrics
→ dashboard
```

ClickHouse вводится при фактической необходимости.

## 16. Data quality

Dashboard показывает freshness:
- Direct synced 5 min ago;
- CRM real-time;
- Finance real-time;
- marketplace delayed.

Если данные неполные, система не выдаёт расчёт как “точный” без предупреждения.

## 17. Gate

Growth нельзя считать готовым до:
- deterministic source→lead linking;
- spend reconciliation;
- order/payment linking;
- returns support;
- metric dictionary;
- attribution model transparency;
- backfill/replay capability;
- data freshness observability.
