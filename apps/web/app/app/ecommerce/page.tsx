"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../components/app-sidebar";
import {apiRequest} from "../../../lib/api";

type Warehouse={id:string;name:string;code:string;tracked_skus:number};
type Connection={id:string;name:string;provider:string;status:string;last_synced_at:string|null;last_error:string|null};
type Mapping={id:string;connection_id:string;external_offer_id:string;sku_id:string;sku:string;channel_name:string;provider:string};
type StockListing={
  id:string;connection_id:string;provider:string;connection_name:string;
  warehouse_id:string;warehouse_name:string;sku_id:string;sku:string;
  mapping_id:string;external_offer_id:string;external_warehouse_id:string|null;
  external_stock_id:string|null;priority:number;enabled:boolean;publish_enabled:boolean;
  physical_milli:string;reserved_milli:string;safety_stock_milli:string;
  target_units:number;published_units:number|null;sync_status:string|null;
  last_error:string|null;last_published_at:string|null;
};
type Hub={
  warehouses:Warehouse[];connections:Connection[];mappings:Mapping[];
  listings:StockListing[];queuedPools:number;safetyNote:string;
};
type Product={skuId:string;sku:string;productName:string};
const quantity=(v:string)=>new Intl.NumberFormat("ru-RU",{maximumFractionDigits:3}).format(Number(v)/1000);
const timestamp=(v:string|null)=>v?new Date(v).toLocaleString("ru-RU"):"Ещё не выполнялась";
const initial={connectionId:"",mappingId:"",warehouseId:"",externalWarehouseId:"",
  externalStockId:"",priority:"100",publishEnabled:false,enabled:true};
export default function EcommerceHubPage(){
  const [hub,setHub]=useState<Hub|null>(null);
  const [products,setProducts]=useState<Product[]>([]);
  const [form,setForm]=useState(initial);
  const [mapConnection,setMapConnection]=useState("");
  const [mapSku,setMapSku]=useState("");
  const [mapExternal,setMapExternal]=useState("");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const load=useCallback(async()=>{
    const [stock,products]=await Promise.all([
      apiRequest<Hub>("/channels/stock-hub"),
      apiRequest<Product[]>("/catalog/products")
    ]);
    setHub(stock);setProducts(products);
  },[]);
  useEffect(()=>{
    void load().catch(e=>setError(e instanceof Error?e.message:"Не удалось загрузить хаб"))
      .finally(()=>setLoading(false));
  },[load]);
  const connections=useMemo(()=>(hub?.connections??[]).filter(c=>
    ["OZON","WILDBERRIES","YANDEX_MARKET"].includes(c.provider)),[hub]);
  const availableMappings=useMemo(()=>(hub?.mappings??[]).filter(m=>
    m.connection_id===form.connectionId),[hub,form.connectionId]);
  const provider=connections.find(c=>c.id===form.connectionId)?.provider??"";
  const stockConnection=hub?.connections.find(c=>c.id===form.connectionId);
  const needsWb=provider==="WILDBERRIES";

  async function saveListing(){
    setError("");setNotice("");
    if(!form.mappingId||!form.warehouseId||!form.connectionId){
      setError("Выберите канал, сопоставленный товар и собственный склад");return;
    }
    if(form.publishEnabled&&!window.confirm(
      "Подтвердите включение передачи остатков в маркетплейс. При первой активации хаб сначала отправит 0, затем распределит доступный запас."
    ))return;
    setBusy(true);
    try{
      const result=await apiRequest<{listingId:string;warning:string}>(
        "/channels/stock-hub/listings",{
          method:"POST",
          body:JSON.stringify({
            connectionId:form.connectionId,mappingId:form.mappingId,
            warehouseId:form.warehouseId,
            externalWarehouseId:form.externalWarehouseId,
            externalStockId:form.externalStockId||undefined,
            priority:Number(form.priority),enabled:form.enabled,
            publishEnabled:form.publishEnabled
          })
        });
      setNotice("Сохранено. "+result.warning);
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить канал");}
    finally{setBusy(false);}
  }
  async function saveMapping(){
    if(!mapConnection||!mapSku||!mapExternal.trim()){
      setError("Нужны канал, внутренний товар и внешний артикул");return;
    }
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/channels/connections/"+mapConnection+"/mappings",{
        method:"POST",body:JSON.stringify({
          skuId:mapSku,externalOfferId:mapExternal.trim()
        })
      });
      setMapExternal("");
      await load();
      setNotice("Товар сопоставлен. Теперь настройте его остатки в хабе.");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сопоставить товар");}
    finally{setBusy(false);}
  }
  async function reconcile(){
    setBusy(true);setError("");setNotice("");
    try{
      const result=await apiRequest<{queuedPools:number}>("/channels/stock-hub/reconcile",
        {method:"POST",body:"{}"});
      setNotice("В очередь поставлено пулов: "+result.queuedPools);
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Ошибка пересчёта");}
    finally{setBusy(false);}
  }
  async function retryListing(id:string){
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/channels/stock-hub/listings/"+id+"/retry",{method:"POST",body:"{}"});
      setNotice("Отправка добавлена в очередь повторно.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось повторить передачу");}
    finally{setBusy(false);}
  }

  const edit=(l:StockListing)=>{
    setForm({connectionId:l.connection_id,mappingId:l.mapping_id,warehouseId:l.warehouse_id,
      externalWarehouseId:l.external_warehouse_id??"",externalStockId:l.external_stock_id??"",
      priority:String(l.priority),publishEnabled:l.publish_enabled,enabled:l.enabled});
    window.scrollTo({top:0,behavior:"smooth"});
  };
  const published=(l:StockListing)=>l.published_units===null?"Не подтверждено":String(l.published_units);
  return <main className="app-shell">
    <AppSidebar active="ecommerce"/>
    <section className="workspace workspace-wide agency-premium">
      <header className="agency-hero">
        <div><span className="studio-eyebrow">E-COMMERCE · ONE INVENTORY</span>
          <h1>Центр маркетплейсов</h1>
          <p>Единый физический склад, сопоставление SKU и консервативное распределение доступного товара по витринам. Нельзя выставить одну последнюю единицу сразу на трёх независимых площадках.</p>
        </div>
        <div className="agency-hero-actions">
          <a className="secondary-button" href="/app/channels">Подключения</a>
          <a className="secondary-button" href="/app/inventory/stock">Физические остатки</a>
          <a className="secondary-button" href="/app/oms">Заказы OMS</a>
          <button disabled={busy} onClick={()=>void reconcile()}>Пересчитать остатки</button>
        </div>
      </header>
      {error?<div className="studio-message error" role="alert">{error}</div>:null}
      {notice?<p role="status">{notice}</p>:null}
      {loading?<p>Получаем остатки и подключения…</p>:null}
      {hub?<div className="agency-score-grid">
        <article><span>Каналы</span><strong>{connections.length}</strong><small>подключённых кабинетов</small></article>
        <article><span>SKU в хабе</span><strong>{new Set(hub.listings.map(x=>x.sku_id)).size}</strong>
          <small>единый внутренний каталог</small></article>
        <article><span>Активная публикация</span><strong>{hub.listings.filter(x=>x.publish_enabled).length}</strong>
          <small>уже настроенных витрин</small></article>
        <article><span>Очередь пересчёта</span><strong>{hub.queuedPools}</strong>
          <small>складов и товаров</small></article>
        <article><span>Проблемы обмена</span>
          <strong>{hub.listings.filter(x=>["BLOCKED","RETRY"].includes(x.sync_status??"")).length}</strong>
          <small>проверьте ниже</small></article>
      </div>:null}
      <section className="agency-board">
        <div className="studio-section-head"><div>
          <h2>1. Сопоставить внешний артикул</h2>
          <p>Для любого магазина и маркетплейса у одного товара остаётся единый внутренний SKU. Внешние артикулы могут отличаться.</p>
        </div></div>
        <div className="agency-hero-actions">
          <select value={mapConnection} onChange={e=>setMapConnection(e.target.value)} aria-label="Маркетплейс">
            <option value="">Выберите подключение</option>
            {connections.map(c=><option key={c.id} value={c.id}>{c.name} · {c.provider}</option>)}
          </select>
          <select value={mapSku} onChange={e=>setMapSku(e.target.value)} aria-label="Внутренний SKU">
            <option value="">Внутренний SKU</option>
            {products.map(p=><option key={p.skuId} value={p.skuId}>{p.sku} · {p.productName}</option>)}
          </select>
          <input value={mapExternal} onChange={e=>setMapExternal(e.target.value)}
            placeholder="Артикул маркетплейса / offer_id" aria-label="Внешний артикул"/>
          <button disabled={busy} onClick={()=>void saveMapping()}>Связать товары</button>
        </div>
      </section>
      <section className="agency-board">
        <div className="studio-section-head"><div>
          <h2>2. Распределение запаса по витринам</h2>
          <p>Публикация по умолчанию выключена. Укажите склад маркетплейса и настройте защитный остаток в разделе склада.</p>
        </div></div>
        <div className="agency-hero-actions">
          <select aria-label="Канал" value={form.connectionId}
            onChange={e=>setForm({...form,connectionId:e.target.value,mappingId:"",externalStockId:""})}>
            <option value="">Подключение</option>
            {connections.map(c=><option key={c.id} value={c.id}>{c.name} · {c.provider}</option>)}
          </select>
          <select aria-label="Сопоставленный товар" value={form.mappingId}
            onChange={e=>setForm({...form,mappingId:e.target.value})}>
            <option value="">SKU / offer_id</option>
            {availableMappings.map(m=><option key={m.id} value={m.id}>{m.sku} ↔ {m.external_offer_id}</option>)}
          </select>
          <select aria-label="Собственный склад" value={form.warehouseId}
            onChange={e=>setForm({...form,warehouseId:e.target.value})}>
            <option value="">Собственный склад</option>
            {(hub?.warehouses??[]).map(w=><option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <input value={form.externalWarehouseId}
            onChange={e=>setForm({...form,externalWarehouseId:e.target.value})}
            placeholder="ID склада площадки" aria-label="Внешний склад"/>
          {needsWb?<input value={form.externalStockId}
            onChange={e=>setForm({...form,externalStockId:e.target.value})}
            placeholder="Wildberries chrtId размера" aria-label="Идентификатор размера WB"/>:null}
          <label>Приоритет
            <input type="number" min={1} max={10000} value={form.priority}
              onChange={e=>setForm({...form,priority:e.target.value})}/>
          </label>
          <label><input type="checkbox" checked={form.enabled}
            onChange={e=>setForm({...form,enabled:e.target.checked})}/> Участвует в распределении</label>
          <label><input type="checkbox" checked={form.publishEnabled}
            onChange={e=>setForm({...form,publishEnabled:e.target.checked})}/>
            Передавать остатки через API</label>
          <button disabled={busy||!form.mappingId} onClick={()=>void saveListing()}>Сохранить настройку</button>
        </div>
        {stockConnection && !stockConnection.last_synced_at?
          <p>Сначала запустите первичную загрузку заказов в разделе «Каналы продаж».</p>:null}
        {provider==="YANDEX_MARKET"?<p>Для Яндекс Маркета поддерживаются склады без групп. Сначала синхронизируйте заказы, затем включите публикацию.</p>:null}
      </section>
      <section className="agency-board">
        <div className="studio-section-head"><div>
          <h2>3. Остатки и состояние синхронизации</h2>
          <p>Физический остаток, резерв OMS, защитный запас и количество, переданное площадке, показываются отдельно.</p>
        </div></div>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead><tr><th>Товар / склад</th><th>Канал</th><th>Факт / резерв / защита</th>
              <th>К публикации</th><th>Отправлено</th><th>Статус и время</th><th/></tr></thead>
            <tbody>
              {(hub?.listings??[]).map(l=><tr key={l.id}>
                <td><strong>{l.sku}</strong><small>{l.warehouse_name}</small></td>
                <td>{l.connection_name}<small>{l.external_offer_id}</small></td>
                <td>{quantity(l.physical_milli)} / {quantity(l.reserved_milli)} / {quantity(l.safety_stock_milli)}</td>
                <td><strong>{l.target_units}</strong></td>
                <td>{published(l)}</td>
                <td><span className="status-pill">{l.sync_status??"SETUP"}</span>
                  <small>{timestamp(l.last_published_at)}</small>
                  {l.last_error?<small role="alert">{l.last_error}</small>:null}</td>
                <td><button className="secondary-button" onClick={()=>edit(l)}>Изменить</button>
                  {["RETRY","BLOCKED"].includes(l.sync_status??"")?
                    <button disabled={busy} onClick={()=>void retryListing(l.id)}>Повторить</button>:null}</td>
              </tr>)}
              {!hub?.listings.length?<tr><td colSpan={7}>Пока нет настроенных SKU. Сначала подключите маркетплейс и свяжите товар.</td></tr>:null}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted">Важно: обновление на внешней витрине может занимать время, а FBO/FBW и товары на складах самих площадок нельзя считать общим доступным FBS-остатком. Сверяйте фактические остатки в кабинете продавца.</p>
    </section>
  </main>;
}
