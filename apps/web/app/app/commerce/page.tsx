"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Replenishment = {
  skuId: string;
  sku: string;
  productName: string;
  orderedMilli30d: string;
  sellableMilli: string;
  inboundMilli: string;
  targetMilli14d: string;
  suggestedMilli: string;
  stockCoverDays: string;
  urgency: "OUT" | "CRITICAL" | "REPLENISH";
};
type Snapshot = {
  windowDays: number;
  targetDays: number;
  pendingFulfillment: number;
  paymentReview: number;
  openSupplierOrders: number;
  replenishment: Replenishment[];
  method: string;
};
type Filter = "ALL" | "PURCHASE" | "INBOUND";

const quantity = (milli: string) => {
  const n = Number(milli);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(n / 1000)
    : "—";
};
const coverage = (value: string) => {
  const n = Number(value);
  return Number.isFinite(n)
    ? new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(n)
    : "—";
};

export default function CommerceDecisionsPage() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("ALL");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await apiRequest<Snapshot>("/dashboard/commerce"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось получить сводку");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const rows = useMemo(() => (data?.replenishment ?? []).filter(row =>
    filter === "ALL" ||
    (filter === "PURCHASE" && Number(row.suggestedMilli) > 0) ||
    (filter === "INBOUND" && Number(row.inboundMilli) > 0)
  ), [data, filter]);

  return (
    <main className="app-shell">
      <AppSidebar active="commerce-decisions" />
      <section className="workspace workspace-wide commerce-decisions">
        <header className="workspace-header">
          <div>
            <p className="muted">CoreBiz · Торговля без лишних отчётов</p>
            <h1>Магазин сегодня</h1>
            <p className="workspace-summary">
              Заказы, незакрытые оплаты и товары, которые рискуют закончиться.
              Одна страница с конкретными действиями.
            </p>
          </div>
          <button type="button" disabled={loading} onClick={() => void load()}>
            {loading ? "Проверяем…" : "Обновить"}
          </button>
        </header>

        {error ? <div className="studio-message error" role="alert">{error}</div> : null}
        {loading && !data ? <p className="muted">Собираем показатели…</p> : null}

        {data ? (
          <>
            <div className="commerce-decisions-kpis">
              <a href="/app/sales/orders">
                <span>Ожидают исполнения</span>
                <strong>{data.pendingFulfillment}</strong>
                <small>Подтверждённые заказы без полной отгрузки →</small>
              </a>
              <a href="/app/sales/orders">
                <span>Проверить оплату</span>
                <strong>{data.paymentReview}</strong>
                <small>Не оплачено или оплачено частично →</small>
              </a>
              <a href="/app/purchases">
                <span>У поставщиков</span>
                <strong>{data.openSupplierOrders}</strong>
                <small>Открытые подтверждённые закупки →</small>
              </a>
              <a href="/app/inventory/stock">
                <span>Риск нехватки</span>
                <strong>{data.replenishment.length}{data.replenishment.length===20 ? "+" : ""}</strong>
                <small>SKU с запасом менее 14 дней →</small>
              </a>
            </div>

            <section className="section-block">
              <div className="commerce-decisions-section-top">
                <div>
                  <p className="muted">Данные заказов за {data.windowDays} дней</p>
                  <h2>Что стоит проверить перед закупкой</h2>
                  <p>
                    Ориентир: запас на {data.targetDays} дней.
                    Подтверждённые поставки учитываются отдельно. Ничего не заказывается автоматически.
                  </p>
                </div>
                <a className="secondary-button" href="/app/purchases">Перейти к закупкам ↗</a>
              </div>

              <div className="commerce-decisions-tabs" role="group" aria-label="Фильтр рекомендаций">
                <button type="button" className={filter==="ALL"?"active":""}
                  aria-pressed={filter==="ALL"} onClick={() => setFilter("ALL")}>Все риски</button>
                <button type="button" className={filter==="PURCHASE"?"active":""}
                  aria-pressed={filter==="PURCHASE"} onClick={() => setFilter("PURCHASE")}>Нужно рассмотреть закупку</button>
                <button type="button" className={filter==="INBOUND"?"active":""}
                  aria-pressed={filter==="INBOUND"} onClick={() => setFilter("INBOUND")}>Уже ожидаем поставку</button>
              </div>

              {rows.length ? (
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Товар</th>
                        <th>Риск</th>
                        <th>Доступно</th>
                        <th>В пути по закупкам</th>
                        <th>Заказано за 30 дней</th>
                        <th>Запас, дней</th>
                        <th>Предложение</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => (
                        <tr key={row.skuId}>
                          <td>
                            <strong>{row.productName}</strong>
                            <small>{row.sku}</small>
                          </td>
                          <td>
                            <span className={"commerce-risk " + row.urgency.toLowerCase()}>
                              {row.urgency==="OUT" ? "Нет доступного остатка" :
                                row.urgency==="CRITICAL" ? "Менее 7 дней" : "Менее 14 дней"}
                            </span>
                          </td>
                          <td>{quantity(row.sellableMilli)}</td>
                          <td>{quantity(row.inboundMilli)}</td>
                          <td>{quantity(row.orderedMilli30d)}</td>
                          <td>{coverage(row.stockCoverDays)}</td>
                          <td>
                            {Number(row.suggestedMilli)>0 ?
                              <strong>Рассмотреть +{quantity(row.suggestedMilli)}</strong> :
                              <span>Поставка может покрыть потребность</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="queue-empty">
                  <strong>По выбранному фильтру проблем не найдено</strong>
                  <span>
                    Рекомендации строятся только по товарам с подтверждёнными
                    заказами за последние 30 дней. Новинки без истории здесь не оцениваются.
                  </span>
                </div>
              )}
              <p className="commerce-method">{data.method}</p>
            </section>

            <div className="commerce-next-actions">
              <a href="/app/sites"><strong>Мой интернет-магазин</strong>
                <span>Оформление, публикация и подключение домена →</span></a>
              <a href="/app/ecommerce"><strong>Продажи на маркетплейсах</strong>
                <span>Единые артикулы, остатки и синхронизация →</span></a>
              <a href="/app/analytics/profitability"><strong>Где зарабатываем</strong>
                <span>Посмотреть экономику каналов и прибыль →</span></a>
              <a href="/app/migration"><strong>Импорт товаров</strong>
                <span>Добавить каталог из обычного CSV или Excel →</span></a>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
