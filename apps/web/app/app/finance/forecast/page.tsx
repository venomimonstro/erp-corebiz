"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Day = {
  date: string;
  inflowMinor: string;
  outflowMinor: string;
  netMinor: string;
  projectedBalanceMinor: string;
  items: number;
  cashGap: boolean;
};

type Obligation = {
  id: string;
  direction: "RECEIVABLE" | "PAYABLE";
  remainingMinor: string;
  dueAt: string | null;
  overdue: boolean;
  sourceType: string;
  sourceId: string;
  partyName: string | null;
};

type Forecast = {
  currency: string;
  horizonDays: number;
  generatedAt: string;
  openingBalanceMinor: string;
  endingBalanceMinor: string;
  minimumBalanceMinor: string;
  minimumBalanceDate: string;
  firstCashGapDate: string | null;
  overdueReceivableMinor: string;
  overduePayableMinor: string;
  undatedReceivableMinor: string;
  undatedPayableMinor: string;
  calendar: Day[];
  obligations: Obligation[];
};

export default function FinanceForecastPage() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Forecast | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiRequest<Forecast>("/finance/forecast?days=" + days));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось построить прогноз"
      );
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const upcoming = useMemo(
    () =>
      (data?.obligations ?? [])
        .filter((item) => item.dueAt !== null)
        .sort((a,b) =>
          new Date(a.dueAt!).getTime() - new Date(b.dueAt!).getTime()
        )
        .slice(0,100),
    [data]
  );

  function rub(value: string): string {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: data?.currency ?? "RUB",
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }

  return (
    <main className="app-shell">
      <AppSidebar active="finance-forecast" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Деньги / Планирование</p>
            <h1>Платёжный календарь</h1>
            <p className="workspace-summary">
              Когда денег станет не хватать, какие платежи к этому приведут и какие поступления ожидаются.
            </p>
          </div>

          <div className="header-actions">
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={14}>14 дней</option>
              <option value={30}>30 дней</option>
              <option value={60}>60 дней</option>
              <option value={90}>90 дней</option>
              <option value={180}>180 дней</option>
            </select>
            <button
              className="secondary-button"
              type="button"
              onClick={() => void load()}
            >
              Пересчитать
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Платёжный календарь</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <>
            {data.firstCashGapDate ? (
              <div className="inline-error">
                <strong>Ожидается кассовый разрыв</strong>
                <span>
                  Первая отрицательная дата:{" "}
                  {new Date(data.firstCashGapDate + "T00:00:00Z")
                    .toLocaleDateString("ru-RU")}
                </span>
              </div>
            ) : (
              <div className="quality-banner">
                <strong>Кассовый разрыв не прогнозируется</strong>
                <span>Горизонт: {data.horizonDays} дней</span>
              </div>
            )}

            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Деньги сейчас</span>
                <strong>{rub(data.openingBalanceMinor)}</strong>
                <small>Фактический остаток по активным счетам</small>
              </article>
              <article className="owner-kpi">
                <span>На конец горизонта</span>
                <strong>{rub(data.endingBalanceMinor)}</strong>
                <small>{data.horizonDays} дней</small>
              </article>
              <article className="owner-kpi">
                <span>Минимальный остаток</span>
                <strong>{rub(data.minimumBalanceMinor)}</strong>
                <small>
                  {new Date(data.minimumBalanceDate + "T00:00:00Z")
                    .toLocaleDateString("ru-RU")}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Просрочено к оплате</span>
                <strong>{rub(data.overduePayableMinor)}</strong>
                <small>
                  Нам должны: {rub(data.overdueReceivableMinor)}
                </small>
              </article>
            </div>

            {(data.undatedPayableMinor !== "0" ||
              data.undatedReceivableMinor !== "0") ? (
              <div className="quality-banner">
                <strong>Есть обязательства без даты</strong>
                <span>
                  К получению {rub(data.undatedReceivableMinor)} ·
                  к оплате {rub(data.undatedPayableMinor)}.
                  Они не включены в дневной прогноз.
                </span>
              </div>
            ) : null}

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Projected cash</p>
                  <h2>По дням</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Поступления</th>
                      <th>Платежи</th>
                      <th>Изменение</th>
                      <th>Остаток</th>
                      <th>Операций</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.calendar.map((day) => (
                      <tr key={day.date}>
                        <td>
                          <strong>
                            {new Date(day.date + "T00:00:00Z")
                              .toLocaleDateString("ru-RU", {
                                day:"2-digit",
                                month:"short"
                              })}
                          </strong>
                          {day.cashGap ? (
                            <small>кассовый разрыв</small>
                          ) : null}
                        </td>
                        <td>{rub(day.inflowMinor)}</td>
                        <td>{rub(day.outflowMinor)}</td>
                        <td>{rub(day.netMinor)}</td>
                        <td>
                          <strong>{rub(day.projectedBalanceMinor)}</strong>
                        </td>
                        <td>{day.items}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Source obligations</p>
                  <h2>Ближайшие платежи и поступления</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Контрагент</th>
                      <th>Тип</th>
                      <th>Сумма</th>
                      <th>Источник</th>
                    </tr>
                  </thead>
                  <tbody>
                    {upcoming.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.dueAt
                            ? new Date(item.dueAt).toLocaleDateString("ru-RU")
                            : "Без даты"}
                          {item.overdue ? <small>просрочено</small> : null}
                        </td>
                        <td>{item.partyName ?? "—"}</td>
                        <td>
                          {item.direction === "RECEIVABLE"
                            ? "Поступление"
                            : "Платёж"}
                        </td>
                        <td>{rub(item.remainingMinor)}</td>
                        <td>
                          <strong>{item.sourceType}</strong>
                          <small>{item.sourceId}</small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
