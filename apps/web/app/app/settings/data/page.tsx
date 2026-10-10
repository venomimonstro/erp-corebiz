"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type ExportJob = {
  id: string;
  format: string;
  status: string;
  filename: string | null;
  size_bytes: string | null;
  checksum_sha256: string | null;
  expires_at: string | null;
  completed_at: string | null;
  downloaded_at: string | null;
  last_error: string | null;
  created_at: string;
};

type Review = {
  reviewId: string;
  readiness: "READY" | "BLOCKED";
  blockers: Array<{ code: string; message: string; count?: number }>;
  warnings: Array<{ code: string; message: string; count?: number }>;
  snapshot: Record<string, unknown>;
  deletionAvailable: boolean;
  note: string;
};

export default function DataManagementPage() {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setJobs(await apiRequest<ExportJob[]>("/data-management/exports"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить экспорты"
      );
    }
  }, []);

  useEffect(() => {
    void load();

    const timer = window.setInterval(() => {
      void load();
    }, 5000);

    return () => window.clearInterval(timer);
  }, [load]);

  async function create(format: "JSON_GZIP" | "CSV_GZIP") {
    setBusy(format);
    setError("");
    try {
      await apiRequest("/data-management/exports", {
        method: "POST",
        body: JSON.stringify({ format })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось запустить экспорт"
      );
    } finally {
      setBusy("");
    }
  }

  async function checkOffboarding() {
    setBusy("review");
    setError("");
    try {
      setReview(
        await apiRequest<Review>("/data-management/offboarding/review", {
          method: "POST"
        })
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить готовность"
      );
    } finally {
      setBusy("");
    }
  }

  function size(value: string | null): string {
    if (!value) return "—";
    const bytes = Number(value);
    if (!Number.isFinite(bytes)) return "—";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " КБ";
    return (bytes / 1024 / 1024).toFixed(1) + " МБ";
  }

  return (
    <main className="app-shell">
      <AppSidebar active="data-management" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Настройки / Данные компании</p>
            <h1>Экспорт и offboarding</h1>
            <p className="workspace-summary">
              Полная выгрузка бизнес-данных без паролей, сессий, API-ключей и
              интеграционных секретов.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() => void create("CSV_GZIP")}
              type="button"
            >
              CSV
            </button>
            <button
              disabled={Boolean(busy)}
              onClick={() => void create("JSON_GZIP")}
              type="button"
            >
              Сформировать JSON
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Данные компании</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Асинхронная выгрузка</p>
              <h2>Экспорты</h2>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Создан</th>
                  <th>Формат</th>
                  <th>Статус</th>
                  <th>Размер</th>
                  <th>Checksum</th>
                  <th>Хранится до</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{new Date(job.created_at).toLocaleString("ru-RU")}</td>
                    <td>{job.format}</td>
                    <td>
                      <span className="status-pill">{job.status}</span>
                      {job.last_error ? <small>{job.last_error}</small> : null}
                    </td>
                    <td>{size(job.size_bytes)}</td>
                    <td>
                      {job.checksum_sha256 ? (
                        <code title={job.checksum_sha256}>
                          {job.checksum_sha256.slice(0, 12)}…
                        </code>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {job.expires_at
                        ? new Date(job.expires_at).toLocaleString("ru-RU")
                        : "—"}
                    </td>
                    <td className="table-actions">
                      {job.status === "READY" ? (
                        <a
                          className="secondary-button"
                          href={
                            "/api/v1/data-management/exports/" +
                            job.id +
                            "/download"
                          }
                        >
                          Скачать
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Без необратимых действий</p>
              <h2>Готовность к переносу / закрытию</h2>
            </div>
            <button
              className="secondary-button"
              disabled={Boolean(busy)}
              onClick={() => void checkOffboarding()}
              type="button"
            >
              Проверить готовность
            </button>
          </div>

          {review ? (
            <div className="offboarding-review">
              <div className="settings-card">
                <span className="status-pill">{review.readiness}</span>
                <h3>
                  {review.readiness === "READY"
                    ? "Критических блокеров нет"
                    : "Есть действия перед offboarding"}
                </h3>
                <p>{review.note}</p>
              </div>

              <div className="settings-card">
                <h3>Блокеры</h3>
                {review.blockers.length ? (
                  review.blockers.map((item) => (
                    <div className="action-item" key={item.code}>
                      <div>
                        <strong>{item.message}</strong>
                        <span>{item.code}</span>
                      </div>
                      {item.count !== undefined ? <b>{item.count}</b> : null}
                    </div>
                  ))
                ) : (
                  <p className="muted">Нет.</p>
                )}
              </div>

              <div className="settings-card">
                <h3>Предупреждения</h3>
                {review.warnings.length ? (
                  review.warnings.map((item) => (
                    <div className="action-item" key={item.code}>
                      <div>
                        <strong>{item.message}</strong>
                        <span>{item.code}</span>
                      </div>
                      {item.count !== undefined ? <b>{item.count}</b> : null}
                    </div>
                  ))
                ) : (
                  <p className="muted">Нет.</p>
                )}
              </div>
            </div>
          ) : (
            <div className="table-empty">
              <strong>Удаление tenant здесь не выполняется</strong>
              <span>
                Система только проверяет готовность и сохраняет снимок проверки.
              </span>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}
