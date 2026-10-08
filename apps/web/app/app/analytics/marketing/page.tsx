"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Connection = {
  id: string;
  provider: string;
  name: string;
  client_login: string | null;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
};

type Stats = {
  totals: {
    spendMinor: string;
    impressions: string;
    clicks: string;
    conversions: string;
  };
  campaigns: Array<{
    id: string;
    name: string;
    status: string | null;
    spend_minor: string;
    impressions: string;
    clicks: string;
    conversions: string;
  }>;
};

function rub(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function MarketingAnalyticsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<Connection[]>("/analytics/marketing/connections"),
        apiRequest<Stats>("/analytics/marketing/stats")
      ]);
      setConnections(data[0]);
      setStats(data[1]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить рекламную аналитику"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function connectYandex() {
    const name = window.prompt("Название подключения", "Яндекс Директ");
    if (!name?.trim()) return;

    const oauthToken = window.prompt("OAuth-токен Яндекс Директ");
    if (!oauthToken?.trim()) return;

    const clientLogin =
      window.prompt(
        "Client-Login, если это агентский клиент. Иначе оставьте пустым.",
        ""
      ) ?? "";

    try {
      await apiRequest("/analytics/marketing/connections/yandex-direct", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          oauthToken: oauthToken.trim(),
          clientLogin: clientLogin.trim() || undefined
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось подключить Яндекс Директ"
      );
    }
  }

  async function sync(connection: Connection) {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 30 * 86400000)
      .toISOString()
      .slice(0, 10);

    try {
      await apiRequest(
        "/analytics/marketing/connections/" + connection.id + "/sync",
        {
          method: "POST",
          body: JSON.stringify({ from, to })
        }
      );
      window.alert("Синхронизация поставлена в очередь");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось запустить синхронизацию"
      );
    }
  }

  const cpc =
    stats && Number(stats.totals.clicks) > 0
      ? Math.round(
          Number(stats.totals.spendMinor) /
            Number(stats.totals.clicks)
        )
      : 0;

  return (
    <main className="app-shell">
      <AppSidebar active="marketing" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Маркетинг / Рекламные кабинеты</p>
            <h1>Реклама</h1>
            <p className="workspace-summary">
              Расходы из рекламного кабинета будут связаны с CRM, оплатами и прибылью.
            </p>
          </div>

          <button onClick={() => void connectYandex()} type="button">
            + Яндекс Директ
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {stats ? (
          <div className="owner-kpi-grid">
            <article className="owner-kpi">
              <span>Расход · 30 дней</span>
              <strong>{rub(stats.totals.spendMinor)}</strong>
              <small>Фактические данные Direct</small>
            </article>
            <article className="owner-kpi">
              <span>Показы</span>
              <strong>{Number(stats.totals.impressions).toLocaleString("ru-RU")}</strong>
              <small>По синхронизированным кампаниям</small>
            </article>
            <article className="owner-kpi">
              <span>Клики</span>
              <strong>{Number(stats.totals.clicks).toLocaleString("ru-RU")}</strong>
              <small>CPC ≈ {rub(String(cpc))}</small>
            </article>
            <article className="owner-kpi">
              <span>Конверсии рекламной системы</span>
              <strong>{stats.totals.conversions}</strong>
              <small>CRM-конверсии считаются отдельно</small>
            </article>
          </div>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Интеграции</p>
              <h2>Подключения</h2>
            </div>
          </div>

          <div className="growth-site-grid">
            {connections.map((connection) => (
              <article className="settings-card" key={connection.id}>
                <div className="growth-site-heading">
                  <div>
                    <span className="status-pill">{connection.status}</span>
                    <h3>{connection.name}</h3>
                  </div>
                  <button
                    onClick={() => void sync(connection)}
                    type="button"
                  >
                    Синхронизировать
                  </button>
                </div>

                <dl className="growth-site-meta">
                  <div>
                    <dt>Провайдер</dt>
                    <dd>{connection.provider}</dd>
                  </div>
                  <div>
                    <dt>Client-Login</dt>
                    <dd>{connection.client_login ?? "Не используется"}</dd>
                  </div>
                  <div>
                    <dt>Последняя синхронизация</dt>
                    <dd>
                      {connection.last_synced_at
                        ? new Date(connection.last_synced_at).toLocaleString("ru-RU")
                        : "Ещё не было"}
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
        </section>

        {stats ? (
          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="muted">Кампании</p>
                <h2>Расходы</h2>
              </div>
            </div>

            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Кампания</th>
                    <th>Расход</th>
                    <th>Показы</th>
                    <th>Клики</th>
                    <th>CPC</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.campaigns.map((campaign) => {
                    const clicks = Number(campaign.clicks);
                    const campaignCpc =
                      clicks > 0
                        ? Math.round(Number(campaign.spend_minor) / clicks)
                        : 0;

                    return (
                      <tr key={campaign.id}>
                        <td>
                          <strong>{campaign.name}</strong>
                          <small>{campaign.status ?? "—"}</small>
                        </td>
                        <td>{rub(campaign.spend_minor)}</td>
                        <td>{Number(campaign.impressions).toLocaleString("ru-RU")}</td>
                        <td>{clicks.toLocaleString("ru-RU")}</td>
                        <td>{rub(String(campaignCpc))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
