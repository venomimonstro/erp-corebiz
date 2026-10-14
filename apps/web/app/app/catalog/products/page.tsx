"use client";

import {type FormEvent,useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";

type Row={
  productId:string;productName:string;imageUrl:string|null;kind:string;
  skuId:string;sku:string;barcode:string|null;currency:string;
  salePriceMinor:string;costPriceMinor:string|null;trackInventory:boolean;
};
type Detail={
  product_id:string;name:string;description:string|null;image_url:string|null;
  category_id:string|null;kind:string;sku_id:string;sku:string;
  barcode:string|null;currency:string;attributes:Record<string,string>;
  sale_price_minor:string;cost_price_minor:string|null;
  stock:Array<{warehouse_id:string;warehouse_name:string;physical_milli:string;
    reserved_milli:string;available_milli:string}>;
};
type Category={id:string;name:string;parent_id:string|null};
type FormData={
  name:string;sku:string;kind:"STOCKABLE"|"NON_STOCK";
  barcode:string;description:string;imageUrl:string;
  categoryId:string;sale:string;cost:string;attributes:string;
};
const empty:FormData={
  name:"",sku:"",kind:"STOCKABLE",barcode:"",description:"",imageUrl:"",
  categoryId:"",sale:"0",cost:"",attributes:""
};
const format=(minor:string|null)=>{
  if(minor===null)return "Доступ ограничен";
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency:"RUB",maximumFractionDigits:2
  }).format(Number(minor)/100);
};
function toMinor(input:string):string{
  const normalized=input.trim().replace(",",".").replace(/\s+/g,"");
  if(!/^\d{1,14}(?:\.\d{1,2})?$/.test(normalized))
    throw new Error("Цена должна быть числом, например 2500,50");
  const [whole,decimal=""]=normalized.split(".");
  const minor=BigInt(whole)*100n+BigInt(decimal.padEnd(2,"0"));
  if(minor>9223372036854775807n)throw new Error("Слишком большая сумма");
  return String(minor);
}
function parseAttributes(raw:string){
  const result:Record<string,string>={};
  for(const line of raw.split(/\r?\n/).map(x=>x.trim()).filter(Boolean)){
    const pos=line.indexOf(":");
    if(pos<1)throw new Error("Характеристики: по одной на строку, «Цвет: Красный»");
    const key=line.slice(0,pos).trim(),value=line.slice(pos+1).trim();
    if(!value||key.length>80||value.length>500||key in result)
      throw new Error("Проверьте названия и значения характеристик");
    result[key]=value;
  }
  if(Object.keys(result).length>40)throw new Error("Не более 40 характеристик");
  return result;
}

export default function ProductsPage(){
  const [items,setItems]=useState<Row[]>([]);
  const [categories,setCategories]=useState<Category[]>([]);
  const [search,setSearch]=useState("");
  const [appliedSearch,setAppliedSearch]=useState("");
  const [cursor,setCursor]=useState<string|null>(null);
  const [hasMore,setHasMore]=useState(false);
  const [loading,setLoading]=useState(true);
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [mode,setMode]=useState<"create"|"edit"|null>(null);
  const [form,setForm]=useState<FormData>(empty);
  const [selected,setSelected]=useState<Detail|null>(null);
  const [categoryName,setCategoryName]=useState("");
  const [showCategory,setShowCategory]=useState(false);
  const [archiveConfirmed,setArchiveConfirmed]=useState(false);
  const [canEditCost,setCanEditCost]=useState(false);
  const load=useCallback(async(next:string|null=null,q=appliedSearch)=>{
    setLoading(true);setError("");
    try{
      const params=new URLSearchParams({limit:"100"});
      if(next)params.set("cursor",next);
      if(q.trim())params.set("q",q.trim());
      const response=await apiRequest<{
        items:Row[];hasMore:boolean;nextCursor:string|null
      }>("/catalog/products/page?"+params.toString());
      setItems(old=>next?[...old,...response.items]:response.items);
      setHasMore(response.hasMore);setCursor(response.nextCursor);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить товары");}
    finally{setLoading(false);}
  },[appliedSearch]);
  const loadCategories=useCallback(async()=>{
    setCategories(await apiRequest<Category[]>("/catalog/products/categories"));
  },[]);
  useEffect(()=>{
    void load();
    void loadCategories().catch(()=>setError("Не удалось загрузить категории"));
    void apiRequest<{permissions:Array<{code:string;scope:string}>}>("/workspace/context")
      .then(ctx=>setCanEditCost(ctx.permissions.some(p=>
        ["*","finance.read","catalog.cost.read"].includes(p.code)&&p.scope==="all")))
      .catch(()=>setCanEditCost(false));
  },[load,loadCategories]);
  useEffect(()=>{
    const query=new URLSearchParams(window.location.search);
    if(query.get("create")==="1"){
      setMode("create");
      window.history.replaceState(null,"","/app/catalog/products");
    }
  },[]);
  const set=(field:keyof FormData,value:string)=>
    setForm(current=>({...current,[field]:value}));
  async function openEdit(row:Row){
    setError("");setNotice("");
    try{
      const detail=await apiRequest<Detail>(
        "/catalog/products/"+encodeURIComponent(row.productId));
      setSelected(detail);setArchiveConfirmed(false);
      setForm({
        name:detail.name,sku:detail.sku,
        kind:detail.kind==="NON_STOCK"?"NON_STOCK":"STOCKABLE",
        barcode:detail.barcode??"",description:detail.description??"",
        imageUrl:detail.image_url??"",categoryId:detail.category_id??"",
        sale:(Number(detail.sale_price_minor)/100).toFixed(2),
        cost:detail.cost_price_minor===null?"":(Number(detail.cost_price_minor)/100).toFixed(2),
        attributes:Object.entries(detail.attributes??{}).map(([k,v])=>k+": "+v).join("\n")
      });
      setMode("edit");
    }catch(e){setError(e instanceof Error?e.message:"Карточка недоступна");}
  }
  async function save(e:FormEvent){
    e.preventDefault();if(saving)return;
    setSaving(true);setError("");setNotice("");
    try{
      const base={
        name:form.name.trim(),barcode:form.barcode.trim()||null,
        description:form.description.trim()||null,
        imageUrl:form.imageUrl.trim()||null,
        categoryId:form.categoryId||null,
        salePriceMinor:toMinor(form.sale),
        attributes:parseAttributes(form.attributes)
      };
      if(mode==="create"){
        await apiRequest("/catalog/products",{
          method:"POST",body:JSON.stringify({
            ...base,categoryId:base.categoryId||undefined,
            barcode:base.barcode||undefined,
            imageUrl:base.imageUrl||undefined,
            kind:form.kind,sku:form.sku.trim()||undefined,
            ...(canEditCost&&form.cost.trim()?{costPriceMinor:toMinor(form.cost)}:{})
          })
        });
        setNotice("Товар добавлен. Фактический остаток появится только после приёмки на склад.");
      }else if(mode==="edit"&&selected){
        await apiRequest("/catalog/products/"+selected.product_id,{
          method:"PATCH",body:JSON.stringify({
            ...base,
            ...(canEditCost&&form.cost.trim()?{costPriceMinor:toMinor(form.cost)}:{})
          })
        });
        setNotice("Карточка обновлена. Исторические заказы не изменены.");
      }else throw new Error("Выберите товар");
      setMode(null);setSelected(null);setForm(empty);
      await load(null,appliedSearch);
    }catch(err){setError(err instanceof Error?err.message:"Не удалось сохранить");}
    finally{setSaving(false);}
  }
  async function createCategory(e:FormEvent){
    e.preventDefault();if(saving||!categoryName.trim())return;
    setSaving(true);setError("");
    try{
      const created=await apiRequest<{id:string}>("/catalog/products/categories",{
        method:"POST",body:JSON.stringify({name:categoryName.trim()})
      });
      await loadCategories();
      set("categoryId",created.id);
      setCategoryName("");setShowCategory(false);
    }catch(e){setError(e instanceof Error?e.message:"Категория не создана");}
    finally{setSaving(false);}
  }
  async function archive(){
    if(!selected||!archiveConfirmed||saving)return;
    setSaving(true);setError("");
    try{
      await apiRequest("/catalog/products/"+selected.product_id+"/archive",{
        method:"POST"
      });
      setMode(null);setSelected(null);setArchiveConfirmed(false);
      setNotice("Товар перенесён в архив, история операций сохранена.");
      await load(null,appliedSearch);
    }catch(e){setError(e instanceof Error?e.message:"Сначала разберите остатки и резервы");}
    finally{setSaving(false);}
  }
  const stock=selected?.stock??[];
  const stockTotal=stock.reduce((a,b)=>a+BigInt(b.physical_milli),0n);
  return <main className="app-shell">
    <AppSidebar active="products"/>
    <section className="workspace workspace-wide catalog-workspace">
      <header className="workspace-header">
        <div><p className="muted">Общий каталог компании</p>
          <h1>Товары и цены</h1>
          <p className="workspace-summary">
            Загружено {items.length} SKU{hasMore?" · есть ещё товары":""}.
            Один каталог для сайта, кассы, опта и складов.
          </p>
        </div>
        <div className="catalog-actions">
          <a className="secondary-button" href="/app/migration">Импорт Excel / CSV</a>
          <button type="button" onClick={()=>{
            setForm(empty);setSelected(null);setMode("create");setError("");
          }}>+ Новый товар</button>
        </div>
      </header>
      <nav className="catalog-guide">
        <a href="/app/purchases">1. Закупки и приход →</a>
        <a href="/app/inventory/stock">2. Остатки и склады →</a>
        <a href="/app/oms">3. Заказы и отгрузки →</a>
      </nav>
      {notice?<p role="status" className="catalog-notice">{notice}</p>:null}
      {error?<p role="alert" className="inline-error">{error}</p>:null}
      <form className="catalog-search-strip" onSubmit={e=>{
        e.preventDefault();
        if(search.trim().length>0&&search.trim().length<3){
          setError("Поиск: не менее трёх символов");return;
        }
        setAppliedSearch(search.trim());
        void load(null,search.trim());
      }}>
        <input type="search" aria-label="Поиск SKU, штрихкода или названия"
          placeholder="Название, SKU или штрихкод" value={search}
          onChange={e=>setSearch(e.target.value)}/>
        <button disabled={loading}>Найти</button>
        {appliedSearch?<button type="button" className="secondary-button"
          onClick={()=>{setSearch("");setAppliedSearch("");void load(null,"");}}>
          Сбросить
        </button>:null}
      </form>
      {loading?<p role="status">Загрузка каталога…</p>:null}
      <div className="catalog-product-grid">
        {items.map(item=><article key={item.skuId} className="catalog-product-tile">
          {item.imageUrl?<img src={item.imageUrl} alt="" loading="lazy"/>:
            <div className="catalog-image-empty" aria-hidden="true">◻</div>}
          <div className="catalog-product-info">
            <strong>{item.productName}</strong>
            <small>{item.sku}{item.barcode?" · "+item.barcode:""}</small>
            <div className="catalog-price-row">
              <span>{format(item.salePriceMinor)}</span>
              <small>Закупка: {format(item.costPriceMinor)}</small>
            </div>
            <button className="secondary-button" type="button"
              onClick={()=>void openEdit(item)}>Карточка и остатки →</button>
          </div>
        </article>)}
      </div>
      {!loading&&items.length===0?<div className="table-empty">
        <strong>Товаров пока нет</strong>
        <span>Добавьте первый товар или импортируйте существующий каталог.</span>
      </div>:null}
      {hasMore?<button className="secondary-button" type="button"
        disabled={loading} onClick={()=>{if(cursor)void load(cursor);}}>
        Показать следующие 100 товаров
      </button>:null}

      {mode?<div className="catalog-drawer-overlay" role="presentation">
        <section className="catalog-drawer" role="dialog" aria-modal="true"
          aria-label={mode==="create"?"Новый товар":"Редактирование товара"}>
          <div className="catalog-drawer-head">
            <div><small>{mode==="create"?"Создание":"Карточка товара"}</small>
              <h2>{mode==="create"?"Новый товар":selected?.name}</h2>
            </div>
            <button type="button" className="secondary-button" disabled={saving}
              onClick={()=>{setMode(null);setSelected(null);}}>Закрыть</button>
          </div>
          <form onSubmit={e=>void save(e)} className="catalog-editor-form">
            <label>Название товара *
              <input required minLength={2} maxLength={240} value={form.name}
                onChange={e=>set("name",e.target.value)}/></label>
            <div className="catalog-editor-two">
              <label>Артикул / SKU
                <input value={form.sku} disabled={mode==="edit"}
                  placeholder="Автоматически, если не задан"
                  onChange={e=>set("sku",e.target.value)}/></label>
              <label>Тип
                <select disabled={mode==="edit"} value={form.kind}
                  onChange={e=>set("kind",e.target.value)}>
                  <option value="STOCKABLE">Складской товар</option>
                  <option value="NON_STOCK">Без складского учёта</option>
                </select></label>
            </div>
            <label>Категория
              <select value={form.categoryId}
                onChange={e=>set("categoryId",e.target.value)}>
                <option value="">Без категории</option>
                {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
            <button type="button" className="secondary-button"
              onClick={()=>setShowCategory(!showCategory)}>
              + Добавить категорию
            </button>
            {showCategory?<div className="catalog-subform">
              <label>Новая категория
                <input value={categoryName} maxLength={120}
                  onChange={e=>setCategoryName(e.target.value)}/></label>
              <button type="button" disabled={saving||categoryName.trim().length<2}
                onClick={()=>void createCategory({preventDefault:()=>{}} as FormEvent)}>
                Сохранить категорию</button>
            </div>:null}
            <div className="catalog-editor-two">
              <label>Цена продажи, ₽ *
                <input required inputMode="decimal" value={form.sale}
                  onChange={e=>set("sale",e.target.value)}/></label>
              {canEditCost?<label>Закупочная цена, ₽
                <input inputMode="decimal" placeholder="Не указана"
                  value={form.cost} onChange={e=>set("cost",e.target.value)}/>
              </label>:<p className="muted">Закупочные цены доступны финансовым ролям.</p>}
            </div>
            <label>Штрихкод
              <input value={form.barcode} maxLength={128}
                onChange={e=>set("barcode",e.target.value)}/></label>
            <label>Описание
              <textarea rows={3} maxLength={10000} value={form.description}
                onChange={e=>set("description",e.target.value)}/></label>
            <label>Фото товара: ссылка HTTPS
              <input type="url" value={form.imageUrl}
                placeholder="https://example.ru/photo.jpg"
                onChange={e=>set("imageUrl",e.target.value)}/></label>
            {form.imageUrl.startsWith("https://")?
              <img className="catalog-editor-preview" src={form.imageUrl} alt="Предпросмотр товара"/>:null}
            <label>Характеристики
              <textarea rows={4} value={form.attributes}
                placeholder={"Цвет: Чёрный\nМатериал: Хлопок\nРазмер: M"}
                onChange={e=>set("attributes",e.target.value)}/>
              <small>Каждая характеристика с новой строки: Название: Значение</small>
            </label>
            <button type="submit" disabled={saving||form.name.trim().length<2}>
              {saving?"Сохраняем…":mode==="create"?"Добавить товар":"Сохранить изменения"}
            </button>
          </form>
          {selected?<section className="catalog-stock-card">
            <h3>Складские остатки</h3>
            <p>Учтено: {(Number(stockTotal)/1000).toLocaleString("ru-RU")} ед.
              Изменение цены товара не меняет поступления и резервы.</p>
            {stock.length?stock.map(w=><div key={w.warehouse_id} className="catalog-stock-row">
              <strong>{w.warehouse_name}</strong>
              <span>Факт {Number(w.physical_milli)/1000} ·
                Резерв {Number(w.reserved_milli)/1000} ·
                Доступно {Number(w.available_milli)/1000}</span>
            </div>):<p>Поступлений на склад пока нет.</p>}
            <a href="/app/purchases">Создать закупку и оформить приход →</a>
            <hr/>
            <label className="catalog-archive-confirm">
              <input type="checkbox" checked={archiveConfirmed}
                onChange={e=>setArchiveConfirmed(e.target.checked)}/>
              Понимаю, что товар исчезнет из новых продаж. История сохранится.
            </label>
            <button type="button" className="secondary-button"
              disabled={!archiveConfirmed||saving}
              onClick={()=>void archive()}>Архивировать товар</button>
          </section>:null}
        </section>
      </div>:null}
    </section>
  </main>;
}
