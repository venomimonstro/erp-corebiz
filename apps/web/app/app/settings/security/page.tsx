"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Session = {
  id: string;
  current: boolean;
  active: boolean;
  membershipId: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  userAgent: string | null;
};

type AuditRow = {
  id: string;
  email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_data: unknown;
  after_data: unknown;
  reason: string | null;
  trace_id: string | null;
  created_at: string;
};

export default function SecurityCenterPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await apiRequest<Session[]>("/security-center/sessions"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить сессии"
      );
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (action.trim()) query.set("action", action.trim());
      if (resourceType.trim()) query.set("resourceType", resourceType.trim());
      query.set("limit", "200");

      setAudit(
        await apiRequest<AuditRow[]>(
          "/security-center/audit?" + query.toString()
        )
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить журнал действий"
      );
    }
  }, [action, resourceType]);

  useEffect(() => {
    void loadSessions();
    void loadAudit();
  }, [loadSessions, loadAudit]);

  async function revoke(session: Session) {
    const text = session.current
      ? "Отозвать текущую сессию? После следующего запроса потребуется войти снова."
      : "Отозвать эту сессию?";
    if (!window.confirm(text)) return;

    setBusy(session.id);
    try {
      await apiRequest(
        "/security-center/sessions/" + session.id + "/revoke",
        { method: "POST" }
      );
      await loadSessions();
      if (session.current) window.location.href = "/login";
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось отозвать сессию"
      );
    } finally {
      setBusy("");
    }
  }

  async function revokeOthers() {
    if (!window.confirm("Завершить все остальные активные сессии?")) return;

    setBusy("others");
    try {
      const result = await apiRequest<{ revoked: number }>(
        "/security-center/sessions/revoke-others",
        { method: "POST" }
      );
      window.alert("Завершено сессий: " + result.revoked);
      await loadSessions();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось завершить сессии"
      );
    } finally {
      setBusy("");
    }
  }

  const activeCount = useMemo(
    () => sessions.filter((session) => session.active).length,
    [sessions]
  );

  function device(userAgent: string | null): string {
    if (!userAgent) return "Неизвестное устройство";
    const browser =
      userAgent.includes("Chrome")
        ? "Chrome"
        : userAgent.includes("Firefox")
          ? "Firefox"
          : userAgent.includes("Safari")
            ? "Safari"
            : "Браузер";
    const os =
      userAgent.includes("Windows")
        ? "Windows"
        : userAgent.includes("Mac OS")
          ? "macOS"
          : userAgent.includes("Android")
            ? "Android"
            : userAgent.includes("iPhone") || userAgent.includes("iPad")
              ? "iOS"
              : "";
    return [browser, os].filter(Boolean).join(" · ");
  }

  return (
    <main className="app-shell">
      <AppSidebar active="security-center" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Настройки / Безопасность</p>
            <h1>Безопасность и аудит</h1>
            <p className="workspace-summary">
              Активные входы и журнал действий внутри текущей компании.
            </p>
          </div>

          <button
            className="secondary-button"
            disabled={Boolean(busy) || activeCount <= 1}
            onClick={() => void revokeOthers()}
            type="button"
          >
            Завершить остальные сессии
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Security Center</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">{activeCount} активных</p>
              <h2>Сессии</h2>
            </div>
          </div>

          <div className="settings-grid">
            {sessions.map((session) => (
              <article className="settings-card" key={session.id}>
                <div className="growth-site-heading">
                  <div>
                    <span className="status-pill">
                      {session.active ? "ACTIVE" : "CLOSED"}
                    </span>
                    <h3>{device(session.userAgent)}</h3>
                  </div>
                  {session.current ? <b>Текущая</b> : null}
                </div>

                <dl className="growth-site-meta">
                  <div>
                    <dt>Последняя активность</dt>
                    <dd>
                      {session.lastSeenAt
                        ? new Date(session.lastSeenAt).toLocaleString("ru-RU")
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Создана</dt>
                    <dd>{new Date(session.createdAt).toLocaleString("ru-RU")}</dd>
                  </div>
                  <div>
                    <dt>Истекает</dt>
                    <dd>{new Date(session.expiresAt).toLocaleString("ru-RU")}</dd>
                  </div>
                </dl>

                {session.active ? (
                  <button
                    className="secondary-button"
                    disabled={busy === session.id}
                    onClick={() => void revoke(session)}
                    type="button"
                  >
                    Завершить сессию
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">До 200 последних событий</p>
              <h2>Журнал действий</h2>
            </div>

            <div className="header-actions">
              <input
                placeholder="Действие, например auth.login"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              />
              <input
                placeholder="Тип объекта"
                value={resourceType}
                onChange={(event) => setResourceType(event.target.value)}
              />
              <button
                className="secondary-button"
                onClick={() => void loadAudit()}
                type="button"
              >
                Найти
              </button>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Объект</th>
                  <th>Причина / trace</th>
                  <th>Изменения</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toLocaleString("ru-RU")}</td>
                    <td>{row.email ?? "Система"}</td>
                    <td><code>{row.action}</code></td>
                    <td>
                      <strong>{row.resource_type}</strong>
                      <small>{row.resource_id ?? "—"}</small>
                    </td>
                    <td>
                      {row.reason ?? "—"}
                      {row.trace_id ? <small>{row.trace_id}</small> : null}
                    </td>
                    <td>
                      <details>
                        <summary>Открыть</summary>
                        <pre className="audit-json">
                          {JSON.stringify(
                            {
                              before: row.before_data,
                              after: row.after_data
                            },
                            null,
                            2
                          )}
                        </pre>
                      </details>
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
