"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Pressure = {
  state: "NORMAL" | "ELEVATED" | "HIGH";
  pressureScore: number;
  deniedLast24h: number;
  queue: {
    exports: { pending: number; running: number };
    channelSync: { pending: number; running: number };
    marketingSync: { pending: number; running: number };
    offlineConversions: {
      pending: number;
      uploadedWaitingStatus: number;
    };
    workflow: { pending: number };
    outbox: { pending: number };
  };
  recentEvents: Array<{
    id: string;
    operation: string;
    reason: string;
    current_value: number | null;
    limit_value: number | null;
    retry_after_seconds: number | null;
    created_at: string;
  }>;
};

export default function RuntimePressurePage() {
  const [data, setData] = useState<Pressure | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(
        await apiRequest<Pressure>("/runtime-pressure/overview")
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить состояние нагрузки"
      );
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, [load]);

  return (
    <main className="app-shell">
      <AppSidebar active="runtime-pressure" />
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Настройки / Стабильность</p>
            <h1>Нагрузка tenant</h1>
            <p className="workspace-summary">
              Очереди и ограничения тяжёлых операций. Лимиты защищают общий SaaS
              от перегрузки одним клиентом.
            </p>
          </div>
          <button
            className="secondary-button"
            onClick={() => void load()}
            type="button"
          >
            Обновить
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Runtime pressure</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Состояние</span>
                <strong>{data.state}</strong>
                <small>Pressure score {data.pressureScore}</small>
              </article>
              <article className="owner-kpi">
                <span>Отклонено за 24 ч</span>
                <strong>{data.deniedLast24h}</strong>
                <small>Fail-fast вместо перегрузки worker</small>
              </article>
              <article className="owner-kpi">
                <span>Marketplace</span>
                <strong>
                  {data.queue.channelSync.pending +
                    data.queue.channelSync.running}
                </strong>
                <small>
                  pending {data.queue.channelSync.pending} · running{" "}
                  {data.queue.channelSync.running}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Marketing</span>
                <strong>
                  {data.queue.marketingSync.pending +
                    data.queue.marketingSync.running}
                </strong>
                <small>
                  pending {data.queue.marketingSync.pending} · running{" "}
                  {data.queue.marketingSync.running}
                </small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Queue depth</p>
                  <h2>Фоновые операции</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Очередь</th>
                      <th>Pending</th>
                      <th>Running / waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>Экспорты</td>
                      <td>{data.queue.exports.pending}</td>
                      <td>{data.queue.exports.running}</td>
                    </tr>
                    <tr>
                      <td>Marketplace sync</td>
                      <td>{data.queue.channelSync.pending}</td>
                      <td>{data.queue.channelSync.running}</td>
                    </tr>
                    <tr>
                      <td>Marketing sync</td>
                      <td>{data.queue.marketingSync.pending}</td>
                      <td>{data.queue.marketingSync.running}</td>
                    </tr>
                    <tr>
                      <td>Offline conversions</td>
                      <td>{data.queue.offlineConversions.pending}</td>
                      <td>
                        {data.queue.offlineConversions.uploadedWaitingStatus}
                      </td>
                    </tr>
                    <tr>
                      <td>Workflow</td>
                      <td>{data.queue.workflow.pending}</td>
                      <td>—</td>
                    </tr>
                    <tr>
                      <td>Outbox</td>
                      <td>{data.queue.outbox.pending}</td>
                      <td>—</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Last 24 hours</p>
                  <h2>Сработавшие ограничения</h2>
                </div>
              </div>
              <div className="action-queue">
                {data.recentEvents.map((event) => (
                  <article className="action-item" key={event.id}>
                    <span className="severity-dot warning" />
                    <div>
                      <strong>{event.operation}</strong>
                      <span>
                        {event.reason} ·{" "}
                        {new Date(event.created_at).toLocaleString("ru-RU")}
                      </span>
                    </div>
                    <b>
                      {event.current_value ?? "—"} /{" "}
                      {event.limit_value ?? "—"}
                    </b>
                  </article>
                ))}
                {!data.recentEvents.length ? (
                  <div className="table-empty">
                    <strong>Ограничения не срабатывали</strong>
                    <span>Tenant работает в нормальном бюджете.</span>
                  </div>
                ) : null}
              </div>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
