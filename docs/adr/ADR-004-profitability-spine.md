# ADR-004 — Profitability Spine

**Status:** Accepted

## Decision

Business OS с начала проекта сохраняет сквозную связность:

`Marketing Source → Lead → Party → Deal → Order/Booking → Payment → COGS/Costs → Profit`.

Не все домены реализуются в первом релизе, но Core не должен потребовать полной переделки, чтобы позже связать операционные и маркетинговые данные.

## Consequences

- source/campaign metadata не хранится только в UI;
- Deal/Order сохраняют происхождение;
- возвраты и корректировки участвуют в прибыльности;
- COGS и marketing costs считаются отдельными компонентами;
- аналитическая модель должна позволять прибыль по client/order/SKU/channel/branch/campaign.
