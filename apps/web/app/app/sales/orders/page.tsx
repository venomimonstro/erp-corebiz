"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Order = {
  id: string;
  number: string;
  partyName: string | null;
  totalMinor: string;
  currency: string;
  orderStatus: "DRAFT" | "CONFIRMED" | "COMPLETED" | "CANCELLED";
  paymentStatus:
    | "UNPAID"
    | "PARTIALLY_PAID"
    | "PAID"
    | "PARTIALLY_REFUNDED"
    | "REFUNDED";
  fulfillmentStatus:
    | "UNALLOCATED"
    | "PARTIALLY_RESERVED"
    | "RESERVED"
    | "READY"
    | "PARTIALLY_SHIPPED"
    | "SHIPPED"
    | "CANCELLED";
  responsibleMembershipId: string | null;
  createdAt: string;
  version: number;
};

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(Number(value) / 100);
}

const orderLabels: Record<Order["orderStatus"], string> = {
  DRAFT: "Черновик",
  CONFIRMED: "Подтверждён",
  COMPLETED: "Завершён",
  CANCELLED: "Отменён"
};

const paymentLabels: Record<Order["paymentStatus"], string> = {
  UNPAID: "Не оплачен",
  PARTIALLY_PAID: "Частично оплачен",
  PAID: "Оплачен",
  PARTIALLY_REFUNDED: "Частичный возврат",
  REFUNDED: "Возвращён"
};

const fulfillmentLabels: Record<Order["fulfillmentStatus"], string> = {
  UNALLOCATED: "Не распределён",
  PARTIALLY_RESERVED: "Частично в резерве",
  RESERVED: "В резерве",
  READY: "Готов",
  PARTIALLY_SHIPPED: "Частично отгружен",
  SHIPPED: "Отгружен",
  CANCELLED: "Исполнение отменено"
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      setOrders(await apiRequest<Order[]>("/sales/orders"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить заказы");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmOrder(order: Order) {
    try {
      await apiRequest(`/sales/orders/${order.id}/confirm`, {
        method: "PATCH",
        body: JSON.stringify({ version: order.version })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подтвердить заказ");
      await load();
    }
  }

  async function reserveOrder(order: Order) {
    try {
      await apiRequest(`/sales/orders/${order.id}/reserve`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: `order:${order.id}:reserve:1`
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось зарезервировать заказ");
      await load();
    }
  }

  async function shipOrder(order: Order) {
    if (!window.confirm(`Отгрузить ${order.number}?`)) return;

    try {
      await apiRequest(`/sales/orders/${order.id}/ship`, {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: `order:${order.id}:ship:1`
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отгрузить заказ");
      await load();
    }
  }

  async function quickCreate() {
    const description = window.prompt("Что продаём?");
    if (!description?.trim()) return;

    const amountRub = Number(
      (window.prompt("Сумма заказа, ₽", "0") ?? "0").replace(",", ".")
    );

    if (!Number.isFinite(amountRub) || amountRub < 0) {
      setError("Некорректная сумма");
      return;
    }

    try {
      await apiRequest("/sales/orders", {
        method: "POST",
        body: JSON.stringify({
          idempotencyKey: crypto.randomUUID(),
          lines: [
            {
              description: description.trim(),
              quantityMilli: "1000",
              unitPriceMinor: String(Math.round(amountRub * 100))
            }
          ]
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать заказ");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="orders" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Продажи / ERP Core</p>
            <h1>Заказы</h1>
            <p className="workspace-summary">{orders.length} заказов</p>
          </div>
          <button onClick={quickCreate} type="button">+ Заказ</button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем заказы…</div> : null}

        {!loading ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Заказ</th>
                  <th>Клиент</th>
                  <th>Сумма</th>
                  <th>Заказ</th>
                  <th>Оплата</th>
                  <th>Исполнение</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td>
                      <strong>{order.number}</strong>
                      <small>
                        {new Date(order.createdAt).toLocaleString("ru-RU", {
                          day: "2-digit",
                          month: "short",
                          hour: "2-digit",
                          minute: "2-digit"
                        })}
                      </small>
                    </td>
                    <td>{order.partyName ?? "Без клиента"}</td>
                    <td>{money(order.totalMinor, order.currency)}</td>
                    <td>
                      <span className="status-pill">
                        {orderLabels[order.orderStatus]}
                      </span>
                    </td>
                    <td>
                      <span className="status-pill">
                        {paymentLabels[order.paymentStatus]}
                      </span>
                    </td>
                    <td>
                      <span className="status-pill">
                        {fulfillmentLabels[order.fulfillmentStatus]}
                      </span>
                    </td>
                    <td className="table-actions">
                      {order.orderStatus === "DRAFT" ? (
                        <button
                          onClick={() => void confirmOrder(order)}
                          type="button"
                        >
                          Подтвердить
                        </button>
                      ) : null}

                      {order.orderStatus === "CONFIRMED" &&
                      order.fulfillmentStatus === "UNALLOCATED" ? (
                        <button
                          onClick={() => void reserveOrder(order)}
                          type="button"
                        >
                          Зарезервировать
                        </button>
                      ) : null}

                      {order.orderStatus === "CONFIRMED" &&
                      ["RESERVED", "READY"].includes(order.fulfillmentStatus) ? (
                        <button
                          onClick={() => void shipOrder(order)}
                          type="button"
                        >
                          Отгрузить
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}

                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="table-empty">
                        <strong>Заказов пока нет</strong>
                        <span>
                          Создайте заказ напрямую или завершите сделку в CRM.
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </main>
  );
}
