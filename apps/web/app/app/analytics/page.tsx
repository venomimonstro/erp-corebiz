"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Stats = {
  totals: {
    spendMinor: string;
    impressions: string;
    clicks: string;
    conversions: string;
  };
  campaigns: Array<{
    id: string;
    external_campaign_id: string;
    name: string;
    status: string | null;
    currency: string;
    spend_minor: string;
    impressions: string;
    clicks: string;
    conversions: string;
  }>;
  daily: Array<{
    stat_date: string;
    spend_minor: string;
    impressions: string;
    clicks: string;
    conversions: string;
  }>;
};

function money(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

function number(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 2
  }).format(Number(value));
}

export default function AnalyticsPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");

    try {
      setStats(await apiRequest<Stats>("/analytics/marketing/stats"));
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

  const cpc =
    stats && Number(stats.totals.clicks) > 0
      ? Number(stats.totals.spendMinor) /
        Number(stats.totals.clicks)
      : 0;

  return (
    <main className="app-shell">
      <AppSidebar active="analytics" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Сквозная аналитика / Реклама</p>
            <h1>Маркетинг</h1>
            <p className="workspace-summary">
              Пока здесь расходы и трафик. На следующем контуре они связываются
              с лидами, заказами и фактической выручкой.
            </p>
          </div>

          <a className="button-link" href="/app/analytics/settings">
            Подключения
          </a>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось загрузить данные</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {stats ? (
          <>
            <div className="metric-grid">
              <article className="metric-card">
                <span>Расходы</span>
                <strong>{money(stats.totals.spendMinor)}</strong>
                <small>За последние 30 дней</small>
              </article>

              <article className="metric-card">
                <span>Клики</span>
                <strong>{number(stats.totals.clicks)}</strong>
                <small>
                  CPC{" "}
                  {money(String(Math.round(cpc)))}
                </small>
              </article>

              <article className="metric-card">
                <span>Показы</span>
                <strong>{number(stats.totals.impressions)}</strong>
                <small>
                  Конверсии провайдера: {number(stats.totals.conversions)}
                </small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Кампании</p>
                  <h2>Расходы по кампаниям</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Кампания</th>
                      <th>Расход</th>
                      <th>Клики</th>
                      <th>Показы</th>
                      <th>CPC</th>
                      <th>Конверсии</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.campaigns.map((campaign) => {
                      const campaignCpc =
                        Number(campaign.clicks) > 0
                          ? Number(campaign.spend_minor) /
                            Number(campaign.clicks)
                          : 0;

                      return (
                        <tr key={campaign.id}>
                          <td>
                            <strong>{campaign.name}</strong>
                            <small>{campaign.external_campaign_id}</small>
                          </td>
                          <td>{money(campaign.spend_minor)}</td>
                          <td>{number(campaign.clicks)}</td>
                          <td>{number(campaign.impressions)}</td>
                          <td>{money(String(Math.round(campaignCpc)))}</td>
                          <td>{number(campaign.conversions)}</td>
                        </tr>
                      );
                    })}

                    {!stats.campaigns.length ? (
                      <tr>
                        <td colSpan={6}>
                          <div className="table-empty">
                            <strong>Рекламных данных пока нет</strong>
                            <span>
                              Подключите рекламный кабинет и запустите синхронизацию.
                            </span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
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
