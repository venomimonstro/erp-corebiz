"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type ReturnRow = {
  id: string;
  business_number: string;
  sales_order_id: string;
  sales_order_number: string;
  status: string;
  reason: string | null;
  party_name: string | null;
  lines: number;
  requested_quantity_milli: string;
  received_quantity_milli: string;
  requested_at: string;
};

type Detail = {
  request: ReturnRow;
  lines: Array<{
    id: string;
    sales_order_line_id: string;
    sku_id: string | null;
    sku_code: string | null;
    description: string;
    requested_quantity_milli: string;
    authorized_quantity_milli: string;
    received_quantity_milli: string;
    disposition: string | null;
    warehouse_id: string | null;
    warehouse_name: string | null;
    inspection_note: string | null;
  }>;
};

function qty(value: string): string {
  return (Number(value) / 1000).toLocaleString("ru-RU", {
    maximumFractionDigits: 3
  });
}

export default function ReturnsPage() {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setRows(await apiRequest<ReturnRow[]>("/returns"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить возвраты");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    try {
      setSelected(await apiRequest<Detail>("/returns/" + id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть возврат");
    }
  }

  async function authorize(id: string) {
    try {
      await apiRequest("/returns/" + id + "/authorize", {
        method: "POST",
        body: JSON.stringify({})
      });
      await load();
      await open(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось авторизовать возврат");
    }
  }

  async function receive(line: Detail["lines"][number]) {
    if (!selected) return;

    const remaining =
      Number(line.authorized_quantity_milli) -
      Number(line.received_quantity_milli);

    const rawQty = window.prompt(
      "Количество к приёмке, шт.",
      String(remaining / 1000)
    );
    if (!rawQty) return;

    const disposition = (
      window.prompt(
        "Disposition: RESTOCK, QUARANTINE, DAMAGED, RETURN_TO_SUPPLIER, SCRAP, REJECT",
        "RESTOCK"
      ) ?? ""
    ).toUpperCase();

    if (
      !["RESTOCK","QUARANTINE","DAMAGED","RETURN_TO_SUPPLIER","SCRAP","REJECT"].includes(disposition)
    ) {
      setError("Неизвестный disposition");
      return;
    }

    let warehouseId: string | undefined;
    if (disposition === "RESTOCK") {
      warehouseId = window.prompt("UUID склада для возврата в остаток") ?? undefined;
      if (!warehouseId) return;
    }

    const quantity = Number(rawQty.replace(",", "."));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Некорректное количество");
      return;
    }

    try {
      await apiRequest(
        "/returns/" + selected.request.id + "/lines/" + line.id + "/receive",
        {
          method: "POST",
          body: JSON.stringify({
            quantityMilli: String(Math.round(quantity * 1000)),
            disposition,
            warehouseId,
            idempotencyKey: crypto.randomUUID()
          })
        }
      );
      await load();
      await open(selected.request.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось принять возврат");
    }
  }

  async function complete(id: string) {
    try {
      await apiRequest("/returns/" + id + "/complete", {
        method: "POST"
      });
      await load();
      await open(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось завершить возврат");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="returns" />
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Commerce / Reverse logistics</p>
            <h1>Возвраты</h1>
            <p className="workspace-summary">
              Возврат в доступный остаток выполняется только после приёмки и disposition=RESTOCK.
            </p>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Возвраты</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="oms-layout">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Возврат</th>
                  <th>Заказ</th>
                  <th>Клиент</th>
                  <th>Статус</th>
                  <th>Количество</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.business_number}</strong>
                      <small>{new Date(row.requested_at).toLocaleString("ru-RU")}</small>
                    </td>
                    <td>{row.sales_order_number}</td>
                    <td>{row.party_name ?? "—"}</td>
                    <td><span className="status-pill">{row.status}</span></td>
                    <td>
                      {qty(row.received_quantity_milli)} / {qty(row.requested_quantity_milli)}
                    </td>
                    <td className="table-actions">
                      <button
                        className="secondary-button"
                        onClick={() => void open(row.id)}
                        type="button"
                      >
                        Открыть
                      </button>
                      {row.status === "REQUESTED" ? (
                        <button onClick={() => void authorize(row.id)} type="button">
                          Авторизовать
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selected ? (
            <aside className="oms-panel">
              <header>
                <div>
                  <span>Возврат</span>
                  <strong>{selected.request.business_number}</strong>
                </div>
                <button
                  className="secondary-button"
                  onClick={() => setSelected(null)}
                  type="button"
                >
                  ×
                </button>
              </header>

              <div className="oms-panel-section">
                {selected.lines.map((line) => (
                  <article className="oms-allocation" key={line.id}>
                    <div>
                      <strong>{line.sku_code ?? line.description}</strong>
                      <span>
                        запрос {qty(line.requested_quantity_milli)} · разрешено{" "}
                        {qty(line.authorized_quantity_milli)} · принято{" "}
                        {qty(line.received_quantity_milli)}
                      </span>
                    </div>
                    <span className="status-pill">
                      {line.disposition ?? "WAITING"}
                    </span>
                    {Number(line.received_quantity_milli) <
                    Number(line.authorized_quantity_milli) ? (
                      <button onClick={() => void receive(line)} type="button">
                        Принять
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>

              {selected.request.status === "RECEIVED" ? (
                <button
                  onClick={() => void complete(selected.request.id)}
                  type="button"
                >
                  Завершить возврат
                </button>
              ) : null}
            </aside>
          ) : null}
        </div>
      </section>
    </main>
  );
}
