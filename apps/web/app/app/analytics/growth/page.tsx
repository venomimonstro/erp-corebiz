"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Site = {
  id: string;
  name: string;
  tracker_key: string;
  allowed_domains: string[];
  status: string;
};

type Summary = {
  totals: {
    visitors: string | number;
    sessions: string | number;
    pageviews: string | number;
    events: string | number;
  };
  sources: Array<{
    source: string;
    medium: string;
    sessions: number;
    visitors: number;
  }>;
  campaigns: Array<{
    campaign: string;
    source: string;
    sessions: number;
    visitors: number;
  }>;
};

export default function GrowthAnalyticsPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<Site[]>("/tracker/sites"),
        apiRequest<Summary>("/tracker/summary")
      ]);
      setSites(data[0]);
      setSummary(data[1]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить аналитику"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createSite() {
    const name = window.prompt("Название сайта", "Основной сайт");
    if (!name?.trim()) return;

    const domainsRaw = window.prompt(
      "Разрешённые домены через запятую",
      "example.ru"
    );
    if (!domainsRaw?.trim()) return;

    const allowedDomains = domainsRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    try {
      const created = await apiRequest<{
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
        "Tracker key. Скопируйте для установки счётчика:",
        created.trackerKey
      );

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать tracker site"
      );
    }
  }

  async function rotate(site: Site) {
    if (
      !window.confirm(
        "Старый ключ перестанет принимать события. Продолжить?"
      )
    ) {
      return;
    }

    try {
      const result = await apiRequest<{ trackerKey: string }>(
        "/tracker/sites/rotate",
        {
          method: "POST",
          body: JSON.stringify({ siteId: site.id })
        }
      );

      window.prompt("Новый tracker key:", result.trackerKey);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось сменить ключ"
      );
    }
  }

  function scriptUrl(site: Site): string {
    if (typeof window === "undefined") return "";
    return (
      window.location.origin +
      "/api/v1/tracker/script.js?key=" +
      encodeURIComponent(site.tracker_key)
    );
  }

  return (
    <main className="app-shell">
      <AppSidebar active="growth" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Маркетинг / Сквозная аналитика</p>
            <h1>Трафик и источники</h1>
            <p className="workspace-summary">
              First-party события сохраняются только после согласия на аналитику.
            </p>
          </div>

          <button onClick={() => void createSite()} type="button">
            + Сайт
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {summary ? (
          <div className="owner-kpi-grid">
            <article className="owner-kpi">
              <span>Посетители · 30 дней</span>
              <strong>{String(summary.totals.visitors ?? 0)}</strong>
              <small>Уникальные анонимные visitor</small>
            </article>
            <article className="owner-kpi">
              <span>Сессии</span>
              <strong>{String(summary.totals.sessions ?? 0)}</strong>
              <small>Сессии с consent=GRANTED</small>
            </article>
            <article className="owner-kpi">
              <span>Просмотры</span>
              <strong>{String(summary.totals.pageviews ?? 0)}</strong>
              <small>События page_view</small>
            </article>
            <article className="owner-kpi">
              <span>Все события</span>
              <strong>{String(summary.totals.events ?? 0)}</strong>
              <small>Без скрытого fingerprinting</small>
            </article>
          </div>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Tracker sites</p>
              <h2>Установленные сайты</h2>
            </div>
          </div>

          <div className="growth-site-grid">
            {sites.map((site) => (
              <article className="settings-card" key={site.id}>
                <div className="growth-site-heading">
                  <div>
                    <span className="status-pill">{site.status}</span>
                    <h3>{site.name}</h3>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => void rotate(site)}
                    type="button"
                  >
                    Сменить ключ
                  </button>
                </div>

                <dl className="growth-site-meta">
                  <div>
                    <dt>Домены</dt>
                    <dd>{site.allowed_domains.join(", ")}</dd>
                  </div>
                  <div>
                    <dt>Tracker key</dt>
                    <dd><code>{site.tracker_key}</code></dd>
                  </div>
                  <div>
                    <dt>Script</dt>
                    <dd><code>{scriptUrl(site)}</code></dd>
                  </div>
                </dl>
              </article>
            ))}

            {!sites.length ? (
              <div className="table-empty">
                <strong>Tracker ещё не установлен</strong>
                <span>Добавьте сайт и разрешённые домены.</span>
              </div>
            ) : null}
          </div>
        </section>

        {summary ? (
          <section className="growth-breakdown">
            <div className="settings-card">
              <strong>Источники</strong>
              <div className="mini-ranking">
                {summary.sources.map((row) => (
                  <article key={row.source + ":" + row.medium}>
                    <div>
                      <strong>{row.source}</strong>
                      <span>{row.medium} · {row.visitors} посетителей</span>
                    </div>
                    <b>{row.sessions}</b>
                  </article>
                ))}
              </div>
            </div>

            <div className="settings-card">
              <strong>Кампании</strong>
              <div className="mini-ranking">
                {summary.campaigns.map((row) => (
                  <article key={row.source + ":" + row.campaign}>
                    <div>
                      <strong>{row.campaign}</strong>
                      <span>{row.source} · {row.visitors} посетителей</span>
                    </div>
                    <b>{row.sessions}</b>
                  </article>
                ))}
              </div>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
