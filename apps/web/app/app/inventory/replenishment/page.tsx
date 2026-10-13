"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";

type Alert={
  warehouseId:string;warehouseName:string;skuId:string;sku:string;
  productName:string;physicalMilli:string;reservedMilli:string;
  safetyStockMilli:string;availableMilli:string;
  recommendedPurchaseMilli:string;
  urgency:"RESERVATION_SHORTAGE"|"BELOW_SAFETY_STOCK"|"AWAITING_RECEIPT";
  confirmedInboundMilli:string;shortageBeforeInboundMilli:string;
  inboundScope:"UNIQUE_BRANCH_WAREHOUSE";
  purchaseOrderCreated:false;
};
function quantity(raw:string){
  const n=Number(raw);
  return Number.isSafeInteger(n)
    ?new Intl.NumberFormat("ru-RU",{maximumFractionDigits:3}).format(n/1000)
    :raw+" / 1000";
}
export default function ReplenishmentPage(){
  const [items,setItems]=useState<Alert[]>([]);
  const [warehouse,setWarehouse]=useState("");
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const reload=useCallback(async()=>{
    setLoading(true);setError("");setItems([]);
    try{
      const list=await apiRequest<Alert[]>("/inventory/replenishment");
      setItems(list);
    }catch(cause){
      setError(cause instanceof Error?cause.message:
        "Не удалось получить рекомендации по пополнению");
    }finally{setLoading(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  const warehouses=useMemo(()=>Array.from(new Map(
    items.map(item=>[item.warehouseId,item.warehouseName])).entries()
  ),[items]);
  const shown=items.filter(item=>!warehouse||item.warehouseId===warehouse);
  return <main className="app-shell">
    <AppSidebar active="stock"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div>
          <p className="dance-owner-kicker">Склад и закупки</p>
          <h1>Что необходимо пополнить</h1>
          <p>Рекомендации рассчитаны по реальным остаткам, резервам и
            страховым запасам компании. Ничего не закупается автоматически.</p>
        </div>
        <button disabled={loading} onClick={()=>void reload()}>
          {loading?"Загружаем…":"Обновить"}
        </button>
      </header>
      {error?<section role="alert" className="dance-customer-panel">
        <strong>Данные временно недоступны</strong><p>{error}</p>
        <button onClick={()=>void reload()}>Повторить</button>
      </section>:null}
      <section className="dance-customer-panel">
        <div className="inventory-replenishment-toolbar">
          <h2>Позиции для проверки закупщиком: {items.length}</h2>
          <label>Склад{" "}
            <select value={warehouse} onChange={e=>setWarehouse(e.target.value)}>
              <option value="">Все склады</option>
              {warehouses.map(([id,name])=><option key={id} value={id}>{name}</option>)}
            </select>
          </label>
        </div>
        {loading?<p role="status">Проверяем остатки…</p>:null}
        {!loading&&!error&&shown.length===0?
          <p>Дефицит среди позиций с включённым пополнением не обнаружен.
            Это не означает, что все товары заведены на склад или что
            ожидаемые поставки гарантированы.</p>:null}
        {shown.length>0?<div className="inventory-replenishment-list">
          {shown.map(item=><article key={item.warehouseId+"-"+item.skuId}>
            <div>
              <strong>{item.productName}</strong>
              <span>{item.sku} · {item.warehouseName}</span>
              <small>{item.urgency==="RESERVATION_SHORTAGE"
                ?"Срочно: резервы превышают фактический остаток"
                :item.urgency==="AWAITING_RECEIPT"
                  ?"Поступление подтверждено заказом поставщику — ожидаем приёмку"
                  :"Запас ниже установленного минимума"}</small>
            </div>
            <div className="inventory-replenishment-amounts">
              <small>На складе: {quantity(item.physicalMilli)}</small>
              <small>В резерве: {quantity(item.reservedMilli)}</small>
              <small>Страховой запас: {quantity(item.safetyStockMilli)}</small>
              <small>Дефицит до поставки: {quantity(item.shortageBeforeInboundMilli)}</small>
              <small>Подтверждено к поступлению: {quantity(item.confirmedInboundMilli)}</small>
              <strong>Дополнительно заказать: {quantity(item.recommendedPurchaseMilli)}</strong>
            </div>
          </article>)}
        </div>:null}
        <p className="muted">Формула: дополнительная закупка =
          max(0, резерв + страховой запас − фактический остаток −
          подтверждённые неполученные поставки). Поставки учитываются
          автоматически только если заказ поставщика однозначно связан
          с единственным активным складом филиала. Неуказанный филиал или
          несколько складов требуют ручной проверки закупщиком.
          Ожидание поставки не увеличивает фактические остатки; заказ
          поставщику не создаётся автоматически.</p>
        <div className="service-desk-links">
          <a href="/app/purchases">Открыть закупки →</a>
          <a href="/app/inventory/stock">Проверить остатки →</a>
        </div>
      </section>
    </section>
  </main>;
}
