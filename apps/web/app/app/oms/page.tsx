"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type OmsOrder = {
  id: string;
  sales_order_id: string;
  state: string;
  allocation_version: number;
  last_sourcing_summary: Record<string, unknown>;
  last_error: string | null;
  updated_at: string;
  business_number: string;
  total_minor: string;
  currency: string;
  payment_status: string;
  fulfillment_status: string;
  party_name: string | null;
  allocation_count: number;
};

type Detail = {
  order: OmsOrder & {
    last_sourcing_summary: Record<string, unknown>;
  };
  lines: Array<{
    id: string;
    sku_id: string | null;
    sku_code: string | null;
    description: string;
    quantity_milli: string;
    track_inventory: boolean | null;
  }>;
  allocations: Array<{
    id: string;
    sales_order_line_id: string;
    sku_id: string;
    warehouse_id: string;
    warehouse_name: string;
    quantity_milli: string;
    state: string;
    explanation: {
      atpBeforeMilli?: string;
      safetyStockMilli?: string;
      sourcingPriority?: number;
      reason?: string;
    };
  }>;
};

type Atp = {
  warehouse_id: string;
  warehouse_name: string;
  is_default: boolean;
  sku_id: string;
  sku_code: string;
  physical_milli: string;
  reserved_milli: string;
  safety_stock_milli: string;
  sourcing_priority: number;
  atp_milli: string;
};

function qty(value: string): string {
  return (Number(value) / 1000).toLocaleString("ru-RU", {
    maximumFractionDigits: 3
  });
}

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function OmsPage() {
  const [orders, setOrders] = useState<OmsOrder[]>([]);
  const [selected, setSelected] = useState<Detail | null>(null);
  const [atp, setAtp] = useState<Atp[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [orderRows, atpRows] = await Promise.all([
        apiRequest<OmsOrder[]>("/oms/orders"),
        apiRequest<Atp[]>("/oms/atp")
      ]);
      setOrders(orderRows);
      setAtp(atpRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить OMS");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(id: string) {
    try {
      setSelected(await apiRequest<Detail>("/oms/orders/" + id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть OMS-заказ");
    }
  }

  async function allocate(id: string) {
    setBusy(id);
    setError("");
    try {
      await apiRequest("/oms/orders/" + id + "/allocate", {
        method: "POST"
      });
      await load();
      await open(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Allocation не выполнен");
      await load();
      await open(id);
    } finally {
      setBusy("");
    }
  }

  async function changePolicy(row: Atp) {
    const safetyRaw = window.prompt(
      "Страховой остаток, шт.",
      qty(row.safety_stock_milli)
    );
    if (safetyRaw === null) return;

    const priorityRaw = window.prompt(
      "Приоритет sourcing: меньше = раньше",
      String(row.sourcing_priority)
    );
    if (priorityRaw === null) return;

    const safety = Number(safetyRaw.replace(",", "."));
    const priority = Number(priorityRaw);

    if (!Number.isFinite(safety) || safety < 0 || !Number.isFinite(priority)) {
      setError("Некорректные параметры политики");
      return;
    }

    try {
      await apiRequest("/oms/policies", {
        method: "POST",
        body: JSON.stringify({
          warehouseId: row.warehouse_id,
          skuId: row.sku_id,
          safetyStockMilli: String(Math.round(safety * 1000)),
          sourcingPriority: Math.round(priority)
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить политику");
    }
  }

  const problemCount = useMemo(
    () =>
      orders.filter((order) =>
        ["ALLOCATION_FAILED", "READY_FOR_ALLOCATION"].includes(order.state)
      ).length,
    [orders]
  );

  return (
    <main className="app-shell">
      <AppSidebar active="oms" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Commerce / OMS</p>
            <h1>Распределение заказов</h1>
            <p className="workspace-summary">
              ATP учитывает физический остаток, активные резервы и страховой запас.
            </p>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>OMS</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="owner-kpi-grid">
          <article className="owner-kpi">
            <span>OMS-заказы</span>
            <strong>{orders.length}</strong>
            <small>Подтверждённые SalesOrder</small>
          </article>
          <article className="owner-kpi">
            <span>Требуют действия</span>
            <strong>{problemCount}</strong>
            <small>Не распределены или allocation failed</small>
          </article>
          <article className="owner-kpi">
            <span>Распределено</span>
            <strong>{orders.filter((x) => x.state === "ALLOCATED").length}</strong>
            <small>Резервы созданы в Inventory</small>
          </article>
          <article className="owner-kpi">
            <span>ATP строк</span>
            <strong>{atp.length}</strong>
            <small>SKU × активный склад</small>
          </article>
        </div>

        <div className="oms-layout">
          <section className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Клиент</th>
                  <th>OMS</th>
                  <th>Fulfillment</th>
                  <th>Сумма</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.business_number}</strong>
                      <small>
                        allocation v{order.allocation_version} · {order.allocation_count} резервов
                      </small>
                    </td>
                    <td>{order.party_name ?? "Без клиента"}</td>
                    <td>
                      <span className="status-pill">{order.state}</span>
                      {order.last_error ? <small>{order.last_error}</small> : null}
                    </td>
                    <td>{order.fulfillment_status}</td>
                    <td>{money(order.total_minor, order.currency)}</td>
                    <td className="table-actions">
                      <button
                        className="secondary-button"
                        onClick={() => void open(order.id)}
                        type="button"
                      >
                        Открыть
                      </button>
                      {["READY_FOR_ALLOCATION", "ALLOCATION_FAILED"].includes(order.state) ? (
                        <button
                          disabled={busy === order.id}
                          onClick={() => void allocate(order.id)}
                          type="button"
                        >
                          {busy === order.id ? "Распределяем…" : "Распределить"}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {selected ? (
            <aside className="oms-panel">
              <header>
                <div>
                  <span>OMS-заказ</span>
                  <strong>{selected.order.business_number}</strong>
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
                <small>Строки заказа</small>
                {selected.lines.map((line) => (
                  <article key={line.id} className="oms-line">
                    <div>
                      <strong>{line.sku_code ?? line.description}</strong>
                      <span>{line.description}</span>
                    </div>
                    <b>{qty(line.quantity_milli)}</b>
                  </article>
                ))}
              </div>

              <div className="oms-panel-section">
                <small>Решение sourcing</small>
                {selected.allocations.map((allocation) => (
                  <article key={allocation.id} className="oms-allocation">
                    <div>
                      <strong>{allocation.warehouse_name}</strong>
                      <span>
                        {qty(allocation.quantity_milli)} · priority{" "}
                        {allocation.explanation.sourcingPriority ?? "—"}
                      </span>
                    </div>
                    <span className="status-pill">{allocation.state}</span>
                    <p>{allocation.explanation.reason ?? "ATP allocation"}</p>
                  </article>
                ))}

                {!selected.allocations.length ? (
                  <div className="table-empty">
                    <strong>Резервов нет</strong>
                    <span>Запустите allocation.</span>
                  </div>
                ) : null}
              </div>
            </aside>
          ) : null}
        </div>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Available to Promise</p>
              <h2>ATP и safety stock</h2>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Склад</th>
                  <th>Физически</th>
                  <th>Резерв</th>
                  <th>Safety</th>
                  <th>ATP</th>
                  <th>Priority</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {atp.map((row) => (
                  <tr key={row.sku_id + ":" + row.warehouse_id}>
                    <td><strong>{row.sku_code}</strong></td>
                    <td>
                      {row.warehouse_name}
                      {row.is_default ? <small>основной</small> : null}
                    </td>
                    <td>{qty(row.physical_milli)}</td>
                    <td>{qty(row.reserved_milli)}</td>
                    <td>{qty(row.safety_stock_milli)}</td>
                    <td><strong>{qty(row.atp_milli)}</strong></td>
                    <td>{row.sourcing_priority}</td>
                    <td className="table-actions">
                      <button
                        className="secondary-button"
                        onClick={() => void changePolicy(row)}
                        type="button"
                      >
                        Политика
                      </button>
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
