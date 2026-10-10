"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Supplier = {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
};

type Product = {
  skuId: string;
  productName: string;
  sku: string;
  costPriceMinor: string;
  currency: string;
};

type PurchaseOrder = {
  id: string;
  number: string;
  supplierName: string;
  status: "DRAFT" | "CONFIRMED" | "PARTIALLY_RECEIVED" | "RECEIVED" | "CANCELLED";
  totalMinor: string;
  currency: string;
  expectedAt: string | null;
  version: number;
};

type PurchaseLine = {
  id: string;
  skuId: string;
  sku: string;
  productName: string;
  orderedQuantityMilli: string;
  receivedQuantityMilli: string;
  remainingQuantityMilli: string;
  unitCostMinor: string;
};

function money(value: string, currency = "RUB"): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(Number(value) / 100);
}

const statusLabels: Record<PurchaseOrder["status"], string> = {
  DRAFT: "Черновик",
  CONFIRMED: "Ожидаем",
  PARTIALLY_RECEIVED: "Частично получено",
  RECEIVED: "Получено",
  CANCELLED: "Отменено"
};

export default function PurchasesPage() {
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [orderData, supplierData, productData] = await Promise.all([
        apiRequest<PurchaseOrder[]>("/procurement/orders"),
        apiRequest<Supplier[]>("/procurement/suppliers"),
        apiRequest<Product[]>("/catalog/products")
      ]);

      setOrders(orderData);
      setSuppliers(supplierData);
      setProducts(productData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить закупки");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (loading) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") !== "1") return;

    params.delete("create");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (next ? "?" + next : "")
    );
    void createPurchase();
  }, [loading]);

  async function createSupplier() {
    const name = window.prompt("Название поставщика");
    if (!name?.trim()) return;

    try {
      await apiRequest("/procurement/suppliers", {
        method: "POST",
        body: JSON.stringify({ displayName: name.trim() })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать поставщика");
    }
  }

  async function createPurchase() {
    if (!suppliers.length) {
      setError("Сначала создайте поставщика");
      return;
    }

    if (!products.length) {
      setError("Сначала создайте товар");
      return;
    }

    const supplierText = suppliers
      .map((supplier, index) => `${index + 1}. ${supplier.displayName}`)
      .join("\n");
    const supplierIndex = Number(
      window.prompt(`Выберите поставщика:\n${supplierText}`, "1")
    ) - 1;
    const supplier = suppliers[supplierIndex];
    if (!supplier) return;

    const productText = products
      .slice(0, 30)
      .map((product, index) => `${index + 1}. ${product.productName} · ${product.sku}`)
      .join("\n");
    const productIndex = Number(
      window.prompt(`Выберите товар:\n${productText}`, "1")
    ) - 1;
    const product = products[productIndex];
    if (!product) return;

    const quantity = Number(
      (window.prompt("Количество", "1") ?? "1").replace(",", ".")
    );
    const unitCostRub = Number(
      (window.prompt(
        "Закупочная цена за единицу, ₽",
        String(Number(product.costPriceMinor) / 100)
      ) ?? "0").replace(",", ".")
    );

    if (
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      !Number.isFinite(unitCostRub) ||
      unitCostRub < 0
    ) {
      setError("Некорректное количество или цена");
      return;
    }

    try {
      await apiRequest("/procurement/orders", {
        method: "POST",
        body: JSON.stringify({
          supplierPartyId: supplier.id,
          lines: [
            {
              skuId: product.skuId,
              quantityMilli: String(Math.round(quantity * 1000)),
              unitCostMinor: String(Math.round(unitCostRub * 100))
            }
          ]
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать закупку");
    }
  }

  async function confirm(order: PurchaseOrder) {
    try {
      await apiRequest(`/procurement/orders/${order.id}/confirm`, {
        method: "PATCH",
        body: JSON.stringify({ version: order.version })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подтвердить закупку");
      await load();
    }
  }

  async function receive(order: PurchaseOrder) {
    try {
      const lines = await apiRequest<PurchaseLine[]>(
        `/procurement/orders/${order.id}/lines`
      );
      const remaining = lines.filter(
        (line) => BigInt(line.remainingQuantityMilli) > 0n
      );

      if (!remaining.length) {
        setError("По закупке нечего принимать");
        return;
      }

      const payload: Array<{
        purchaseOrderLineId: string;
        quantityMilli: string;
      }> = [];

      for (const line of remaining) {
        const remainingUnits = Number(line.remainingQuantityMilli) / 1000;
        const raw = window.prompt(
          `${line.productName} · ${line.sku}\nОсталось получить: ${remainingUnits}\nПолучено сейчас:`,
          String(remainingUnits)
        );

        if (raw === null) return;

        const units = Number(raw.replace(",", "."));
        if (!Number.isFinite(units) || units < 0 || units > remainingUnits) {
          setError("Некорректное количество приёмки");
          return;
        }

        if (units > 0) {
          payload.push({
            purchaseOrderLineId: line.id,
            quantityMilli: String(Math.round(units * 1000))
          });
        }
      }

      if (!payload.length) return;

      const receipt = await apiRequest<{ number: string }>(
        `/procurement/orders/${order.id}/receipts`,
        {
          method: "POST",
          body: JSON.stringify({ lines: payload })
        }
      );

      window.alert(`Приёмка ${receipt.number} проведена. Остатки обновлены.`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось провести приёмку");
      await load();
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="purchases" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Закупки / Снабжение</p>
            <h1>Закупки</h1>
            <p className="workspace-summary">
              {orders.length} заказов · {suppliers.length} поставщиков
            </p>
          </div>

          <div className="header-actions">
            <button className="secondary-button" onClick={createSupplier} type="button">
              + Поставщик
            </button>
            <button onClick={createPurchase} type="button">+ Закупка</button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем закупки…</div> : null}

        {!loading ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Закупка</th>
                  <th>Поставщик</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Ожидаем</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {orders.map((order) => (
                  <tr key={order.id}>
                    <td><strong>{order.number}</strong></td>
                    <td>{order.supplierName}</td>
                    <td>{money(order.totalMinor, order.currency)}</td>
                    <td>
                      <span className="status-pill">{statusLabels[order.status]}</span>
                    </td>
                    <td>
                      {order.expectedAt
                        ? new Date(order.expectedAt).toLocaleDateString("ru-RU")
                        : "—"}
                    </td>
                    <td className="table-actions">
                      {order.status === "DRAFT" ? (
                        <button onClick={() => void confirm(order)} type="button">
                          Подтвердить
                        </button>
                      ) : null}

                      {["CONFIRMED", "PARTIALLY_RECEIVED"].includes(order.status) ? (
                        <button onClick={() => void receive(order)} type="button">
                          Принять
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}

                {orders.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="table-empty">
                        <strong>Закупок пока нет</strong>
                        <span>Создайте поставщика и первый заказ поставщику.</span>
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
