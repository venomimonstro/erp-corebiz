"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../components/app-sidebar";
import { apiRequest } from "../../lib/api";

type Dashboard = {
  kpis: {
    cashMinor: string;
    sales30dMinor: string;
    grossProfit30dMinor: string;
    openOrders: number;
    receivableMinor: string;
    payableMinor: string;
    stockValueMinor: string;
  };
  queue: Array<{
    id: string;
    type:
      | "OVERDUE_TASK"
      | "DEAL_NO_NEXT_ACTION"
      | "OVERDUE_OBLIGATION"
      | "STOCK_RISK";
    severity: "INFO" | "WARNING" | "CRITICAL";
    title: string;
    detail: string;
    href: string;
  }>;
};

function money(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

const queueLabels: Record<Dashboard["queue"][number]["type"], string> = {
  OVERDUE_TASK: "Задача",
  DEAL_NO_NEXT_ACTION: "CRM",
  OVERDUE_OBLIGATION: "Финансы",
  STOCK_RISK: "Склад"
};

export default function AppHomePage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      setDashboard(await apiRequest<Dashboard>("/dashboard/owner"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить рабочее пространство владельца"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const kpis = useMemo(() => {
    if (!dashboard) return [];

    return [
      ["Деньги", money(dashboard.kpis.cashMinor), "На денежных счетах"],
      ["Продажи · 30 дней", money(dashboard.kpis.sales30dMinor), "Подтверждённые и незакрытые продажи"],
      ["Валовая прибыль · 30 дней", money(dashboard.kpis.grossProfit30dMinor), "По себестоимости, зафиксированной в заказах"],
      ["Заказы в работе", String(dashboard.kpis.openOrders), "Черновики и подтверждённые"],
      ["Дебиторка", money(dashboard.kpis.receivableMinor), "Нам должны"],
      ["Кредиторка", money(dashboard.kpis.payableMinor), "Мы должны"],
      ["Запасы", money(dashboard.kpis.stockValueMinor), "По текущей себестоимости SKU"]
    ];
  }, [dashboard]);

  return (
    <main className="app-shell">
      <AppSidebar active="dashboard" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Среда владельца</p>
            <h1>Сегодня</h1>
            <p className="workspace-summary">
              Только ключевые показатели и ситуации, где требуется решение.
            </p>
          </div>

          <button onClick={() => void load()} type="button">
            Обновить
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось загрузить данные</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Собираем показатели…</div> : null}

        {!loading && dashboard ? (
          <>
            <div className="owner-kpi-grid">
              {kpis.map(([label, value, detail]) => (
                <article className="owner-kpi" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <small>{detail}</small>
                </article>
              ))}
            </div>

            <section className="attention">
              <div className="attention-heading">
                <div>
                  <p className="muted">Action & Exception Engine</p>
                  <h2>Требует решения</h2>
                </div>
                <span className="queue-count">{dashboard.queue.length}</span>
              </div>

              {dashboard.queue.length ? (
                <div className="action-queue">
                  {dashboard.queue.map((item) => (
                    <a className="action-item" href={item.href} key={item.id}>
                      <span className={`severity-dot ${item.severity.toLowerCase()}`} />
                      <div>
                        <small>{queueLabels[item.type]}</small>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </div>
                      <b>→</b>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="queue-empty">
                  <strong>Критичных исключений нет</strong>
                  <span>
                    Просроченные задачи, риски по деньгам, CRM и складу появятся здесь автоматически.
                  </span>
                </div>
              )}
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
