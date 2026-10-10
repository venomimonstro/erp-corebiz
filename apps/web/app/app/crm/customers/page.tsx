"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Customer = {
  id: string;
  type: string;
  displayName: string;
  phone: string | null;
  email: string | null;
};

type CommercialTerms = {
  party_id: string;
  currency: string;
  credit_limit_minor: string | null;
  payment_term_days: number;
  default_discount_bps: number;
  allow_over_credit: boolean;
  notes: string | null;
};

type PartyPrice = {
  id: string;
  sku_id: string;
  sku_code: string;
  product_name: string;
  currency: string;
  min_quantity_milli: string;
  unit_price_minor: string;
  valid_from: string;
  valid_to: string | null;
  status: string;
};

type Product = {
  productId: string;
  productName: string;
  skuId: string;
  sku: string;
  salePriceMinor: string;
  currency: string;
};

function money(value: string | null, currency = "RUB"): string {
  if (value === null) return "Без лимита";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [terms, setTerms] = useState<CommercialTerms | null>(null);
  const [prices, setPrices] = useState<PartyPrice[]>([]);
  const [creditLimitRub, setCreditLimitRub] = useState("");
  const [paymentTermDays, setPaymentTermDays] = useState("0");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [allowOverCredit, setAllowOverCredit] = useState(false);
  const [notes, setNotes] = useState("");
  const [priceSkuId, setPriceSkuId] = useState("");
  const [priceRub, setPriceRub] = useState("");
  const [minQty, setMinQty] = useState("1");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const loadBase = useCallback(async () => {
    setError("");
    try {
      const [customerRows, productRows] = await Promise.all([
        apiRequest<Customer[]>("/crm/customers"),
        apiRequest<Product[]>("/catalog/products")
      ]);
      setCustomers(customerRows);
      setProducts(productRows);
      setSelectedId((current) =>
        customerRows.some((item) => item.id === current)
          ? current
          : customerRows[0]?.id ?? ""
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить клиентов");
    }
  }, []);

  const loadCommercial = useCallback(async (partyId: string) => {
    if (!partyId) {
      setTerms(null);
      setPrices([]);
      return;
    }

    try {
      const [termRow, priceRows] = await Promise.all([
        apiRequest<CommercialTerms | null>(
          "/sales/commercial/parties/" + encodeURIComponent(partyId) + "/terms"
        ),
        apiRequest<PartyPrice[]>(
          "/sales/commercial/parties/" + encodeURIComponent(partyId) + "/prices"
        )
      ]);

      setTerms(termRow);
      setPrices(priceRows);
      setCreditLimitRub(
        termRow?.credit_limit_minor === null || termRow?.credit_limit_minor === undefined
          ? ""
          : String(Number(termRow.credit_limit_minor) / 100)
      );
      setPaymentTermDays(String(termRow?.payment_term_days ?? 0));
      setDiscountPercent(String((termRow?.default_discount_bps ?? 0) / 100));
      setAllowOverCredit(Boolean(termRow?.allow_over_credit));
      setNotes(termRow?.notes ?? "");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить коммерческие условия"
      );
    }
  }, []);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  useEffect(() => {
    void loadCommercial(selectedId);
  }, [selectedId, loadCommercial]);

  const selected = customers.find((item) => item.id === selectedId) ?? null;

  async function createCustomer() {
    const name = window.prompt("Название компании или имя клиента");
    if (!name?.trim()) return;
    const isCompany = window.confirm("Это организация?");
    const phone = window.prompt("Телефон", "")?.trim() || undefined;
    const email = window.prompt("Email", "")?.trim() || undefined;

    try {
      const created = await apiRequest<{ id: string }>("/crm/customers", {
        method: "POST",
        body: JSON.stringify({
          type: isCompany ? "ORGANIZATION" : "PERSON",
          displayName: name.trim(),
          phone,
          email,
          idempotencyKey: crypto.randomUUID()
        })
      });
      await loadBase();
      setSelectedId(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать клиента");
    }
  }

  async function saveTerms() {
    if (!selectedId) return;

    const limit =
      creditLimitRub.trim() === ""
        ? null
        : Number(creditLimitRub.replace(",", "."));
    const days = Number(paymentTermDays);
    const discount = Number(discountPercent.replace(",", "."));

    if (
      (limit !== null && (!Number.isFinite(limit) || limit < 0)) ||
      !Number.isSafeInteger(days) ||
      days < 0 ||
      !Number.isFinite(discount) ||
      discount < 0 ||
      discount > 100
    ) {
      setError("Проверьте кредитный лимит, отсрочку и скидку");
      return;
    }

    setPending(true);
    try {
      await apiRequest(
        "/sales/commercial/parties/" + encodeURIComponent(selectedId) + "/terms",
        {
          method: "PATCH",
          body: JSON.stringify({
            currency: terms?.currency ?? "RUB",
            creditLimitMinor:
              limit === null ? null : String(Math.round(limit * 100)),
            paymentTermDays: days,
            defaultDiscountBps: Math.round(discount * 100),
            allowOverCredit,
            notes: notes.trim() || undefined
          })
        }
      );
      await loadCommercial(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить условия");
    } finally {
      setPending(false);
    }
  }

  async function addPrice() {
    if (!selectedId || !priceSkuId) {
      setError("Выберите клиента и товар");
      return;
    }

    const price = Number(priceRub.replace(",", "."));
    const qty = Number(minQty.replace(",", "."));
    if (!Number.isFinite(price) || price < 0 || !Number.isFinite(qty) || qty <= 0) {
      setError("Некорректная цена или минимальное количество");
      return;
    }

    setPending(true);
    try {
      await apiRequest(
        "/sales/commercial/parties/" + encodeURIComponent(selectedId) + "/prices",
        {
          method: "POST",
          body: JSON.stringify({
            skuId: priceSkuId,
            minQuantityMilli: String(Math.round(qty * 1000)),
            unitPriceMinor: String(Math.round(price * 100)),
            currency: "RUB"
          })
        }
      );
      setPriceRub("");
      setMinQty("1");
      await loadCommercial(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось добавить договорную цену");
    } finally {
      setPending(false);
    }
  }

  async function archivePrice(price: PartyPrice) {
    if (!window.confirm("Архивировать эту договорную цену?")) return;
    try {
      await apiRequest(
        "/sales/commercial/parties/" +
          encodeURIComponent(selectedId) +
          "/prices/" +
          encodeURIComponent(price.id) +
          "/archive",
        { method: "PATCH" }
      );
      await loadCommercial(selectedId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось архивировать цену");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="customers" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">CRM / Контрагенты</p>
            <h1>Клиенты</h1>
            <p className="workspace-summary">
              Контакты, отсрочка, кредитный лимит и индивидуальные цены B2B.
            </p>
          </div>
          <button onClick={() => void createCustomer()} type="button">+ Клиент</button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="settings-card">
          <div className="section-heading">
            <div>
              <p className="muted">Карточка клиента</p>
              <h2>{selected?.displayName ?? "Выберите клиента"}</h2>
            </div>
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
              <option value="">Выберите клиента</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.displayName}
                </option>
              ))}
            </select>
          </div>

          {selected ? (
            <div className="metric-grid">
              <article className="metric-card">
                <span>Тип</span>
                <strong>{selected.type === "ORGANIZATION" ? "Компания" : "Физлицо"}</strong>
                <small>{selected.phone ?? selected.email ?? "Нет контакта"}</small>
              </article>
              <article className="metric-card">
                <span>Кредитный лимит</span>
                <strong>{money(terms?.credit_limit_minor ?? null, terms?.currency ?? "RUB")}</strong>
                <small>{terms?.allow_over_credit ? "превышение разрешено" : "строгий контроль"}</small>
              </article>
              <article className="metric-card">
                <span>Отсрочка</span>
                <strong>{terms?.payment_term_days ?? 0} дней</strong>
                <small>для новых заказов</small>
              </article>
              <article className="metric-card">
                <span>Базовая скидка</span>
                <strong>{((terms?.default_discount_bps ?? 0) / 100).toLocaleString("ru-RU")}%</strong>
                <small>если нет индивидуальной цены SKU</small>
              </article>
            </div>
          ) : null}
        </div>

        {selected ? (
          <>
            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <p className="muted">B2B</p>
                  <h2>Коммерческие условия</h2>
                </div>
              </div>

              <div className="header-actions" style={{ flexWrap: "wrap" }}>
                <label>
                  Кредитный лимит, ₽{" "}
                  <input
                    inputMode="decimal"
                    placeholder="Без лимита"
                    value={creditLimitRub}
                    onChange={(event) => setCreditLimitRub(event.target.value)}
                  />
                </label>
                <label>
                  Отсрочка, дней{" "}
                  <input
                    inputMode="numeric"
                    value={paymentTermDays}
                    onChange={(event) => setPaymentTermDays(event.target.value)}
                  />
                </label>
                <label>
                  Скидка, %{" "}
                  <input
                    inputMode="decimal"
                    value={discountPercent}
                    onChange={(event) => setDiscountPercent(event.target.value)}
                  />
                </label>
                <label>
                  <input
                    checked={allowOverCredit}
                    onChange={(event) => setAllowOverCredit(event.target.checked)}
                    type="checkbox"
                  />{" "}
                  Разрешать превышение лимита
                </label>
                <input
                  placeholder="Комментарий"
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                />
                <button disabled={pending} onClick={() => void saveTerms()} type="button">
                  Сохранить
                </button>
              </div>
            </section>

            <section className="settings-card">
              <div className="section-heading">
                <div>
                  <p className="muted">Прайс клиента</p>
                  <h2>Индивидуальная цена SKU</h2>
                </div>
              </div>

              <div className="header-actions" style={{ flexWrap: "wrap" }}>
                <select value={priceSkuId} onChange={(event) => setPriceSkuId(event.target.value)}>
                  <option value="">Выберите товар</option>
                  {products.map((product) => (
                    <option key={product.skuId} value={product.skuId}>
                      {product.productName} · {product.sku} · {money(product.salePriceMinor, product.currency)}
                    </option>
                  ))}
                </select>
                <input
                  inputMode="decimal"
                  placeholder="Цена, ₽"
                  value={priceRub}
                  onChange={(event) => setPriceRub(event.target.value)}
                />
                <input
                  inputMode="decimal"
                  placeholder="Мин. количество"
                  value={minQty}
                  onChange={(event) => setMinQty(event.target.value)}
                />
                <button disabled={pending} onClick={() => void addPrice()} type="button">
                  + Цена
                </button>
              </div>
            </section>

            <section className="section-block">
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Товар</th>
                      <th>SKU</th>
                      <th>От количества</th>
                      <th>Цена</th>
                      <th>Действует</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {prices.filter((item) => item.status === "ACTIVE").map((price) => (
                      <tr key={price.id}>
                        <td><strong>{price.product_name}</strong></td>
                        <td>{price.sku_code}</td>
                        <td>{Number(price.min_quantity_milli) / 1000}</td>
                        <td>{money(price.unit_price_minor, price.currency)}</td>
                        <td>
                          {new Date(price.valid_from).toLocaleDateString("ru-RU")}
                          {price.valid_to
                            ? " — " + new Date(price.valid_to).toLocaleDateString("ru-RU")
                            : " — ∞"}
                        </td>
                        <td>
                          <button className="secondary-button" onClick={() => void archivePrice(price)} type="button">
                            Архив
                          </button>
                        </td>
                      </tr>
                    ))}
                    {!prices.some((item) => item.status === "ACTIVE") ? (
                      <tr>
                        <td colSpan={6}>
                          <div className="table-empty">
                            <strong>Индивидуальных цен нет</strong>
                            <span>Заказы используют базовый прайс и скидку клиента.</span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
