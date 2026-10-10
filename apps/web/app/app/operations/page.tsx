"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Snapshot = {
  metric_code: string;
  value_minor: string;
  currency: string;
  metric_date: string;
  source_updated_at: string;
};

type Issue = {
  id: string;
  code: string;
  referenceId: string;
  firstSeenAt: string;
  href: string;
};

type Operational = {
  generatedAt: string;
  snapshots: Snapshot[];
  issues: Issue[];
};

const LABELS: Record<string,string> = {
  PAYMENTS_IN: "Поступления сегодня",
  PAYMENTS_OUT: "Списания сегодня",
  AR_OPEN: "Дебиторка",
  AP_OPEN: "Кредиторка",
  BANK_UNMATCHED: "Не сопоставлено в банке",
  VAT_UNREGISTERED: "НДС не зарегистрирован",
  CLOSE_BLOCKED: "Закрытие месяца заблокировано",
  PAYROLL_DRAFT: "Расчёт зарплаты не утверждён"
};

export default function OperationsPage() {
  const [data, setData] = useState<Operational | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiRequest<Operational>("/dashboard/operational"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить контроль бизнеса"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const snapshotMap = useMemo(
    () => new Map((data?.snapshots ?? []).map((row) => [row.metric_code,row])),
    [data]
  );

  function money(code: string): string {
    const row = snapshotMap.get(code);
    if (!row) return "—";
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: row.currency,
      maximumFractionDigits: 0
    }).format(Number(row.value_minor) / 100);
  }

  function count(code: string): string {
    return snapshotMap.get(code)?.value_minor ?? "0";
  }

  return (
    <main className="app-shell">
      <AppSidebar active="operations" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Владелец / Контроль</p>
            <h1>Что требует внимания</h1>
            <p className="workspace-summary">
              Деньги, несопоставленные операции, НДС, закрытие месяца и зарплата — только исключения, которые требуют действия.
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void load()}
          >
            Обновить
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Контроль бизнеса</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Поступления сегодня</span>
                <strong>{money("PAYMENTS_IN")}</strong>
                <small>Фактически проведённые платежи</small>
              </article>
              <article className="owner-kpi">
                <span>Списания сегодня</span>
                <strong>{money("PAYMENTS_OUT")}</strong>
                <small>Фактически проведённые платежи</small>
              </article>
              <article className="owner-kpi">
                <span>Дебиторка</span>
                <strong>{money("AR_OPEN")}</strong>
                <small>Открытые обязательства клиентов</small>
              </article>
              <article className="owner-kpi">
                <span>Кредиторка</span>
                <strong>{money("AP_OPEN")}</strong>
                <small>Открытые обязательства компании</small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Action & Exception</p>
                  <h2>
                    Требует действий · {data.issues.length}
                  </h2>
                </div>
              </div>

              <div className="action-queue">
                {data.issues.map((issue) => (
                  <a
                    className="action-item"
                    href={issue.href}
                    key={issue.id}
                  >
                    <span
                      className={
                        "severity-dot " +
                        (issue.code === "CLOSE_BLOCKED" ||
                        issue.code === "VAT_UNREGISTERED"
                          ? "critical"
                          : "warning")
                      }
                    />
                    <div>
                      <small>{issue.code}</small>
                      <strong>{LABELS[issue.code] ?? issue.code}</strong>
                      <span>
                        С{" "}
                        {new Date(issue.firstSeenAt).toLocaleString("ru-RU")}
                      </span>
                    </div>
                    <b>Открыть →</b>
                  </a>
                ))}

                {!data.issues.length ? (
                  <div className="table-empty">
                    <strong>Критичных исключений нет</strong>
                    <span>
                      Банковская сверка, НДС, закрытие месяца и payroll не требуют действия.
                    </span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Сегодня</p>
                  <h2>Контрольные показатели</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Показатель</th>
                      <th>Значение</th>
                      <th>Обновлён</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.snapshots.map((row) => (
                      <tr key={row.metric_code}>
                        <td>
                          <strong>
                            {LABELS[row.metric_code] ?? row.metric_code}
                          </strong>
                        </td>
                        <td>
                          {row.metric_code === "BANK_UNMATCHED"
                            ? count(row.metric_code)
                            : money(row.metric_code)}
                        </td>
                        <td>
                          {new Date(row.source_updated_at).toLocaleString("ru-RU")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="quality-banner">
              <strong>Срез обновлён</strong>
              <span>{new Date(data.generatedAt).toLocaleString("ru-RU")}</span>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
