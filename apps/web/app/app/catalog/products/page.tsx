"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type ProductRow = {
  productId: string;
  productName: string;
  kind: "STOCKABLE" | "NON_STOCK";
  variantId: string;
  variantName: string;
  skuId: string;
  sku: string;
  barcode: string | null;
  salePriceMinor: string;
  costPriceMinor: string;
  currency: string;
  trackInventory: boolean;
};

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(Number(value) / 100);
}

export default function ProductsPage() {
  const [items, setItems] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      setItems(await apiRequest<ProductRow[]>("/catalog/products"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить товары");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") !== "1") return;

    params.delete("create");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (next ? "?" + next : "")
    );
    void quickCreate();
  }, []);

  async function quickCreate() {
    const name = window.prompt("Название товара");
    if (!name?.trim()) return;

    const sku = window.prompt("SKU — можно оставить пустым", "") ?? "";
    const saleRub = Number((window.prompt("Цена продажи, ₽", "0") ?? "0").replace(",", "."));
    const costRub = Number((window.prompt("Себестоимость, ₽", "0") ?? "0").replace(",", "."));

    if (
      !Number.isFinite(saleRub) ||
      saleRub < 0 ||
      !Number.isFinite(costRub) ||
      costRub < 0
    ) {
      setError("Некорректная цена");
      return;
    }

    try {
      await apiRequest("/catalog/products", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          sku: sku.trim() || undefined,
          salePriceMinor: String(Math.round(saleRub * 100)),
          costPriceMinor: String(Math.round(costRub * 100)),
          kind: "STOCKABLE"
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать товар");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="products" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Каталог / ERP Core</p>
            <h1>Товары</h1>
            <p className="workspace-summary">{items.length} SKU</p>
          </div>
          <button onClick={quickCreate} type="button">+ Товар</button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем каталог…</div> : null}

        {!loading ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Товар</th>
                  <th>SKU</th>
                  <th>Цена</th>
                  <th>Себестоимость</th>
                  <th>Маржа</th>
                  <th>Учёт остатка</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const margin =
                    Number(item.salePriceMinor) - Number(item.costPriceMinor);

                  return (
                    <tr key={item.skuId}>
                      <td>
                        <strong>{item.productName}</strong>
                        {item.variantName !== "Основной" ? (
                          <small>{item.variantName}</small>
                        ) : null}
                      </td>
                      <td>{item.sku}</td>
                      <td>{money(item.salePriceMinor, item.currency)}</td>
                      <td>{money(item.costPriceMinor, item.currency)}</td>
                      <td>{money(String(margin), item.currency)}</td>
                      <td>{item.trackInventory ? "Да" : "Нет"}</td>
                    </tr>
                  );
                })}

                {items.length === 0 ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="table-empty">
                        <strong>Каталог пуст</strong>
                        <span>Создайте первый товар или позже импортируйте Excel.</span>
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
