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
  last_error: string | null;
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
  const [inbox, setInbox] = useState<InboxRow[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selected, setSelected] = useState<Details | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<Connection[]>("/channels/connections"),
        apiRequest<InboxRow[]>("/channels/inbox"),
        apiRequest<Product[]>("/catalog/products")
      ]);
      setConnections(data[0]);
      setInbox(data[1]);
      setProducts(data[2]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить каналы");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createConnection() {
    const provider = (
      window.prompt(
        "Канал: OWN_SITE, API, OZON, WILDBERRIES, YANDEX_MARKET",
        "OWN_SITE"
      ) ?? ""
    ).toUpperCase();

    if (
      !["OWN_SITE", "API", "OZON", "WILDBERRIES", "YANDEX_MARKET"].includes(
        provider
      )
    ) {
      setError("Неизвестный тип канала");
      return;
    }

    const name = window.prompt("Название канала", "Интернет-магазин");
    if (!name?.trim()) return;

    try {
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
      } else {
        window.alert(
          "Канал создан. Авторизация marketplace будет добавлена профильным коннектором."
        );
      }

      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать канал");
    }
  }

  async function openOrder(id: string) {
    try {
      setSelected(await apiRequest<Details>("/channels/inbox/" + id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть заказ");
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

    const index = Number(window.prompt("Выберите SKU:\n" + list, "1")) - 1;
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
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить mapping");
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
      setError(cause instanceof Error ? cause.message : "Не удалось импортировать заказ");
    }
  }

  async function ignore(row: InboxRow) {
    if (!window.confirm("Игнорировать внешний заказ " + row.external_order_id + "?")) {
      return;
    }

    try {
      await apiRequest("/channels/inbox/" + row.id + "/ignore", {
        method: "PATCH"
      });
      setSelected(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось игнорировать заказ");
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
              Внешний заказ сначала нормализуется и сопоставляется, и только затем попадает в ERP.
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
            </article>
          ))}
        </div>

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
