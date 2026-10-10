"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type QueueBucket = {
  pending?: number;
  running?: number;
  uploadedWaitingStatus?: number;
};

type Pressure = {
  state: "NORMAL" | "ELEVATED" | "HIGH";
  pressureScore: number;
  queue: {
    exports: QueueBucket;
    channelSync: QueueBucket;
    marketingSync: QueueBucket;
    offlineConversions: QueueBucket;
    workflow: QueueBucket;
    outbox: QueueBucket;
  };
  deniedLast24h: number;
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

const LABELS: Record<string, string> = {
  exports: "Экспорт данных",
  channelSync: "Маркетплейсы",
  marketingSync: "Реклама",
  offlineConversions: "Офлайн-конверсии",
  workflow: "Автоматизации",
  outbox: "Системные события"
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
  }, [load]);

  return (
    <main className="app-shell">
      <AppSidebar active="runtime-pressure" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Управление / Стабильность</p>
            <h1>Нагрузка системы</h1>
            <p className="workspace-summary">
              Очереди ограничиваются по компании, чтобы одна тяжёлая операция
              не замедляла ежедневную работу и других клиентов SaaS.
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
            <strong>Нагрузка</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Состояние</span>
                <strong>{data.state}</strong>
                <small>
                  {data.state === "NORMAL"
                    ? "Фоновые очереди в норме"
                    : data.state === "ELEVATED"
                      ? "Есть повышенная фоновая нагрузка"
                      : "Нужно дождаться разгрузки очередей"}
                </small>
              </article>

              <article className="owner-kpi">
                <span>Pressure score</span>
                <strong>{data.pressureScore}</strong>
                <small>NORMAL &lt; 30 · HIGH от 100</small>
              </article>

              <article className="owner-kpi">
                <span>Ограничено за 24 часа</span>
                <strong>{data.deniedLast24h}</strong>
                <small>
                  Тяжёлые операции, остановленные до перегрузки
                </small>
              </article>

              <article className="owner-kpi">
                <span>Фоновые очереди</span>
                <strong>
                  {Object.values(data.queue).reduce(
                    (sum, item) =>
                      sum +
                      Number(item.pending ?? 0) +
                      Number(item.running ?? 0) +
                      Number(item.uploadedWaitingStatus ?? 0),
                    0
                  )}
                </strong>
                <small>Незавершённые задачи компании</small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Background workload</p>
                  <h2>Очереди</h2>
                </div>
              </div>

              <div className="runtime-pressure-grid">
                {Object.entries(data.queue).map(([key, value]) => {
                  const total =
                    Number(value.pending ?? 0) +
                    Number(value.running ?? 0) +
                    Number(value.uploadedWaitingStatus ?? 0);

                  return (
                    <article className="settings-card" key={key}>
                      <div className="growth-site-heading">
                        <h3>{LABELS[key] ?? key}</h3>
                        <span className="status-pill">
                          {total === 0
                            ? "EMPTY"
                            : total >= 20
                              ? "BUSY"
                              : "ACTIVE"}
                        </span>
                      </div>

                      <dl className="growth-site-meta">
                        {"pending" in value ? (
                          <div>
                            <dt>Ожидают</dt>
                            <dd>{value.pending ?? 0}</dd>
                          </div>
                        ) : null}
                        {"running" in value ? (
                          <div>
                            <dt>В работе</dt>
                            <dd>{value.running ?? 0}</dd>
                          </div>
                        ) : null}
                        {"uploadedWaitingStatus" in value ? (
                          <div>
                            <dt>Ждут ответа провайдера</dt>
                            <dd>{value.uploadedWaitingStatus ?? 0}</dd>
                          </div>
                        ) : null}
                      </dl>
                    </article>
                  );
                })}
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Noisy-neighbor protection</p>
                  <h2>Последние ограничения</h2>
                </div>
              </div>

              <div className="action-queue">
                {data.recentEvents.map((event) => (
                  <article className="action-item" key={event.id}>
                    <span
                      className={
                        "severity-dot " +
                        (event.limit_value !== null &&
                        event.current_value !== null &&
                        event.current_value >= event.limit_value
                          ? "warning"
                          : "")
                      }
                    />
                    <div>
                      <small>
                        {new Date(event.created_at).toLocaleString("ru-RU")}
                      </small>
                      <strong>{event.operation}</strong>
                      <span>
                        {event.reason}
                        {event.current_value !== null &&
                        event.limit_value !== null
                          ? " · " +
                            event.current_value +
                            " / " +
                            event.limit_value
                          : ""}
                      </span>
                    </div>
                    <b>
                      {event.retry_after_seconds
                        ? event.retry_after_seconds + " сек."
                        : "LIMIT"}
                    </b>
                  </article>
                ))}

                {!data.recentEvents.length ? (
                  <div className="table-empty">
                    <strong>Ограничений не было</strong>
                    <span>
                      За последние 24 часа компания не упиралась в runtime
                      budget.
                    </span>
                  </div>
                ) : null}
              </div>
            </section>

            <div className="quality-banner">
              <strong>Что происходит при превышении лимита</strong>
              <span>
                Тяжёлая операция получает retryAfter и не забирает ресурсы у
                CRM, заказов, склада и других ежедневных операций.
              </span>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
