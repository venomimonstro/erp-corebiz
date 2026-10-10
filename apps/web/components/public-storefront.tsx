"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

type Product = {
  product_id: string;
  product_name: string;
  description: string | null;
  sku_id: string;
  sku_code: string;
  sale_price_minor: string;
  currency: string;
  atp_milli: string;
};

type Catalog = {
  siteId: string;
  currency: string;
  products: Product[];
};

type CartLine = {
  sku_id: string;
  sku_code: string;
  product_name: string;
  quantity_milli: string;
  sale_price_minor: string;
  currency: string;
  line_total_minor: string;
};

type Cart = {
  cartKey: string;
  status: string;
  lines: CartLine[];
  totalMinor: string;
};

// A tenant custom domain must use the same-origin API proxy.
const API_URL = "/api/v1";

async function request<T>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(API_URL + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) throw new Error(payload.error.message);
  return payload.data;
}

export function PublicStorefront({
  publicSlug,
  heading,
  limit = 12
}: {
  publicSlug: string;
  heading?: string;
  limit?: number;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [success, setSuccess] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");

  const storageKey = "corebiz_cart_" + publicSlug;

  const ensureCart = useCallback(async (): Promise<Cart> => {
    const existing =
      typeof window !== "undefined"
        ? window.localStorage.getItem(storageKey)
        : null;

    if (existing) {
      try {
        const current = await request<Cart>(
          "/storefront/carts/" + encodeURIComponent(existing)
        );
        if (current.status === "OPEN") {
          setCart(current);
          return current;
        }
      } catch {
        window.localStorage.removeItem(storageKey);
      }
    }

    const created = await request<{ cartKey: string }>(
      "/storefront/" + encodeURIComponent(publicSlug) + "/carts",
      { method: "POST" }
    );
    window.localStorage.setItem(storageKey, created.cartKey);

    const fresh = await request<Cart>(
      "/storefront/carts/" + encodeURIComponent(created.cartKey)
    );
    setCart(fresh);
    return fresh;
  }, [publicSlug, storageKey]);

  useEffect(() => {
    void Promise.all([
      request<Catalog>(
        "/storefront/" + encodeURIComponent(publicSlug) + "/catalog"
      ).then(setCatalog),
      ensureCart()
    ]).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Магазин временно недоступен");
    });
  }, [publicSlug, ensureCart]);

  async function changeQuantity(
    skuId: string,
    quantityMilli: number
  ) {
    const current = cart ?? (await ensureCart());
    setBusy(skuId);
    setError("");

    try {
      const next = await request<Cart>(
        "/storefront/carts/" +
          encodeURIComponent(current.cartKey) +
          "/lines",
        {
          method: "PUT",
          body: JSON.stringify({
            skuId,
            quantityMilli: String(Math.max(0, quantityMilli))
          })
        }
      );
      setCart(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить корзину");
    } finally {
      setBusy("");
    }
  }

  async function checkout() {
    if (!cart || !name.trim()) return;

    setBusy("checkout");
    setError("");

    try {
      const result = await request<{
        accepted: boolean;
        number?: string;
        salesOrderId: string;
        fulfillmentStatus?: string;
        allocationState?: string;
        backorderMilli?: string;
      }>(
        "/storefront/carts/" +
          encodeURIComponent(cart.cartKey) +
          "/checkout",
        {
          method: "POST",
          body: JSON.stringify({
            idempotencyKey: crypto.randomUUID(),
            name: name.trim(),
            phone: phone.trim() || undefined,
            email: email.trim() || undefined
          })
        }
      );

      const prefix = result.number
        ? "Заказ " + result.number + " принят."
        : "Заказ принят.";

      const backorder = BigInt(result.backorderMilli ?? "0");
      if (
        result.allocationState === "BACKORDER" ||
        result.allocationState === "PARTIALLY_ALLOCATED" ||
        backorder > 0n
      ) {
        setSuccess(
          prefix +
            " Часть позиции сейчас не зарезервирована на складе. Компания увидит заказ как ожидающий поступления и свяжется с вами по срокам."
        );
      } else {
        setSuccess(
          prefix +
            (result.fulfillmentStatus === "RESERVED"
              ? " Товар зарезервирован."
              : "")
        );
      }
      setCheckoutOpen(false);
      window.localStorage.removeItem(storageKey);
      setCart(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось оформить заказ");
    } finally {
      setBusy("");
    }
  }

  const visible = useMemo(
    () => catalog?.products.slice(0, Math.max(1, Math.min(100, limit))) ?? [],
    [catalog, limit]
  );

  function rub(value: string, currency = "RUB") {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }

  return (
    <section className="public-block public-storefront">
      <div className="public-storefront-heading">
        <div>
          <h2>{heading || "Товары"}</h2>
          <p>Актуальные цены и наличие из системы компании.</p>
        </div>
        <button
          className="public-cart-button"
          onClick={() => setCheckoutOpen((value) => !value)}
          type="button"
        >
          Корзина · {cart?.lines.length ?? 0}
        </button>
      </div>

      {error ? <div className="public-store-error">{error}</div> : null}
      {success ? <div className="public-store-success">{success}</div> : null}

      <div className="public-product-grid">
        {visible.map((product) => {
          const inCart = cart?.lines.find(
            (line) => line.sku_id === product.sku_id
          );
          const quantity = Number(inCart?.quantity_milli ?? "0");

          return (
            <article key={product.sku_id} className="public-product-card">
              <div>
                <span className="public-product-stock">
                  {Number(product.atp_milli) > 0 ? "В наличии" : "Под заказ"}
                </span>
                <h3>{product.product_name}</h3>
                {product.description ? <p>{product.description}</p> : null}
              </div>

              <div className="public-product-buy">
                <strong>
                  {rub(product.sale_price_minor, product.currency)}
                </strong>

                {quantity > 0 ? (
                  <div className="public-quantity">
                    <button
                      type="button"
                      disabled={busy === product.sku_id}
                      onClick={() =>
                        void changeQuantity(
                          product.sku_id,
                          Math.max(0, quantity - 1000)
                        )
                      }
                    >
                      −
                    </button>
                    <span>{quantity / 1000}</span>
                    <button
                      type="button"
                      disabled={busy === product.sku_id}
                      onClick={() =>
                        void changeQuantity(product.sku_id, quantity + 1000)
                      }
                    >
                      +
                    </button>
                  </div>
                ) : (
                  <button
                    className="public-primary-button"
                    type="button"
                    disabled={busy === product.sku_id}
                    onClick={() =>
                      void changeQuantity(product.sku_id, 1000)
                    }
                  >
                    В корзину
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {checkoutOpen && cart ? (
        <div className="public-checkout">
          <div className="public-checkout-head">
            <div>
              <strong>Оформление заказа</strong>
              <span>{rub(cart.totalMinor)}</span>
            </div>
            <button type="button" onClick={() => setCheckoutOpen(false)}>
              ×
            </button>
          </div>

          <div className="public-cart-lines">
            {cart.lines.map((line) => (
              <div key={line.sku_id}>
                <span>
                  {line.product_name} · {Number(line.quantity_milli) / 1000}
                </span>
                <strong>{rub(line.line_total_minor, line.currency)}</strong>
              </div>
            ))}
          </div>

          <label>
            <span>Имя *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            <span>Телефон</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label>
            <span>Email</span>
            <input value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>

          <button
            className="public-primary-button"
            disabled={busy === "checkout" || !name.trim() || !cart.lines.length}
            onClick={() => void checkout()}
            type="button"
          >
            {busy === "checkout" ? "Оформляем…" : "Оформить заказ"}
          </button>
        </div>
      ) : null}
    </section>
  );
}
