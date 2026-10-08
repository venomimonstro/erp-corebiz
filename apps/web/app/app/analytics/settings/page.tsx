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
  created_at: string;
};

export default function AnalyticsSettingsPage() {
  const [sites, setSites] = useState<TrackerSite[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setSites(await apiRequest<TrackerSite[]>("/tracker/sites"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить tracker-sites"
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
      "Разрешённые домены через запятую, например example.ru,www.example.ru",
      ""
    );

    const allowedDomains = (rawDomains ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    try {
      const site = await apiRequest<{ id: string; trackerKey: string }>(
        "/tracker/sites",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            allowedDomains
          })
        }
      );

      window.prompt(
        "Публичный tracker key. Он не является секретом:",
        site.trackerKey
      );

      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать tracker-site");
    }
  }

  async function rotate(site: TrackerSite) {
    if (
      !window.confirm(
        "После ротации старый tracker key перестанет принимать события. Продолжить?"
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
      setError(cause instanceof Error ? cause.message : "Не удалось ротировать ключ");
    }
  }

  function snippet(site: TrackerSite) {
    const script =
      '<script src="/api/v1/tracker/script.js?key=' +
      encodeURIComponent(site.tracker_key) +
      '" defer></script>';

    window.prompt("Вставьте перед </body>:", script);
  }

  return (
    <main className="app-shell">
      <AppSidebar active="analytics-settings" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Аналитика / First-party tracker</p>
            <h1>Трекер сайта</h1>
            <p className="workspace-summary">
              Visitor/session ID анонимны, IP и user-agent хранятся только в HMAC-виде.
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

        <div className="tracker-site-grid">
          {sites.map((site) => (
            <article className="tracker-site-card" key={site.id}>
              <header>
                <div>
                  <span>{site.status}</span>
                  <h2>{site.name}</h2>
                </div>
                <span className="status-pill">
                  {site.allowed_domains.length
                    ? site.allowed_domains.length + " доменов"
                    : "Без allowlist"}
                </span>
              </header>

              <code>{site.tracker_key}</code>

              <div className="tracker-domains">
                {site.allowed_domains.map((domain) => (
                  <span key={domain}>{domain}</span>
                ))}
              </div>

              <div className="header-actions">
                <button
                  className="secondary-button"
                  onClick={() => snippet(site)}
                  type="button"
                >
                  Snippet
                </button>
                <button onClick={() => void rotate(site)} type="button">
                  Ротировать
                </button>
              </div>
            </article>
          ))}

          {!sites.length ? (
            <div className="table-empty">
              <strong>Tracker-site пока нет</strong>
              <span>
                Создайте сайт, получите snippet и начните собирать first-party события.
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
