"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type TrackerSite = {
  id: string;
  name: string;
  tracker_key: string;
  allowed_domains: string[];
  status: string;
};

type MarketingConnection = {
  id: string;
  provider: string;
  name: string;
  external_account_id: string | null;
  client_login: string | null;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
};

type SyncJob = {
  id: string;
  connection_id: string;
  provider: string;
  period_from: string;
  period_to: string;
  status: string;
  attempts: number;
  retry_at: string | null;
  last_error: string | null;
  created_at: string;
};

export default function AnalyticsSettingsPage() {
  const [sites, setSites] = useState<TrackerSite[]>([]);
  const [connections, setConnections] = useState<MarketingConnection[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");

    try {
      const data = await Promise.all([
        apiRequest<TrackerSite[]>("/tracker/sites"),
        apiRequest<MarketingConnection[]>(
          "/analytics/marketing/connections"
        ),
        apiRequest<SyncJob[]>("/analytics/marketing/jobs")
      ]);

      setSites(data[0]);
      setConnections(data[1]);
      setJobs(data[2]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить настройки аналитики"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createSite() {
    const name = window.prompt("Название сайта");
    if (!name?.trim()) return;

    const rawDomains = window.prompt(
      "Разрешённые домены через запятую",
      ""
    );

    const allowedDomains = (rawDomains ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    try {
      const site = await apiRequest<{
        id: string;
        trackerKey: string;
      }>("/tracker/sites", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          allowedDomains
        })
      });

      window.prompt(
        "Публичный tracker key:",
        site.trackerKey
      );

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать tracker-site"
      );
    }
  }

  async function rotate(site: TrackerSite) {
    if (
      !window.confirm(
        "Старый tracker key перестанет принимать события. Продолжить?"
      )
    ) {
      return;
    }

    try {
      const result = await apiRequest<{
        trackerKey: string;
      }>("/tracker/sites/rotate", {
        method: "POST",
        body: JSON.stringify({
          siteId: site.id
        })
      });

      window.prompt(
        "Новый tracker key:",
        result.trackerKey
      );

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось ротировать ключ"
      );
    }
  }

  function snippet(site: TrackerSite) {
    const script =
      '<script src="/api/v1/tracker/script.js?key=' +
      encodeURIComponent(site.tracker_key) +
      '" defer></script>';

    window.prompt(
      "Вставьте перед </body>:",
      script
    );
  }

  async function connectYandex() {
    const name = window.prompt(
      "Название подключения",
      "Яндекс Директ"
    );
    if (!name?.trim()) return;

    const oauthToken = window.prompt(
      "OAuth-токен Яндекс Директа"
    );
    if (!oauthToken?.trim()) return;

    const clientLogin = window.prompt(
      "Client-Login, если нужен для агентского аккаунта. Иначе оставьте пустым.",
      ""
    );

    try {
      await apiRequest(
        "/analytics/marketing/connections/yandex-direct",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            oauthToken: oauthToken.trim(),
            clientLogin:
              clientLogin?.trim() || undefined
          })
        }
      );

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось подключить Яндекс Директ"
      );
    }
  }

  async function sync(connection: MarketingConnection) {
    const to = new Date();
    const from = new Date(
      to.getTime() - 30 * 86400000
    );

    try {
      await apiRequest(
        "/analytics/marketing/connections/" +
          connection.id +
          "/sync",
        {
          method: "POST",
          body: JSON.stringify({
            from: from
              .toISOString()
              .slice(0, 10),
            to: to
              .toISOString()
              .slice(0, 10)
          })
        }
      );

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось запустить синхронизацию"
      );
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="analytics-settings" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">
              Аналитика / Подключения
            </p>
            <h1>Источники данных</h1>
            <p className="workspace-summary">
              First-party tracker и рекламные кабинеты.
              Секреты не возвращаются в браузер после сохранения.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="secondary-button"
              onClick={() => void createSite()}
              type="button"
            >
              + Сайт
            </button>
            <button
              onClick={() => void connectYandex()}
              type="button"
            >
              + Яндекс Директ
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>
              Не удалось выполнить действие
            </strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">
                First-party
              </p>
              <h2>Трекер сайта</h2>
            </div>
          </div>

          <div className="tracker-site-grid">
            {sites.map((site) => (
              <article
                className="tracker-site-card"
                key={site.id}
              >
                <header>
                  <div>
                    <span>{site.status}</span>
                    <h2>{site.name}</h2>
                  </div>
                  <span className="status-pill">
                    {site.allowed_domains.length
                      ? site.allowed_domains.length +
                        " доменов"
                      : "Без allowlist"}
                  </span>
                </header>

                <code>{site.tracker_key}</code>

                <div className="tracker-domains">
                  {site.allowed_domains.map(
                    (domain) => (
                      <span key={domain}>
                        {domain}
                      </span>
                    )
                  )}
                </div>

                <div className="header-actions">
                  <button
                    className="secondary-button"
                    onClick={() => snippet(site)}
                    type="button"
                  >
                    Snippet
                  </button>
                  <button
                    onClick={() =>
                      void rotate(site)
                    }
                    type="button"
                  >
                    Ротировать
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">
                Advertising data
              </p>
              <h2>Рекламные кабинеты</h2>
            </div>
          </div>

          <div className="connection-grid">
            {connections.map(
              (connection) => (
                <article
                  className="connection-card"
                  key={connection.id}
                >
                  <header>
                    <div>
                      <span>
                        {connection.provider}
                      </span>
                      <h3>
                        {connection.name}
                      </h3>
                    </div>
                    <span className="status-pill">
                      {connection.status}
                    </span>
                  </header>

                  <dl>
                    <div>
                      <dt>Client-Login</dt>
                      <dd>
                        {connection.client_login ??
                          "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>
                        Последняя синхронизация
                      </dt>
                      <dd>
                        {connection.last_synced_at
                          ? new Date(
                              connection.last_synced_at
                            ).toLocaleString(
                              "ru-RU"
                            )
                          : "Ещё не было"}
                      </dd>
                    </div>
                  </dl>

                  {connection.last_error ? (
                    <div className="connection-error">
                      {connection.last_error}
                    </div>
                  ) : null}

                  <button
                    onClick={() =>
                      void sync(connection)
                    }
                    type="button"
                  >
                    Синхронизировать 30 дней
                  </button>
                </article>
              )
            )}

            {!connections.length ? (
              <div className="table-empty">
                <strong>
                  Рекламных подключений нет
                </strong>
                <span>
                  Добавьте Яндекс Директ,
                  чтобы видеть реальные расходы.
                </span>
              </div>
            ) : null}
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">
                Background sync
              </p>
              <h2>
                Последние синхронизации
              </h2>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Период</th>
                  <th>Статус</th>
                  <th>Попытки</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0, 50).map(
                  (job) => (
                    <tr key={job.id}>
                      <td>
                        {job.period_from} —{" "}
                        {job.period_to}
                      </td>
                      <td>
                        <span className="status-pill">
                          {job.status}
                        </span>
                      </td>
                      <td>{job.attempts}</td>
                      <td>
                        {job.last_error ?? "—"}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
