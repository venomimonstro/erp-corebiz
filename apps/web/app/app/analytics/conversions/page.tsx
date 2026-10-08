"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type CallConnection = {
  id: string;
  provider: string;
  name: string;
  status: string;
  tracker_site_id: string | null;
  last_received_at: string | null;
  last_error: string | null;
};

type Call = {
  id: string;
  external_call_id: string;
  started_at: string;
  duration_seconds: number;
  status: string;
  outcome: string | null;
  source: string | null;
  party_name: string | null;
  connection_name: string;
  provider: string;
};

type OfflineConnection = {
  id: string;
  provider: string;
  name: string;
  counter_id: string;
  target: string;
  status: string;
  last_export_at: string | null;
  last_error: string | null;
};

type OfflineJob = {
  id: string;
  conversion_type: string;
  target: string;
  occurred_at: string;
  value_minor: string;
  currency: string;
  status: string;
  attempts: number;
  provider_upload_id: string | null;
  provider_status: string | null;
  last_error: string | null;
  connection_name: string;
};

function money(value: string, currency = "RUB"): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function ConversionBridgePage() {
  const [callConnections, setCallConnections] = useState<CallConnection[]>([]);
  const [calls, setCalls] = useState<Call[]>([]);
  const [offlineConnections, setOfflineConnections] = useState<OfflineConnection[]>([]);
  const [jobs, setJobs] = useState<OfflineJob[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<CallConnection[]>("/analytics/conversions/calltracking/connections"),
        apiRequest<Call[]>("/analytics/conversions/calls"),
        apiRequest<OfflineConnection[]>("/analytics/conversions/offline/connections"),
        apiRequest<OfflineJob[]>("/analytics/conversions/offline/jobs")
      ]);
      setCallConnections(data[0]);
      setCalls(data[1]);
      setOfflineConnections(data[2]);
      setJobs(data[3]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить конверсии");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createCallConnection() {
    const name = window.prompt("Название подключения", "Calltracking");
    if (!name?.trim()) return;

    const provider = (
      window.prompt("Провайдер: CALLTOUCH, ROISTAT, MANGO, OTHER", "CALLTOUCH") ??
      "OTHER"
    ).toUpperCase();

    if (!["CALLTOUCH", "ROISTAT", "MANGO", "OTHER"].includes(provider)) {
      setError("Неизвестный провайдер");
      return;
    }

    try {
      const created = await apiRequest<{
        id: string;
        webhookSecret: string;
      }>("/analytics/conversions/calltracking/connections", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          provider
        })
      });

      const webhook =
        window.location.origin +
        "/api/v1/analytics/conversions/calltracking/webhook/" +
        created.id +
        "/" +
        created.webhookSecret;

      window.prompt(
        "Webhook URL. Секрет показывается один раз — сохраните URL у провайдера:",
        webhook
      );

      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать calltracking");
    }
  }

  async function createMetricaConnection() {
    const name = window.prompt("Название подключения", "Яндекс Метрика");
    if (!name?.trim()) return;

    const counterId = window.prompt("ID счётчика Метрики");
    if (!counterId?.trim()) return;

    const target = window.prompt(
      "Target — ID JavaScript-цели в Метрике",
      "order_confirmed"
    );
    if (!target?.trim()) return;

    const oauthToken = window.prompt("OAuth-токен Метрики");
    if (!oauthToken?.trim()) return;

    try {
      await apiRequest(
        "/analytics/conversions/offline/connections/yandex-metrica",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            counterId: counterId.trim(),
            target: target.trim(),
            oauthToken: oauthToken.trim()
          })
        }
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подключить Метрику");
    }
  }

  async function queue(connection: OfflineConnection) {
    try {
      const result = await apiRequest<{
        queued: number;
        skippedNoYclid: number;
      }>(
        "/analytics/conversions/offline/connections/" +
          connection.id +
          "/queue",
        {
          method: "POST",
          body: JSON.stringify({
            model: "LAST_PAID_TOUCH"
          })
        }
      );

      window.alert(
        "В очередь: " +
          result.queued +
          ". Без YCLID: " +
          result.skippedNoYclid
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось поставить конверсии в очередь");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="conversions" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Маркетинг / Звонки и обратная передача</p>
            <h1>Конверсии</h1>
            <p className="workspace-summary">
              Звонки связываются с visitor/CRM, а подтверждённые бизнес-конверсии отправляются обратно в Метрику.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="secondary-button"
              onClick={() => void createCallConnection()}
              type="button"
            >
              + Calltracking
            </button>
            <button
              onClick={() => void createMetricaConnection()}
              type="button"
            >
              + Метрика
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Webhook integrations</p>
              <h2>Calltracking</h2>
            </div>
          </div>

          <div className="growth-site-grid">
            {callConnections.map((connection) => (
              <article className="settings-card" key={connection.id}>
                <div className="growth-site-heading">
                  <div>
                    <span className="status-pill">{connection.status}</span>
                    <h3>{connection.name}</h3>
                  </div>
                  <b>{connection.provider}</b>
                </div>
                <dl className="growth-site-meta">
                  <div>
                    <dt>Последний звонок</dt>
                    <dd>
                      {connection.last_received_at
                        ? new Date(connection.last_received_at).toLocaleString("ru-RU")
                        : "Нет данных"}
                    </dd>
                  </div>
                  {connection.last_error ? (
                    <div>
                      <dt>Ошибка</dt>
                      <dd>{connection.last_error}</dd>
                    </div>
                  ) : null}
                </dl>
              </article>
            ))}
          </div>

          <div className="data-table-wrap section-block">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Провайдер</th>
                  <th>Клиент</th>
                  <th>Статус</th>
                  <th>Длительность</th>
                  <th>Источник</th>
                </tr>
              </thead>
              <tbody>
                {calls.slice(0, 100).map((call) => (
                  <tr key={call.id}>
                    <td>{new Date(call.started_at).toLocaleString("ru-RU")}</td>
                    <td>
                      <strong>{call.connection_name}</strong>
                      <small>{call.provider}</small>
                    </td>
                    <td>{call.party_name ?? "Не идентифицирован"}</td>
                    <td><span className="status-pill">{call.status}</span></td>
                    <td>{call.duration_seconds} сек.</td>
                    <td>{call.source ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Yandex Metrica</p>
              <h2>Офлайн-конверсии</h2>
            </div>
          </div>

          <div className="growth-site-grid">
            {offlineConnections.map((connection) => (
              <article className="settings-card" key={connection.id}>
                <div className="growth-site-heading">
                  <div>
                    <span className="status-pill">{connection.status}</span>
                    <h3>{connection.name}</h3>
                  </div>
                  <button onClick={() => void queue(connection)} type="button">
                    Передать новые
                  </button>
                </div>
                <dl className="growth-site-meta">
                  <div>
                    <dt>Счётчик</dt>
                    <dd>{connection.counter_id}</dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>{connection.target}</dd>
                  </div>
                  <div>
                    <dt>Последний export</dt>
                    <dd>
                      {connection.last_export_at
                        ? new Date(connection.last_export_at).toLocaleString("ru-RU")
                        : "Ещё не было"}
                    </dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>

          <div className="data-table-wrap section-block">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Конверсия</th>
                  <th>Дата</th>
                  <th>Ценность</th>
                  <th>Статус</th>
                  <th>Метрика</th>
                  <th>Попытки</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>
                      <strong>{job.conversion_type}</strong>
                      <small>{job.target}</small>
                    </td>
                    <td>{new Date(job.occurred_at).toLocaleString("ru-RU")}</td>
                    <td>{money(job.value_minor, job.currency)}</td>
                    <td><span className="status-pill">{job.status}</span></td>
                    <td>
                      {job.provider_status ?? "—"}
                      {job.provider_upload_id ? (
                        <small>upload #{job.provider_upload_id}</small>
                      ) : null}
                    </td>
                    <td>
                      {job.attempts}
                      {job.last_error ? <small>{job.last_error}</small> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
