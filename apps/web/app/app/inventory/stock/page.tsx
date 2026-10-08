"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Warehouse = {
  id: string;
  name: string;
  code: string;
  isDefault: boolean;
  branchId: string | null;
};

type Balance = {
  warehouseId: string;
  warehouseName: string;
  skuId: string;
  sku: string;
  productName: string;
  physicalMilli: string;
  reservedMilli: string;
  availableMilli: string;
};

type StockCountLine = {
  id: string;
  skuId: string;
  sku: string;
  productName: string;
  expectedMilli: string;
  countedMilli: string | null;
};

function quantity(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 3
  }).format(Number(value) / 1000);
}

export default function StockPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [warehouseData, balanceData] = await Promise.all([
        apiRequest<Warehouse[]>("/inventory/warehouses"),
        apiRequest<Balance[]>("/inventory/balances")
      ]);

      setWarehouses(warehouseData);
      setBalances(balanceData);
      setSelectedWarehouse((current) =>
        current || warehouseData.find((item) => item.isDefault)?.id || warehouseData[0]?.id || ""
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить склад");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = useMemo(
    () =>
      selectedWarehouse
        ? balances.filter((item) => item.warehouseId === selectedWarehouse)
        : balances,
    [balances, selectedWarehouse]
  );

  async function createWarehouse() {
    const name = window.prompt("Название нового склада");
    if (!name?.trim()) return;

    try {
      await apiRequest("/inventory/warehouses", {
        method: "POST",
        body: JSON.stringify({ name: name.trim() })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать склад");
    }
  }

  async function adjust(item: Balance) {
    const raw = window.prompt(
      `${item.productName} · ${item.sku}\nВведите изменение остатка. Например 2 или -1:`,
      "0"
    );
    if (raw === null) return;

    const value = Number(raw.replace(",", "."));
    if (!Number.isFinite(value) || value === 0) return;

    const reason = window.prompt("Причина корректировки");
    if (!reason?.trim()) return;

    try {
      await apiRequest("/inventory/adjustments", {
        method: "POST",
        body: JSON.stringify({
          warehouseId: item.warehouseId,
          skuId: item.skuId,
          quantityDeltaMilli: String(Math.round(value * 1000)),
          reason: reason.trim(),
          idempotencyKey: crypto.randomUUID()
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось скорректировать остаток");
    }
  }

  async function transfer(item: Balance) {
    const destinations = warehouses.filter(
      (warehouse) => warehouse.id !== item.warehouseId
    );

    if (!destinations.length) {
      setError("Создайте второй склад для перемещения");
      return;
    }

    const text = destinations
      .map((warehouse, index) => `${index + 1}. ${warehouse.name}`)
      .join("\n");
    const index = Number(window.prompt(`Куда переместить?\n${text}`, "1")) - 1;
    const destination = destinations[index];
    if (!destination) return;

    const available = Number(item.availableMilli) / 1000;
    const raw = window.prompt(
      `Доступно: ${available}\nКоличество для перемещения:`,
      String(Math.min(1, available))
    );
    if (raw === null) return;

    const units = Number(raw.replace(",", "."));
    if (!Number.isFinite(units) || units <= 0 || units > available) {
      setError("Некорректное количество");
      return;
    }

    try {
      const result = await apiRequest<{ number: string }>(
        "/inventory/transfers",
        {
          method: "POST",
          body: JSON.stringify({
            fromWarehouseId: item.warehouseId,
            toWarehouseId: destination.id,
            idempotencyKey: crypto.randomUUID(),
            lines: [
              {
                skuId: item.skuId,
                quantityMilli: String(Math.round(units * 1000))
              }
            ]
          })
        }
      );
      window.alert(`Перемещение ${result.number} проведено`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось переместить товар");
    }
  }

  async function stockCount() {
    if (!selectedWarehouse) return;

    try {
      const count = await apiRequest<{
        stockCountId: string;
        number: string;
        lines: number;
      }>("/inventory/stock-counts", {
        method: "POST",
        body: JSON.stringify({ warehouseId: selectedWarehouse })
      });

      const lines = await apiRequest<StockCountLine[]>(
        `/inventory/stock-counts/${count.stockCountId}/lines`
      );

      for (const line of lines) {
        const expected = Number(line.expectedMilli) / 1000;
        const raw = window.prompt(
          `${line.productName} · ${line.sku}\nПо системе: ${expected}\nФактически:`,
          String(expected)
        );
        if (raw === null) return;

        const units = Number(raw.replace(",", "."));
        if (!Number.isFinite(units) || units < 0) {
          setError("Некорректное фактическое количество");
          return;
        }

        await apiRequest(
          `/inventory/stock-counts/${count.stockCountId}/lines/${line.id}`,
          {
            method: "PATCH",
            body: JSON.stringify({
              countedMilli: String(Math.round(units * 1000))
            })
          }
        );
      }

      const posted = await apiRequest<{ adjustments: number }>(
        `/inventory/stock-counts/${count.stockCountId}/post`,
        { method: "POST" }
      );

      window.alert(
        `Инвентаризация ${count.number} проведена. Корректировок: ${posted.adjustments}`
      );
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось провести инвентаризацию");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="stock" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Склад / Inventory Ledger</p>
            <h1>Остатки</h1>
            <p className="workspace-summary">
              Физический · резерв · доступно
            </p>
          </div>

          <div className="header-actions">
            <button className="secondary-button" onClick={createWarehouse} type="button">
              + Склад
            </button>
            <button onClick={() => void stockCount()} type="button">
              Инвентаризация
            </button>
          </div>
        </header>

        <div className="filter-row">
          {warehouses.map((warehouse) => (
            <button
              className={
                selectedWarehouse === warehouse.id
                  ? "filter-chip active"
                  : "filter-chip"
              }
              key={warehouse.id}
              onClick={() => setSelectedWarehouse(warehouse.id)}
              type="button"
            >
              {warehouse.name}
            </button>
          ))}
        </div>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем остатки…</div> : null}

        {!loading ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>SKU</th>
                  <th>Физически</th>
                  <th>Резерв</th>
                  <th>Доступно</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => (
                  <tr key={`${item.warehouseId}:${item.skuId}`}>
                    <td><strong>{item.productName}</strong></td>
                    <td>{item.sku}</td>
                    <td>{quantity(item.physicalMilli)}</td>
                    <td>{quantity(item.reservedMilli)}</td>
                    <td><strong>{quantity(item.availableMilli)}</strong></td>
                    <td className="table-actions">
                      <button
                        className="secondary-button"
                        onClick={() => void adjust(item)}
                        type="button"
                      >
                        Корректировать
                      </button>
                      <button onClick={() => void transfer(item)} type="button">
                        Переместить
                      </button>
                    </td>
                  </tr>
                ))}

                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="table-empty">
                        <strong>На складе пока нет остатков</strong>
                        <span>Проведите приёмку закупки или начальную корректировку.</span>
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
