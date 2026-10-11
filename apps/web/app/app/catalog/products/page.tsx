"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type ProductRow = {
  productId: string;
  productName: string;
  imageUrl: string | null;
  kind: "STOCKABLE" | "NON_STOCK";
  variantId: string;
  variantName: string;
  skuId: string;
  sku: string;
  barcode: string | null;
  salePriceMinor: string;
  costPriceMinor: string | null;
  currency: string;
  trackInventory: boolean;
};

function money(value: string | null, currency: string): string {
  if(value===null)return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(Number(value) / 100);
}

export default function ProductsPage() {
  const [items,setItems]=useState<ProductRow[]>([]);
  const [loading,setLoading]=useState(true);
  const [nextPageLoading,setNextPageLoading]=useState(false);
  const [error,setError]=useState("");
  const [cursor,setCursor]=useState<string|null>(null);
  const [hasMore,setHasMore]=useState(false);
  const [search,setSearch]=useState("");
  const [activeSearch,setActiveSearch]=useState("");

  const load=useCallback(async(nextCursor:string|null=null,query=activeSearch)=>{
    if(nextCursor)setNextPageLoading(true);else setLoading(true);
    setError("");
    try{
      const qs=new URLSearchParams({limit:"100"});
      if(nextCursor)qs.set("cursor",nextCursor);
      if(query.trim())qs.set("q",query.trim());
      const page=await apiRequest<{
        items:ProductRow[];nextCursor:string|null;hasMore:boolean
      }>("/catalog/products/page?"+qs.toString());
      setItems(current=>nextCursor?[...current,...page.items]:page.items);
      setCursor(page.nextCursor);
      setHasMore(page.hasMore);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить каталог");
    }finally{setLoading(false);setNextPageLoading(false);}
  },[activeSearch]);

  useEffect(()=>{void load();},[load]);

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
    const imageUrl = window.prompt("Ссылка на фото товара (HTTPS, необязательно)", "") ?? "";
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
          imageUrl: imageUrl.trim() || undefined,
          salePriceMinor: String(Math.round(saleRub * 100)),
          costPriceMinor: String(Math.round(costRub * 100)),
          kind: "STOCKABLE"
        })
      });
      await load(null,activeSearch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать товар");
    }
  }

  async function editImage(item:ProductRow) {
    const url=window.prompt(
      "Ссылка на фотографию товара (HTTPS). Очистите поле, чтобы удалить фото.",
      item.imageUrl ?? ""
    );
    if(url===null)return;
    try{
      await apiRequest("/catalog/products/"+item.productId+"/image",{
        method:"PATCH",body:JSON.stringify({imageUrl:url.trim()||null})
      });
      await load(null,activeSearch);
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось изменить фото");}
  }

  return (
    <main className="app-shell">
      <AppSidebar active="products" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Каталог / ERP Core</p>
            <h1>Товары</h1>
            <p className="workspace-summary">Загружено SKU: {items.length}
              {hasMore?" · есть следующая страница":""}</p>
          </div>
          <button onClick={quickCreate} type="button">+ Товар</button>
        </header>

        <form onSubmit={event=>{
          event.preventDefault();
          const q=search.trim();
          if(q.length>0&&q.length<3){setError("Поиск от 3 символов");return;}
          setActiveSearch(q);
          if(activeSearch===q)void load(null,q);
        }} className="catalog-search-strip">
          <input type="search" aria-label="Найти товар по названию, SKU или штрихкоду"
            placeholder="Поиск по SKU, штрихкоду или названию (от 3 символов)"
            value={search} onChange={e=>setSearch(e.target.value)}/>
          <button type="submit" disabled={loading||nextPageLoading}>Найти</button>
          {activeSearch?<button type="button" className="secondary-button"
            onClick={()=>{setSearch("");setActiveSearch("");}}>Очистить</button>:null}
        </form>

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
                  const margin=item.costPriceMinor===null
                    ?null:Number(item.salePriceMinor)-Number(item.costPriceMinor);

                  return (
                    <tr key={item.skuId}>
                      <td>
                        <div className="catalog-product-main">
                          {item.imageUrl ? <img loading="lazy" src={item.imageUrl}
                            alt="" className="catalog-product-image"/> :
                            <span className="catalog-product-placeholder" aria-hidden="true">◻</span>}
                          <div>
                            <strong>{item.productName}</strong>
                            {item.variantName !== "Основной" ? (
                              <small>{item.variantName}</small>
                            ) : null}
                            <button className="catalog-product-image-action"
                              type="button" onClick={()=>void editImage(item)}>
                              {item.imageUrl?"Изменить фото":"+ Добавить фото"}
                            </button>
                          </div>
                        </div>
                      </td>
                      <td>{item.sku}</td>
                      <td>{money(item.salePriceMinor, item.currency)}</td>
                      <td>{money(item.costPriceMinor, item.currency)}</td>
                      <td>{money(margin===null?null:String(margin), item.currency)}</td>
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
        {hasMore&&!loading?<div className="catalog-more">
          <button type="button" className="secondary-button" disabled={nextPageLoading}
            onClick={()=>{if(cursor)void load(cursor,activeSearch);}}>
            {nextPageLoading?"Загружаем…":"Показать ещё 100 SKU"}
          </button>
          <span>Каталог загружается страницами, без выгрузки всей базы в браузер.</span>
        </div>:null}
      </section>
    </main>
  );
}
