"use client";

import { useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type EntityType = "PRODUCTS" | "CUSTOMERS";
type BatchSummary = {
  batchId: string;
  status: string;
  rowCount: number;
  validCount: number;
  errorCount: number;
  mapping: Record<string, string>;
  reused: boolean;
};
type BatchPreview = {
  batch: {
    id: string;
    filename: string;
    entity_type: EntityType;
    status: string;
    row_count: number;
    valid_count: number;
    error_count: number;
    imported_count: number;
  };
  rows: Array<{
    id: string;
    row_number: number;
    normalized_data: Record<string, string>;
    status: string;
    errors: string[];
  }>;
};
type ImportResult = {
  batchId: string;
  imported: number;
  skipped: number;
  errors: number;
  status: string;
  reconciliation: {
    balanced: boolean;
    validRows: number;
    importedRows: number;
    skippedDuplicates: number;
    errorRows: number;
  };
};

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.onload = () => {
      const data = reader.result;
      if (typeof data !== "string" || !data.includes(";base64,")) {
        reject(new Error("Некорректный формат файла"));
        return;
      }
      resolve(data.slice(data.indexOf(";base64,") + 8));
    };
    reader.readAsDataURL(file);
  });
}

const formatCount = (n: number) => new Intl.NumberFormat("ru-RU").format(n);

export default function MigrationPage() {
  const [entity, setEntity] = useState<EntityType>("PRODUCTS");
  const [file, setFile] = useState<File | null>(null);
  const [summary, setSummary] = useState<BatchSummary | null>(null);
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<"upload" | "import" | "">("");
  const [error, setError] = useState("");

  function reset(nextEntity?: EntityType) {
    if (nextEntity) setEntity(nextEntity);
    setFile(null);
    setSummary(null);
    setPreview(null);
    setResult(null);
    setError("");
  }

  async function upload() {
    if (!file || busy) return;
    setError("");
    if (!/\.(csv|xlsx)$/i.test(file.name)) {
      setError("Поддерживаются CSV и XLSX.");
      return;
    }
    // Stay below the server's base64/json request boundary.
    if (!file.size || file.size > 10 * 1024 * 1024) {
      setError("Выберите файл до 10 МБ. Большую выгрузку разбейте на части.");
      return;
    }
    setBusy("upload");
    try {
      const contentBase64 = await toBase64(file);
      const data = await apiRequest<BatchSummary>("/migration/ingest", {
        method: "POST",
        body: JSON.stringify({
          entityType: entity,
          filename: file.name,
          contentBase64,
          idempotencyKey: crypto.randomUUID()
        })
      });
      setSummary(data);
      setPreview(await apiRequest<BatchPreview>(
        "/migration/" + encodeURIComponent(data.batchId) + "/preview"
      ));
      setResult(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ошибка проверки файла");
    } finally {
      setBusy("");
    }
  }

  async function importRows() {
    if (!summary || !preview || busy || summary.validCount === 0 ||
        preview.batch.status !== "VALIDATED") return;
    const agrees = window.confirm(
      "Импортировать " + formatCount(summary.validCount) + " корректных строк?\n" +
      "Ошибочных строк: " + formatCount(summary.errorCount) + ". Они будут пропущены.\n" +
      "Этот импорт не меняет остатки склада и не создаёт заказы или оплаты."
    );
    if (!agrees) return;
    setBusy("import");
    setError("");
    try {
      const imported = await apiRequest<ImportResult>(
        "/migration/" + encodeURIComponent(summary.batchId) + "/import",
        { method: "POST", body: "{}" }
      );
      setResult(imported);
      setPreview(await apiRequest<BatchPreview>(
        "/migration/" + encodeURIComponent(summary.batchId) + "/preview"
      ));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выполнить импорт");
    } finally {
      setBusy("");
    }
  }

  const rows = preview?.rows ?? [];
  const keys = rows.length ? Object.keys(rows[0]!.normalized_data) : [];
  const canImport = Boolean(
    summary && preview && summary.validCount > 0 &&
    preview.batch.status === "VALIDATED" && !busy
  );

  return (
    <main className="app-shell">
      <AppSidebar active="migration" />
      <section className="workspace workspace-wide merchant-migration">
        <header className="workspace-header">
          <div>
            <p className="muted">Онлайн-торговля / Импорт каталога</p>
            <h1>Импорт товаров и клиентов</h1>
            <p className="workspace-summary">
              Загрузите CSV или Excel, проверьте распознанные поля,
              исправьте ошибки и только затем перенесите данные в CoreBiz.
            </p>
          </div>
          <div className="header-actions">
            <a className="secondary-button" href="/app/catalog/products">Каталог товаров</a>
            <a className="secondary-button" href="/app/sites">Конструктор магазина</a>
          </div>
        </header>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Шаг 1 из 3</p>
              <h2>Выберите данные и файл</h2>
            </div>
          </div>
          <div className="merchant-migration-form">
            <label>
              <span>Что переносим</span>
              <select value={entity} disabled={Boolean(busy)}
                onChange={e => reset(e.target.value as EntityType)}>
                <option value="PRODUCTS">Номенклатура, артикулы, цены</option>
                <option value="CUSTOMERS">Клиенты / контрагенты</option>
              </select>
            </label>
            <label>
              <span>Выгрузка CSV или XLSX (до 10 МБ)</span>
              <input type="file" accept=".csv,.xlsx"
                disabled={Boolean(busy)} onChange={e => {
                  const selected = e.target.files?.[0] ?? null;
                  setFile(selected); setSummary(null); setPreview(null);
                  setResult(null); setError("");
                }} />
            </label>
            <button type="button" disabled={!file || Boolean(busy)}
              onClick={() => void upload()}>
              {busy === "upload" ? "Проверяем…" : "Проверить файл"}
            </button>
          </div>
          <p className="muted">
            Для товаров рекомендуемые колонки: Название, Артикул, Штрихкод,
            Цена, Себестоимость. Для клиентов: Контрагент, Телефон, Email, Тип.
            Импортные данные сначала проходят проверку. Файл не публикуется на сайте.
          </p>
        </section>

        {error ? <div className="studio-message error" role="alert">{error}</div> : null}

        {summary && preview ? (
          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="muted">Шаг 2 из 3</p>
                <h2>Результат проверки</h2>
                <p>Файл: {preview.batch.filename}</p>
              </div>
            </div>
            <div className="merchant-migration-metrics">
              <article><span>Строк</span><strong>{formatCount(summary.rowCount)}</strong></article>
              <article><span>Корректно</span><strong>{formatCount(summary.validCount)}</strong></article>
              <article><span>Ошибок</span><strong>{formatCount(summary.errorCount)}</strong></article>
            </div>
            <h3>Распознанные поля</h3>
            <div className="merchant-migration-fields">
              {Object.entries(summary.mapping).map(([field, source]) => (
                <span key={field}>{source} → {field}</span>
              ))}
              {!Object.keys(summary.mapping).length ?
                <p>Поля не распознаны. Проверьте заголовки таблицы.</p> : null}
            </div>

            <h3>Предпросмотр (первые {Math.min(rows.length, 30)} строк)</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Строка</th><th>Состояние</th>
                  {keys.map(key => <th key={key}>{key}</th>)}<th>Ошибки</th></tr></thead>
                <tbody>
                  {rows.slice(0, 30).map(row => (
                    <tr key={row.id}>
                      <td>{row.row_number}</td>
                      <td><span className="status-pill">{row.status}</span></td>
                      {keys.map(key => <td key={key}>{row.normalized_data[key] || "—"}</td>)}
                      <td>{row.errors.length ? row.errors.join("; ") : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {summary.errorCount > 0 ? (
              <p className="merchant-migration-note">
                Строки с ошибками не переносятся. Исправьте выгрузку и загрузите её повторно,
                либо подтвердите перенос только корректных строк.
              </p>
            ) : null}
            <div className="merchant-migration-actions">
              <button type="button" disabled={!canImport}
                onClick={() => void importRows()}>
                {busy === "import" ? "Переносим…" : "Импортировать корректные строки"}
              </button>
              <button className="secondary-button" type="button"
                disabled={Boolean(busy)} onClick={() => reset()}>
                Другой файл
              </button>
            </div>
          </section>
        ) : null}

        {result ? (
          <section className="section-block">
            <p className="muted">Шаг 3 из 3</p>
            <h2>Импорт завершён</h2>
            <div className="merchant-migration-metrics">
              <article><span>Создано</span><strong>{formatCount(result.imported)}</strong></article>
              <article><span>Уже существуют</span><strong>{formatCount(result.skipped)}</strong></article>
              <article><span>Ошибочных строк</span><strong>{formatCount(result.errors)}</strong></article>
            </div>
            <p>{result.reconciliation.balanced ?
              "Все корректные строки обработаны (созданы или пропущены как дубликаты)." :
              "Сверка не прошла. Не используйте импорт в боевом учёте до проверки."}</p>
            <div className="merchant-migration-actions">
              <a className="secondary-button"
                href={entity === "PRODUCTS" ? "/app/catalog/products" : "/app/crm/customers"}>
                Проверить данные
              </a>
              <button type="button" onClick={() => reset()}>Загрузить следующий файл</button>
            </div>
          </section>
        ) : null}

        <section className="section-block merchant-migration-note">
          <h2>Простой и безопасный импорт</h2>
          <p>
            Здесь можно добавить товары и клиентов обычным файлом CSV/XLSX.
            Импорт не создаёт остатки на складах, заказы, резервы, оплаты или
            бухгалтерские документы. Оформляйте эти операции в соответствующих
            разделах CoreBiz, чтобы остатки и финансы оставались корректными.
          </p>
        </section>
      </section>
    </main>
  );
}
