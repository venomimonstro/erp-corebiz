"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Check = {
  code: string;
  title: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  href: string;
};

type Readiness = {
  profile: string;
  ready: boolean;
  stage: "PREPARING" | "HYPERCARE" | "LIVE";
  goLiveAt: string | null;
  hypercareUntil: string | null;
  blockers: Check[];
  warnings: Check[];
  checks: Check[];
  history: Array<{
    id: string;
    decision: "GO" | "NO_GO";
    note: string | null;
    reviewed_at: string;
  }>;
};

export default function GoLivePage() {
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiRequest<Readiness>("/go-live/readiness"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить готовность"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function review(decision: "GO" | "NO_GO") {
    if (!data) return;

    const note =
      window.prompt(
        decision === "GO"
          ? "Комментарий к запуску"
          : "Почему NO-GO?",
        decision === "GO"
          ? "Проверки пройдены, запускаем tenant."
          : "Зафиксировать блокеры перед повторной проверкой."
      ) ?? "";

    if (
      !window.confirm(
        decision === "GO"
          ? "Зафиксировать решение GO? Это не выполняет deploy, только переводит tenant в HYPERCARE."
          : "Зафиксировать NO-GO?"
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      await apiRequest("/go-live/review", {
        method: "POST",
        body: JSON.stringify({
          decision,
          note,
          hypercareDays: 14
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить решение"
      );
    } finally {
      setBusy(false);
    }
  }

  async function finishHypercare() {
    if (
      !window.confirm(
        "Завершить HYPERCARE и перевести tenant в LIVE? Текущие blockers будут перепроверены сервером."
      )
    ) {
      return;
    }

    setBusy(true);
    try {
      await apiRequest("/go-live/finish-hypercare", {
        method: "POST"
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось завершить hypercare"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="go-live" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Управление / Запуск</p>
            <h1>Go-Live Center</h1>
            <p className="workspace-summary">
              Формальный readiness gate tenant. Здесь не выполняется deploy и не изменяется инфраструктура.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void load()}
            >
              Перепроверить
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              type="button"
              onClick={() => void review("NO_GO")}
            >
              NO-GO
            </button>
            <button
              disabled={busy || !data?.ready}
              type="button"
              onClick={() => void review("GO")}
            >
              GO
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Go-Live</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Readiness</span>
                <strong>{data.ready ? "GO" : "NO-GO"}</strong>
                <small>
                  {data.blockers.length} blockers · {data.warnings.length} warnings
                </small>
              </article>
              <article className="owner-kpi">
                <span>Stage</span>
                <strong>{data.stage}</strong>
                <small>Профиль: {data.profile}</small>
              </article>
              <article className="owner-kpi">
                <span>Go-live</span>
                <strong>
                  {data.goLiveAt
                    ? new Date(data.goLiveAt).toLocaleDateString("ru-RU")
                    : "—"}
                </strong>
                <small>Первый формальный GO</small>
              </article>
              <article className="owner-kpi">
                <span>Hypercare до</span>
                <strong>
                  {data.hypercareUntil
                    ? new Date(data.hypercareUntil).toLocaleDateString("ru-RU")
                    : "—"}
                </strong>
                <small>Контроль после запуска</small>
              </article>
            </div>

            {data.blockers.length ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Release blockers</p>
                    <h2>Что запрещает GO</h2>
                  </div>
                </div>

                <div className="action-queue">
                  {data.blockers.map((check) => (
                    <a className="action-item" href={check.href} key={check.code}>
                      <span className="severity-dot critical" />
                      <div>
                        <small>{check.code}</small>
                        <strong>{check.title}</strong>
                        <span>{check.detail}</span>
                      </div>
                      <b>Исправить →</b>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}

            {data.warnings.length ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Non-blocking</p>
                    <h2>Предупреждения</h2>
                  </div>
                </div>

                <div className="action-queue">
                  {data.warnings.map((check) => (
                    <a className="action-item" href={check.href} key={check.code}>
                      <span className="severity-dot warning" />
                      <div>
                        <small>{check.code}</small>
                        <strong>{check.title}</strong>
                        <span>{check.detail}</span>
                      </div>
                      <b>Открыть →</b>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">All checks</p>
                  <h2>Матрица готовности</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Проверка</th>
                      <th>Статус</th>
                      <th>Тип</th>
                      <th>Деталь</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.checks.map((check) => (
                      <tr key={check.code}>
                        <td>
                          <strong>{check.title}</strong>
                          <small>{check.code}</small>
                        </td>
                        <td>
                          <span className="status-pill">
                            {check.ok ? "PASS" : "FAIL"}
                          </span>
                        </td>
                        <td>{check.blocking ? "BLOCKER" : "WARNING"}</td>
                        <td>{check.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {data.stage === "HYPERCARE" ? (
              <div className="quality-banner">
                <strong>Tenant в HYPERCARE</strong>
                <span>
                  После стабильной работы повторите проверки и завершите hypercare.
                </span>
                <button
                  type="button"
                  disabled={busy || !data.ready}
                  onClick={() => void finishHypercare()}
                >
                  Перевести в LIVE
                </button>
              </div>
            ) : null}

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Immutable history</p>
                  <h2>История решений</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Решение</th>
                      <th>Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {new Date(row.reviewed_at).toLocaleString("ru-RU")}
                        </td>
                        <td>
                          <span className="status-pill">{row.decision}</span>
                        </td>
                        <td>{row.note ?? "—"}</td>
                      </tr>
                    ))}
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
