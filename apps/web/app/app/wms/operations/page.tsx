"use client";
import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";

type Warehouse={id:string;name:string;code:string};
type StockItem={
  skuId:string;sku:string;productName:string;
  physicalMilli:string;reservedMilli:string;
  expectedMilli:string;availableNowMilli:string;
  projectedPlanningMilli:string;sellableNowMilli:string;
  recommendedPurchaseMilli:string;state:string;
};
type Stock={warehouseId:string;warehouseName:string;
  planningExpectedIsNotPhysical:boolean;requiresPagination:boolean;
  totalShown:number;shortages:number;items:StockItem[]};
type Route={warehouseId:string;waveId:string|null;globallyOptimal:boolean;
  ordering:string;truncated:boolean;tasks:Array<{
    taskId:string;zonePriority:number;pickSequence:number;
    priority:number;locationCode:string;skuCode:string;
    quantityMilli:string;orderId:string|null;status:string;
  }>};
const quantity=(milli:string)=>{
  try{
    const v=BigInt(milli);const neg=v<0n?"−":"";
    const abs=v<0n?-v:v;
    const whole=new Intl.NumberFormat("ru-RU").format(abs/1000n);
    const frac=(abs%1000n).toString().padStart(3,"0")
      .replace(/0+$/,"");
    return neg+whole+(frac?","+frac:"");
  }catch{return "—";}
};
const states:Record<string,string>={
  RESERVATION_SHORTAGE:"Резерв превышает фактический остаток",
  BELOW_SAFETY:"Ниже страхового остатка",
  INCOMING_CONFIRMED:"Подтверждена поставка",
  OK:"Норма"
};
export default function WarehouseOperationsPage(){
  const [warehouses,setWarehouses]=useState<Warehouse[]>([]);
  const [warehouseId,setWarehouseId]=useState("");
  const [stock,setStock]=useState<Stock|null>(null);
  const [route,setRoute]=useState<Route|null>(null);
  const [filter,setFilter]=useState("");
  const [onlyProblems,setOnlyProblems]=useState(false);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState("");
  const [refreshNo,setRefreshNo]=useState(0);
  const requestVersion=useRef(0);
  useEffect(()=>{
    let cancelled=false;
    void apiRequest<Warehouse[]>("/wms/warehouses")
      .then(x=>{if(!cancelled){setWarehouses(x);
        setWarehouseId(prev=>prev&&x.some(w=>w.id===prev)?prev:x[0]?.id??"");}})
      .catch(e=>{if(!cancelled)setError(
        e instanceof Error?e.message:"Не удалось загрузить склады");});
    return()=>{cancelled=true;};
  },[]);
  const load=useCallback(async()=>{
    if(!warehouseId)return;
    const current=++requestVersion.current;
    setLoading(true);setError("");
    setStock(null);setRoute(null);
    try{
      const [s,r]=await Promise.all([
        apiRequest<Stock>("/wms/operations/warehouses/"+
          encodeURIComponent(warehouseId)+"/stock"),
        apiRequest<Route>("/wms/operations/warehouses/"+
          encodeURIComponent(warehouseId)+"/pick-route")
      ]);
      if(current===requestVersion.current){setStock(s);setRoute(r);}
    }catch(e){
      if(current===requestVersion.current)
        setError(e instanceof Error?e.message:"Не удалось получить складскую сводку");
    }finally{
      if(current===requestVersion.current)setLoading(false);
    }
  },[warehouseId,refreshNo]);
  useEffect(()=>{void load();},[load]);
  const shown=useMemo(()=>(stock?.items??[]).filter(item=>
    (!onlyProblems||["RESERVATION_SHORTAGE","BELOW_SAFETY"].includes(item.state))
    &&(item.sku+" "+item.productName).toLowerCase().includes(filter.toLowerCase().trim())
  ),[stock,onlyProblems,filter]);
  return <main className="app-shell">
    <AppSidebar active="wms"/>
    <section className="workspace workspace-wide">
      <header className="wms-ops-head">
        <div><p className="muted">COREBIZ · СКЛАД И ЗАКАЗЫ</p>
          <h1>Складской центр</h1>
          <p>Один физический остаток для продаж, закупок и адресного склада.
            Маршруты сборщиков — из существующих WMS-заданий.</p></div>
        <a className="secondary-button" href="/app/wms">Полный WMS →</a>
      </header>
      <div className="wms-ops-toolbar">
        <label>Склад
          <select value={warehouseId} onChange={e=>setWarehouseId(e.target.value)}>
            {warehouses.map(w=><option value={w.id} key={w.id}>
              {w.name} ({w.code})</option>)}
          </select>
        </label>
        <button disabled={loading||!warehouseId}
          onClick={()=>setRefreshNo(n=>n+1)}>
          {loading?"Обновляем…":"Перепроверить"}
        </button>
        <a href="/app/inventory/stock">Движения и остатки</a>
        <a href="/app/purchases">Закупки</a>
        <a href="/app/wms/mobile">Мобильный сборщик</a>
      </div>
      {error?<div role="alert" className="wms-ops-error">
        <strong>Данные не подтверждены</strong>
        <p>{error}</p>
        <button onClick={()=>setRefreshNo(x=>x+1)}>Повторить загрузку</button>
      </div>:null}
      {loading?<p role="status">Читаем актуальные складские данные…</p>:null}
      {stock?<section className="wms-ops-section">
        <div className="wms-ops-title">
          <div><h2>Остаток, резерв и ожидание</h2>
            <p>Заказ резервирует товар, но не списывает его. Подтверждённая
              поставка входит в план, но не в доступный физический остаток.</p></div>
          <strong>{stock.shortages} проблемных SKU</strong>
        </div>
        {stock.requiresPagination?<p role="alert" className="wms-ops-error">
          Показаны первые 500 позиций. Для больших каталогов требуется постраничный отчёт;
          сводные количества по этому экрану не являются полным балансом.</p>:null}
        <div className="wms-ops-controls">
          <input value={filter} placeholder="Поиск товара или SKU" aria-label="Поиск SKU"
            onChange={e=>setFilter(e.target.value)}/>
          <label><input type="checkbox" checked={onlyProblems}
            onChange={e=>setOnlyProblems(e.target.checked)}/> Только проблемы</label>
        </div>
        <div className="wms-ops-table-wrap"><table className="wms-ops-table">
          <thead><tr><th>Товар / SKU</th><th>Физически</th><th>Резерв</th>
            <th>Доступно сейчас</th><th>Ожидается</th>
            <th>Продать сейчас</th><th>К закупке</th><th>Состояние</th></tr></thead>
          <tbody>{shown.map(item=><tr key={item.skuId}>
            <td><strong>{item.productName}</strong><small>{item.sku}</small></td>
            <td>{quantity(item.physicalMilli)}</td>
            <td>{quantity(item.reservedMilli)}</td>
            <td>{quantity(item.availableNowMilli)}</td>
            <td>{quantity(item.expectedMilli)}</td>
            <td>{quantity(item.sellableNowMilli)}</td>
            <td>{quantity(item.recommendedPurchaseMilli)}</td>
            <td>{states[item.state]??item.state}</td>
          </tr>)}</tbody>
        </table></div>
        {shown.length===0?<p className="muted">Нет позиций по выбранным условиям.</p>:null}
      </section>:null}
      {route?<section className="wms-ops-section">
        <div className="wms-ops-title"><div>
          <h2>Маршрут комплектации</h2>
          <p>Последовательность: приоритет зоны → порядок обхода ячеек.
            Это складская эвристика, не расчёт кратчайшего маршрута.</p>
        </div><strong>{route.tasks.length} заданий</strong></div>
        {route.truncated?<p role="alert">Маршрут ограничен 500 заданиями.
          Перед работой необходимо разбить задачи на волны.</p>:null}
        <div className="wms-ops-route">
          {route.tasks.map((t,i)=><article key={t.taskId}>
            <span className="wms-ops-step">{i+1}</span>
            <div><strong>{t.locationCode}</strong>
              <p>SKU {t.skuCode} · взять {quantity(t.quantityMilli)}
                {t.orderId?" · заказ "+t.orderId.slice(0,8):""}</p>
              <small>{t.status==="CLAIMED"?"Задание взято":"Ожидает сборщика"}</small>
            </div>
          </article>)}
        </div>
        {route.tasks.length===0?<p className="muted">Нет открытых заданий подбора.</p>:null}
        <p><a href="/app/wms/mobile">Подтверждение штрихкодов и выполнение заданий
          — в приложении сборщика →</a></p>
      </section>:null}
    </section>
  </main>;
}
