"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Connection = {
  id: string;
  provider: string;
  name: string;
  status: string;
  last_received_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
};

type SyncJob = {
  id: string;
  connection_id: string;
  connection_name: string;
  provider: string;
  period_from: string;
  period_to: string;
  status: string;
  attempts: number;
  imported_orders: number;
  updated_orders: number;
  last_error: string | null;
  created_at: string;
};

type InboxRow = {
  id: string;
  connection_id: string;
  connection_name: string;
  provider: string;
  external_order_id: string;
  external_status: string | null;
  currency: string;
  ordered_at: string | null;
  status: string;
  sales_order_id: string | null;
  attempts: number;
  last_error: string | null;
  received_at: string;
  line_count: number;
  unmapped_lines: number;
};

type Product = {
  productName: string;
  skuId: string;
  sku: string;
};

type Details = {
  order: {
    id: string;
    connection_id: string;
    external_order_id: string;
    status: string;
  };
  lines: Array<{
    id: string;
    external_offer_id: string;
    title: string | null;
    quantity_milli: string;
    unit_price_minor: string;
    mapped_sku_id: string | null;
    sku_code: string | null;
  }>;
};

export default function ChannelsPage() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Details | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<Connection[]>("/channels/connections"),
        apiRequest<SyncJob[]>("/channels/sync-jobs"),
        apiRequest<InboxRow[]>("/channels/inbox"),
        apiRequest<Product[]>("/catalog/products")
      ]);
      setConnections(data[0]);
      setJobs(data[1]);
      setInbox(data[2]);
      setProducts(data[3]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить каналы"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createConnection() {
    const provider = (
      window.prompt(
        "Канал: OWN_SITE, API, OZON, WILDBERRIES",
        "OZON"
      ) ?? ""
    ).toUpperCase();

    if (!["OWN_SITE", "API", "OZON", "WILDBERRIES"].includes(provider)) {
      setError("Неизвестный тип канала");
      return;
    }

    const name = window.prompt(
      "Название канала",
      provider === "OZON"
        ? "Ozon FBS"
        : provider === "WILDBERRIES"
          ? "Wildberries FBS"
          : "Интернет-магазин"
    );
    if (!name?.trim()) return;

    try {
      if (provider === "OZON") {
        const clientId = window.prompt("Ozon Client-Id");
        if (!clientId?.trim()) return;
        const apiKey = window.prompt("Ozon Api-Key");
        if (!apiKey?.trim()) return;

        await apiRequest("/channels/connections/ozon", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            clientId: clientId.trim(),
            apiKey: apiKey.trim()
          })
        });
      } else if (provider === "WILDBERRIES") {
        const apiToken = window.prompt("Wildberries Marketplace API token");
        if (!apiToken?.trim()) return;

        await apiRequest("/channels/connections/wildberries", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            apiToken: apiToken.trim()
          })
        });
      } else {
        const created = await apiRequest<{
          id: string;
          webhookSecret: string | null;
        }>("/channels/connections", {
          method: "POST",
          body: JSON.stringify({
            provider,
            name: name.trim()
          })
        });

        if (created.webhookSecret) {
          const url =
            window.location.origin +
            "/api/v1/channels/webhook/" +
            created.id +
            "/" +
            created.webhookSecret +
            "/orders";

          window.prompt(
            "Webhook URL. Секрет показывается только сейчас:",
            url
          );
        }
      }

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать канал"
      );
    }
  }

  async function sync(connection: Connection) {
    try {
      await apiRequest(
        "/channels/connections/" + connection.id + "/sync",
        {
          method: "POST",
          body: JSON.stringify({})
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

  async function openOrder(id: string) {
    try {
      setSelected(await apiRequest<Details>("/channels/inbox/" + id));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось открыть заказ"
      );
    }
  }

  async function mapLine(line: Details["lines"][number]) {
    if (!selected) return;

    const query = window.prompt(
      "Введите SKU или часть названия товара",
      line.external_offer_id
    );
    if (!query?.trim()) return;

    const normalized = query.toLowerCase();
    const candidates = products
      .filter(
        (item) =>
          item.sku.toLowerCase().includes(normalized) ||
          item.productName.toLowerCase().includes(normalized)
      )
      .slice(0, 20);

    if (!candidates.length) {
      setError("Подходящий SKU не найден");
      return;
    }

    const list = candidates
      .map(
        (item, index) =>
          `${index + 1}. ${item.productName} · ${item.sku}`
      )
      .join("\n");

    const index =
      Number(window.prompt("Выберите SKU:\n" + list, "1")) - 1;
    const product = candidates[index];
    if (!product) return;

    try {
      await apiRequest(
        "/channels/connections/" +
          selected.order.connection_id +
          "/mappings",
        {
          method: "POST",
          body: JSON.stringify({
            externalOfferId: line.external_offer_id,
            skuId: product.skuId
          })
        }
      );

      await openOrder(selected.order.id);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить mapping"
      );
    }
  }

  async function importOrder(row: InboxRow) {
    try {
      const result = await apiRequest<{
        salesOrderId: string;
        number: string;
      }>("/channels/inbox/" + row.id + "/import", {
        method: "POST"
      });

      window.alert("Создан внутренний заказ " + result.number);
      setSelected(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось импортировать заказ"
      );
    }
  }

  async function ignore(row: InboxRow) {
    if (
      !window.confirm(
        "Игнорировать внешний заказ " + row.external_order_id + "?"
      )
    ) {
      return;
    }

    try {
      await apiRequest("/channels/inbox/" + row.id + "/ignore", {
        method: "PATCH"
      });
      setSelected(null);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось игнорировать заказ"
      );
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="channels" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Commerce / Integration Inbox</p>
            <h1>Каналы продаж</h1>
            <p className="workspace-summary">
              Ozon, Wildberries, сайт и API сначала нормализуются в Inbox; ERP меняется только после контролируемого импорта.
            </p>
          </div>

          <button onClick={() => void createConnection()} type="button">
            + Канал
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="growth-site-grid">
          {connections.map((connection) => (
            <article className="settings-card" key={connection.id}>
              <div className="growth-site-heading">
                <div>
                  <span className="status-pill">{connection.status}</span>
                  <h3>{connection.name}</h3>
                </div>
                <b>{connection.provider}</b>
              </div>

              <dl className="growth-site-meta">
                <div>
                  <dt>Последний sync</dt>
                  <dd>
                    {connection.last_synced_at
                      ? new Date(connection.last_synced_at).toLocaleString("ru-RU")
                      : "Ещё не было"}
                  </dd>
                </div>
                <div>
                  <dt>Последний заказ</dt>
                  <dd>
                    {connection.last_received_at
                      ? new Date(connection.last_received_at).toLocaleString("ru-RU")
                      : "Нет данных"}
                  </dd>
                </div>
                {connection.last_error ? (
                  <div>
                    <dt>Ошибка</dt>
                    <dd>{connection.last_error}</dd>
                  </div>
                ) : null}
              </dl>

              {["OZON", "WILDBERRIES"].includes(connection.provider) ? (
                <button
                  onClick={() => void sync(connection)}
                  type="button"
                >
                  Синхронизировать 7 дней
                </button>
              ) : null}
            </article>
          ))}
        </div>

        {jobs.length ? (
          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="muted">Marketplace sync</p>
                <h2>Последние синхронизации</h2>
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Канал</th>
                    <th>Период</th>
                    <th>Статус</th>
                    <th>Новых</th>
                    <th>Обновлено</th>
                    <th>Попытки</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.slice(0, 20).map((job) => (
                    <tr key={job.id}>
                      <td>
                        <strong>{job.connection_name}</strong>
                        <small>{job.provider}</small>
                      </td>
                      <td>
                        {new Date(job.period_from).toLocaleDateString("ru-RU")} —{" "}
                        {new Date(job.period_to).toLocaleDateString("ru-RU")}
                      </td>
                      <td>
                        <span className="status-pill">{job.status}</span>
                        {job.last_error ? <small>{job.last_error}</small> : null}
                      </td>
                      <td>{job.imported_orders}</td>
                      <td>{job.updated_orders}</td>
                      <td>{job.attempts}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <div className="channel-inbox-layout section-block">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Канал</th>
                  <th>Внешний заказ</th>
                  <th>Статус</th>
                  <th>Строки</th>
                  <th>Получен</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {inbox.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.connection_name}</strong>
                      <small>{row.provider}</small>
                    </td>
                    <td>
                      <strong>{row.external_order_id}</strong>
                      <small>{row.external_status ?? "—"}</small>
                    </td>
                    <td>
                      <span className="status-pill">{row.status}</span>
                      {row.last_error ? <small>{row.last_error}</small> : null}
                    </td>
                    <td>
                      {row.line_count}
                      {row.unmapped_lines > 0 ? (
                        <small>не сопоставлено {row.unmapped_lines}</small>
                      ) : null}
                    </td>
                    <td>{new Date(row.received_at).toLocaleString("ru-RU")}</td>
                    <td className="table-actions">
                      <button
                        className="secondary-button"
                        onClick={() => void openOrder(row.id)}
                        type="button"
                      >
                        Открыть
                      </button>
                      {row.status === "READY" || row.status === "FAILED" ? (
                        <button
                          onClick={() => void importOrder(row)}
                          type="button"
                        >
                          Импорт
                        </button>
                      ) : null}
                      {!["IMPORTED", "IGNORED"].includes(row.status) ? (
                        <button
                          className="secondary-button"
                          onClick={() => void ignore(row)}
                          type="button"
                        >
                          Игнорировать
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected ? (
            <aside className="channel-order-panel">
              <header>
                <div>
                  <span>Внешний заказ</span>
                  <strong>{selected.order.external_order_id}</strong>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => setSelected(null)}
                  type="button"
                >
                  ×
                </button>
              </header>

              <div className="channel-line-list">
                {selected.lines.map((line) => (
                  <article key={line.id}>
                    <div>
                      <strong>{line.title ?? line.external_offer_id}</strong>
                      <span>
                        offer {line.external_offer_id} · qty{" "}
                        {Number(line.quantity_milli) / 1000}
                      </span>
                    </div>

                    {line.mapped_sku_id ? (
                      <span className="status-pill">
                        SKU {line.sku_code}
                      </span>
                    ) : (
                      <button
                        onClick={() => void mapLine(line)}
                        type="button"
                      >
                        Сопоставить
                      </button>
                    )}
                  </article>
                ))}
              </div>
            </aside>
          ) : null}
        </div>
      </section>
    </main>
  );
}
