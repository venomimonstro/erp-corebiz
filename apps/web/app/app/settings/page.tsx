"use client";

import { ChangeEvent, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type BatchSummary = {
  batchId: string;
  status: string;
  rowCount: number;
  validCount: number;
  errorCount: number;
  mapping: Record<string, string>;
  reused: boolean;
};

type Preview = {
  batch: Record<string, any>;
  rows: Array<{
    id: string;
    row_number?: number;
    rowNumber?: number;
    normalized_data?: Record<string, unknown>;
    normalizedData?: Record<string, unknown>;
    status: string;
    errors: unknown[];
  }>;
};

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

export default function SettingsPage() {
  const [entityType, setEntityType] = useState<"PRODUCTS" | "CUSTOMERS">("PRODUCTS");
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setSummary(null);
    setPreview(null);
    setResult(null);
    setError("");
  }

  async function analyze() {
    if (!file) {
      setError("Выберите CSV или XLSX");
      return;
    }

    setPending(true);
    setError("");
    setResult(null);

    try {
      const contentBase64 = await fileToBase64(file);
      const batch = await apiRequest<BatchSummary>("/migration/ingest", {
        method: "POST",
        body: JSON.stringify({
          entityType,
          filename: file.name,
          contentBase64,
          idempotencyKey:
            "file:" + entityType + ":" + file.name + ":" + file.size + ":" + file.lastModified
        })
      });

      const previewData = await apiRequest<Preview>(
        "/migration/" + batch.batchId + "/preview"
      );

      setSummary(batch);
      setPreview(previewData);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось проанализировать файл"
      );
    } finally {
      setPending(false);
    }
  }

  async function importBatch() {
    if (!summary) return;

    setPending(true);
    setError("");

    try {
      const importResult = await apiRequest<Record<string, unknown>>(
        "/migration/" + summary.batchId + "/import",
        { method: "POST" }
      );

      setResult(importResult);

      const previewData = await apiRequest<Preview>(
        "/migration/" + summary.batchId + "/preview"
      );
      setPreview(previewData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выполнить импорт");
    } finally {
      setPending(false);
    }
  }

  const quality = summary?.rowCount
    ? Math.round((summary.validCount / summary.rowCount) * 10000) / 100
    : 0;

  return (
    <main className="app-shell">
      <AppSidebar active="settings" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Система / Настройка компании</p>
            <h1>Настройки</h1>
            <p className="workspace-summary">
              Импорт данных проходит через проверку и reconciliation до записи в рабочие справочники.
            </p>
          </div>
        </header>

        <section className="settings-card">
          <div className="section-heading">
            <div>
              <p className="muted">Migration Center</p>
              <h2>Импорт данных</h2>
            </div>
          </div>

          <div className="migration-controls">
            <label>
              Что импортируем
              <select
                value={entityType}
                onChange={(event) =>
                  setEntityType(event.target.value as "PRODUCTS" | "CUSTOMERS")
                }
              >
                <option value="PRODUCTS">Товары</option>
                <option value="CUSTOMERS">Клиенты</option>
              </select>
            </label>

            <label>
              CSV или XLSX
              <input
                accept=".csv,.xlsx"
                onChange={selectFile}
                type="file"
              />
            </label>

            <button disabled={pending || !file} onClick={() => void analyze()} type="button">
              {pending ? "Проверяем…" : "Проверить файл"}
            </button>
          </div>

          {error ? (
            <div className="inline-error">
              <strong>Импорт не готов</strong>
              <span>{error}</span>
            </div>
          ) : null}

          {summary ? (
            <>
              <div className="migration-summary">
                <article>
                  <span>Строк</span>
                  <strong>{summary.rowCount}</strong>
                </article>
                <article>
                  <span>Готовы</span>
                  <strong>{summary.validCount}</strong>
                </article>
                <article>
                  <span>С ошибками</span>
                  <strong>{summary.errorCount}</strong>
                </article>
                <article>
                  <span>Качество</span>
                  <strong>{quality}%</strong>
                </article>
              </div>

              <div className="mapping-box">
                <strong>Автосопоставление колонок</strong>
                <div>
                  {Object.entries(summary.mapping).map(([target, source]) => (
                    <span key={target}>
                      {source} → <b>{target}</b>
                    </span>
                  ))}
                </div>
              </div>

              <div className="header-actions migration-import-action">
                <button disabled={pending || summary.validCount === 0} onClick={() => void importBatch()} type="button">
                  Импортировать {summary.validCount} строк
                </button>
              </div>
            </>
          ) : null}

          {result ? (
            <div className="success-banner">
              <strong>Импорт завершён</strong>
              <span>{JSON.stringify(result)}</span>
            </div>
          ) : null}

          {preview ? (
            <div className="data-table-wrap migration-preview">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Строка</th>
                    <th>Нормализованные данные</th>
                    <th>Статус</th>
                    <th>Ошибки</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.slice(0, 50).map((row, index) => (
                    <tr key={row.id}>
                      <td>{row.rowNumber ?? row.row_number ?? index + 2}</td>
                      <td>
                        <code>
                          {JSON.stringify(row.normalizedData ?? row.normalized_data ?? {})}
                        </code>
                      </td>
                      <td>
                        <span className="status-pill">{row.status}</span>
                      </td>
                      <td>{Array.isArray(row.errors) ? row.errors.join("; ") : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      </section>
    </main>
  );
}
