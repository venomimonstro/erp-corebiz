"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

type Product = {
  product_id: string;
  product_name: string;
  description: string | null;
  image_url: string | null;
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
  nextCursor: string | null;
};

type CartLine = {
  sku_id: string;
  sku_code: string;
  product_name: string;
  quantity_milli: string;
  sale_price_minor: string;
  currency: string;
  line_total_minor: string;
  is_available: boolean;
};

type Cart = {
  cartKey: string;
  status: string;
  lines: CartLine[];
  totalMinor: string;
};
type DeliveryMethod = {
  id:string; code:string; title:string;
  mode:"PICKUP"|"LOCAL_COURIER"; fee_minor:string;
  description:string|null;
};
type DeliveryCatalog = {methods:DeliveryMethod[];currency:string};
type PaymentStart = {intentId:string;status:string;confirmationUrl?:string};


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
  const [search, setSearch] = useState("");
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [delivery, setDelivery] = useState<DeliveryMethod[]>([]);
  const [deliveryLoading,setDeliveryLoading]=useState(true);
  const [deliveryFailed,setDeliveryFailed]=useState(false);
  const [deliveryMethodId, setDeliveryMethodId] = useState("");
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [paymentCartKey, setPaymentCartKey] = useState("");
  const [paymentStatus, setPaymentStatus] = useState("NOT_STARTED");


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
        if (current.status === "PROCESSING") {
          // Do not replace an in-flight checkout with a fresh cart after a
          // network timeout; the backend will reconcile the original order.
          setCart(current);
          setError("Заказ уже оформляется. Не отправляйте его повторно. Обновите страницу через некоторое время.");
          return current;
        }
        if (current.status === "CHECKED_OUT") {
          setSuccess("Заказ принят. Оплачивайте только после подтверждения суммы и доставки.");
          setCart(current);
          setPaymentCartKey(current.cartKey);
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
    void ensureCart().catch((cause) => {
      setError(cause instanceof Error ? cause.message : "Корзина временно недоступна");
    });
  }, [ensureCart]);

  useEffect(() => {
    let active=true;
    setDeliveryLoading(true);
    setDeliveryFailed(false);
    setDelivery([]);
    setDeliveryMethodId("");
    void request<DeliveryCatalog>(
      "/payments/storefront/" + encodeURIComponent(publicSlug) + "/delivery"
    ).then(result=>{
      if(!active)return;
      setDelivery(result.methods);
      if(result.methods.length===1)setDeliveryMethodId(result.methods[0]!.id);
    }).catch(()=>{
      if(active){setDelivery([]);setDeliveryFailed(true);}
    }).finally(()=>{
      if(active)setDeliveryLoading(false);
    });
    return ()=>{active=false;};
  },[publicSlug]);

  useEffect(()=>{
    const key=paymentCartKey || (cart?.status==="CHECKED_OUT"?cart.cartKey:"");
    if(!key)return;
    void request<{status:string;fiscalStatus?:string}>(
      "/payments/storefront/carts/"+encodeURIComponent(key)+"/status"
    ).then(state=>{
      setPaymentStatus(state.status);
      if(state.status==="SUCCEEDED"){
        setSuccess("Оплата подтверждена платёжным провайдером. Спасибо за заказ.");
        setCheckoutOpen(false);
      }
    }).catch(()=>setError("Не удалось проверить статус оплаты. Проверьте позже."));
  },[paymentCartKey,cart?.cartKey,cart?.status]);

  const pageSize = Math.max(1, Math.min(100, Math.floor(limit) || 12));
  useEffect(() => {
    let active = true;
    const needle = search.trim();
    if (needle.length === 1) {
      setCatalog(null);
      setLoadingCatalog(false);
      return;
    }
    setLoadingCatalog(true);
    setCatalog(null);
    const handle = setTimeout(() => {
      const params = new URLSearchParams({ limit: String(pageSize) });
      if (needle) params.set("q", needle);
      void request<Catalog>(
        "/storefront/" + encodeURIComponent(publicSlug) + "/catalog?" + params.toString()
      ).then((result) => {
        if (active) { setCatalog(result); setError(""); }
      }).catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Не удалось загрузить каталог");
      }).finally(() => { if (active) setLoadingCatalog(false); });
    }, 250);
    return () => { active = false; clearTimeout(handle); };
  }, [publicSlug, pageSize, search]);

  async function loadMore() {
    if (!catalog?.nextCursor || busy) return;
    setBusy("catalog");
    try {
      const params = new URLSearchParams({
        limit: String(pageSize), cursor: catalog.nextCursor
      });
      if (search.trim()) params.set("q", search.trim());
      const page = await request<Catalog>(
        "/storefront/" + encodeURIComponent(publicSlug) + "/catalog?" + params.toString()
      );
      setCatalog((current) => current?.nextCursor === catalog.nextCursor
        ? { ...current, products: [...current.products, ...page.products],
          nextCursor: page.nextCursor }
        : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить товары");
    } finally {
      setBusy("");
    }
  }

  async function changeQuantity(
    skuId: string,
    quantityMilli: number
  ) {
    const current = cart ?? (await ensureCart());
    if (current.status !== "OPEN") {
      setError("Заказ уже оформляется. Дождитесь подтверждения его состояния.");
      return;
    }
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
    if (!cart || cart.status !== "OPEN" || !name.trim()) return;

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
            email: email.trim() || undefined,
            deliveryMethodId: deliveryMethodId || undefined,
            deliveryAddress: deliveryAddress.trim() || undefined
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
      setPaymentCartKey(cart.cartKey);
      // Retain the opaque cart key until provider payment is confirmed.
      // The seller may still accept manual offline payment for this order.
      const updated=await request<Cart>(
        "/storefront/carts/"+encodeURIComponent(cart.cartKey)
      );
      setCart(updated);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось оформить заказ");
    } finally {
      setBusy("");
    }
  }

  async function payOnline(){
    const key=paymentCartKey || cart?.cartKey;
    if(!key)return;
    setBusy("payment");
    setError("");
    try{
      const response=await request<PaymentStart>(
        "/payments/storefront/carts/" + encodeURIComponent(key) + "/start",
        {method:"POST"}
      );
      if(response.status==="SUCCEEDED"){
        setSuccess("Заказ уже оплачен. Проверьте уведомление продавца.");
        return;
      }
      if(!response.confirmationUrl)throw new Error("Ссылка на оплату не получена");
      // Only provider-hosted forms: CoreBiz must never process card details.
      const url=new URL(response.confirmationUrl);
      if(url.protocol!=="https:" ||
         !["yookassa.ru","yoomoney.ru"].some(host=>
           url.hostname===host||url.hostname.endsWith("."+host))) {
        throw new Error("Некорректный адрес платёжной формы");
      }
      window.location.assign(url.href);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Оплата недоступна");
    }finally{setBusy("");}
  }

  const visible = useMemo(() => catalog?.products ?? [], [catalog]);

  function rub(value: string, currency = "RUB") {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency,
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }

  return (
    <section id="products" className="public-block public-storefront">
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

      <label className="public-store-search">
        <span>Поиск по каталогу</span>
        <input aria-label="Поиск по названию или артикулу"
          value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="Название или артикул (от 2 символов)" />
      </label>
      {error ? <div className="public-store-error" role="alert">{error}</div> : null}
      {success ? <div className="public-store-success" role="status">{success}</div> : null}
      {loadingCatalog ? <p>Загружаем товары…</p> : null}
      {search.trim().length === 1 ? <p>Введите ещё один символ для поиска.</p> : null}

      <div className="public-product-grid">
        {visible.map((product) => {
          const inCart = cart?.lines.find(
            (line) => line.sku_id === product.sku_id
          );
          const quantity = Number(inCart?.quantity_milli ?? "0");

          return (
            <article key={product.sku_id} className="public-product-card">
              {product.image_url ? (
                <div className="public-product-image-wrap">
                  <img loading="lazy" decoding="async" src={product.image_url}
                    alt={product.product_name} className="public-product-image" />
                </div>
              ) : (
                <div className="public-product-image-wrap public-product-image-empty"
                  aria-hidden="true">Фото товара</div>
              )}
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

      {!loadingCatalog && catalog && !visible.length ? <p>По вашему запросу товары не найдены.</p> : null}
      {catalog?.nextCursor ? (
        <button className="public-cart-button" type="button"
          disabled={busy === "catalog"} onClick={() => void loadMore()}>
          {busy === "catalog" ? "Загружаем…" : "Показать ещё товары"}
        </button>
      ) : null}

      {paymentCartKey || cart?.status==="CHECKED_OUT" ? (
        <div className="public-checkout">
          <strong>{paymentStatus==="SUCCEEDED"?"Заказ оплачен":
            "Заказ оформлен · ожидает оплаты"}</strong>
          <p>Оплата не подтверждается возвращением на сайт.
            Статус обновляется только после проверки платёжного провайдера.</p>
          <button type="button" className="public-primary-button"
            disabled={Boolean(busy)||paymentStatus==="SUCCEEDED"}
            onClick={()=>void payOnline()}>
            {busy==="payment"?"Подключаем оплату…":"Оплатить через YooKassa"}
          </button>
        </div>
      ) : null}
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
                {!line.is_available ? <small role="alert">Больше не продаётся</small> : null}
                <button type="button" className="public-cart-remove"
                  disabled={Boolean(busy)}
                  onClick={() => void changeQuantity(line.sku_id, 0)}>
                  Удалить
                </button>
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

          {deliveryLoading?<p className="public-order-notice" role="status">
            Загружаем способы получения заказа…
          </p>:deliveryFailed?<p className="public-order-notice" role="alert">
            Не удалось получить способы доставки. Обновите страницу перед оформлением.
          </p>:delivery.length===0?<p className="public-order-notice" role="alert">
            Магазин пока не настроил доставку или самовывоз. Оформление заказа временно недоступно.
          </p>:null}
          <label>
            <span>Получение заказа</span>
            <select value={deliveryMethodId}
              onChange={event=>setDeliveryMethodId(event.target.value)}>
              <option value="">Выберите способ получения</option>
              {delivery.map(item=>(
                <option value={item.id} key={item.id}>
                  {item.title} · {item.fee_minor==="0"?"Бесплатно":rub(item.fee_minor)}
                </option>
              ))}
            </select>
          </label>
          {delivery.find(d=>d.id===deliveryMethodId)?.mode==="LOCAL_COURIER" ? (
            <label>
              <span>Адрес доставки *</span>
              <textarea rows={2} value={deliveryAddress}
                onChange={event=>setDeliveryAddress(event.target.value)}
                placeholder="Город, улица, дом, квартира" />
            </label>
          ) : null}
          <p className="public-order-notice">
            Заказ сначала подтверждается в системе магазина.
            Онлайн-оплата доступна только у продавца с подключёнными
            эквайрингом и онлайн-кассой. При отсутствии онлайн-оплаты
            сотрудник согласует расчёт отдельно.
          </p>
          <button
            className="public-primary-button"
            disabled={Boolean(busy) || cart.status !== "OPEN" || !name.trim() ||
              (!phone.trim() && !email.trim()) ||
              !cart.lines.length || cart.lines.some(line => !line.is_available) ||
              deliveryLoading || deliveryFailed ||
              delivery.length===0 || !deliveryMethodId ||
              (delivery.find(d=>d.id===deliveryMethodId)?.mode==="LOCAL_COURIER" &&
                deliveryAddress.trim().length<8)}
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
