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
  planningExpectedIsNotPhysical:boolean;hasMore:boolean;
  nextCursor:string|null;items:StockItem[]};
type Supplier={id:string;displayName:string};
type CountVariance={
  id:string;location_code:string;sku_code:string;
  expected_milli:string;counted_milli:string;variance_milli:string
};
type CountQueue={items:CountVariance[];mayHaveMore:boolean;limit:number};
type Wave={id:string;strategy:string;status:string};
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
  const [waveId,setWaveId]=useState("");
  const [waves,setWaves]=useState<Wave[]>([]);
  const [countReview,setCountReview]=useState<CountQueue|null>(null);
  const [countIssue,setCountIssue]=useState("");
  const [countNotes,setCountNotes]=useState<Record<string,string>>({});
  const [countPending,setCountPending]=useState(false);
  const [countFeedback,setCountFeedback]=useState("");
  const [filter,setFilter]=useState("");
  const [appliedFilter,setAppliedFilter]=useState("");
  const [suppliers,setSuppliers]=useState<Supplier[]>([]);
  const [canProcure,setCanProcure]=useState(false);
  const [supplierId,setSupplierId]=useState("");
  const [selectedSku,setSelectedSku]=useState("");
  const [purchaseBusy,setPurchaseBusy]=useState(false);
  const [purchaseNotice,setPurchaseNotice]=useState("");
  const [moreBusy,setMoreBusy]=useState(false);
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
  useEffect(()=>{
    let cancelled=false;
    void Promise.allSettled([
      apiRequest<Supplier[]>("/procurement/suppliers"),
      apiRequest<{permissions:Array<{code:string;scope:string}>}>("/workspace/context")
    ]).then(([sup,ctx])=>{
      if(cancelled)return;
      if(sup.status==="fulfilled")setSuppliers(sup.value);
      if(ctx.status==="fulfilled")setCanProcure(ctx.value.permissions.some(x=>
        (x.code==="procurement.write"||x.code==="*")&&
        x.scope==="all"));
    });
    return()=>{cancelled=true;};
  },[]);
  const stockUrl=(cursor?:string)=>"/wms/operations/warehouses/"+
    encodeURIComponent(warehouseId)+"/stock-page?limit=100&onlyProblems="+
    String(onlyProblems)+"&query="+encodeURIComponent(appliedFilter)+
    (cursor?"&cursor="+encodeURIComponent(cursor):"");
  const load=useCallback(async()=>{
    if(!warehouseId)return;
    const current=++requestVersion.current;
    setLoading(true);setError("");
    setStock(null);setRoute(null);setCountReview(null);setCountIssue("");
    try{
      const [s,r,w,q]=await Promise.all([
        apiRequest<Stock>(stockUrl()),
        apiRequest<Route>("/wms/operations/warehouses/"+
          encodeURIComponent(warehouseId)+"/pick-route"+
          (waveId?"?waveId="+encodeURIComponent(waveId):"")),
        apiRequest<{waves:Wave[]}>("/wms/warehouses/"+
          encodeURIComponent(warehouseId)+"/dispatcher").catch(()=>null),
        apiRequest<CountQueue>("/wms/warehouses/"+
          encodeURIComponent(warehouseId)+"/count-variances")
          .then(data=>({ok:true as const,data}))
          .catch(e=>({ok:false as const,message:
            e instanceof Error?e.message:"Очередь сверки недоступна"}))
      ]);
      if(current===requestVersion.current){
        setStock(s);setRoute(r);setWaves(w?.waves??[]);
        if(q.ok)setCountReview(q.data);
        else setCountIssue(q.message);
      }
    }catch(e){
      if(current===requestVersion.current)
        setError(e instanceof Error?e.message:"Не удалось получить складскую сводку");
    }finally{
      if(current===requestVersion.current)setLoading(false);
    }
  },[warehouseId,waveId,refreshNo,appliedFilter,onlyProblems]);
  useEffect(()=>{void load();},[load]);
  const shown=stock?.items??[];
  const selectedItem=shown.find(item=>item.skuId===selectedSku);
  async function resolveCount(line:CountVariance,decision:"APPROVE"|"RECOUNT"){
    if(countPending||loading)return;
    const note=(countNotes[line.id]??"").trim();
    if(note.length<8){setCountFeedback("Обоснование: не менее 8 символов.");return;}
    setCountPending(true);setCountFeedback("");
    try{
      await apiRequest("/wms/count-lines/"+encodeURIComponent(line.id)+"/review",{
        method:"POST",body:JSON.stringify({decision,note})
      });
      setCountFeedback(decision==="APPROVE"
        ?"Разница подтверждена в учёте склада."
        :"Создано повторное задание на пересчёт.");
      setCountNotes(n=>({...n,[line.id]:""}));
    }catch(e){
      setCountFeedback((e instanceof Error?e.message:"Операция не подтверждена")+
        ". Проверьте данные перед повторением.");
    }finally{
      setCountPending(false);setRefreshNo(n=>n+1);
    }
  }
  async function loadMore(){
    const cursor=stock?.nextCursor;
    if(!cursor||moreBusy||loading)return;
    const revision=requestVersion.current;
    setMoreBusy(true);
    try{
      const page=await apiRequest<Stock>(stockUrl(cursor));
      if(revision!==requestVersion.current)return;
      setStock(prev=>prev?{...prev,items:[...prev.items,...page.items],
        nextCursor:page.nextCursor,hasMore:page.hasMore}:prev);
    }catch(e){
      if(revision===requestVersion.current)setError(
        e instanceof Error?e.message:"Не удалось получить следующую страницу");
    }finally{setMoreBusy(false);}
  }
  async function createPurchase(){
    if(!canProcure||!supplierId||!selectedItem||purchaseBusy)return;
    if(BigInt(selectedItem.recommendedPurchaseMilli)<=0n)return;
    setPurchaseBusy(true);setPurchaseNotice("");setError("");
    try{
      const order=await apiRequest<{id:string;number:string}>("/procurement/orders",{
        method:"POST",
        body:JSON.stringify({
          supplierPartyId:supplierId,destinationWarehouseId:warehouseId,
          lines:[{
            skuId:selectedItem.skuId,
            quantityMilli:selectedItem.recommendedPurchaseMilli
          }],
          notes:"Черновик закупки на основе складского дефицита CoreBiz"
        })
      });
      setPurchaseNotice("Черновик "+order.number+" создан. "+
        "Подтвердите количество, цену и поставщика в разделе закупок.");
      setSelectedSku("");setRefreshNo(x=>x+1);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось создать черновик");}
    finally{setPurchaseBusy(false);}
  }
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
          <select value={warehouseId} onChange={e=>{setWarehouseId(e.target.value);setWaveId("");}}>
            {warehouses.map(w=><option value={w.id} key={w.id}>
              {w.name} ({w.code})</option>)}
          </select>
        </label>
        <label>Волна комплектации
          <select value={waveId} onChange={e=>setWaveId(e.target.value)}>
            <option value="">Все открытые задания</option>
            {waves.filter(w=>["RELEASED","IN_PROGRESS"].includes(w.status))
              .map(w=><option key={w.id} value={w.id}>
                {w.strategy} · {w.id.slice(0,8)}
              </option>)}
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
          <strong>{shown.length} SKU на загруженных страницах</strong>
        </div>
        <p className="muted">Поиск выполняется по всему каталогу на сервере.
          Показаны только загруженные страницы; это не сводный остаток всех SKU.</p>
        <div className="wms-ops-controls">
          <form onSubmit={e=>{e.preventDefault();setAppliedFilter(filter.trim());}}>
            <input value={filter} placeholder="Поиск по всем товарам или SKU"
              aria-label="Поиск SKU" maxLength={80}
              onChange={e=>setFilter(e.target.value)}/>
            <button type="submit">Найти</button>
          </form>
          <label><input type="checkbox" checked={onlyProblems}
            onChange={e=>setOnlyProblems(e.target.checked)}/> Только дефицит</label>
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
            <td>{states[item.state]??item.state}
              {canProcure&&BigInt(item.recommendedPurchaseMilli)>0n?
                <button type="button" onClick={()=>setSelectedSku(item.skuId)}>
                  Подготовить закупку
                </button>:null}
            </td>
          </tr>)}</tbody>
        </table></div>
        {shown.length===0?<p className="muted">Нет позиций по выбранным условиям.</p>:null}
        {stock.hasMore?<button type="button" disabled={moreBusy||loading}
          onClick={()=>void loadMore()}>
          {moreBusy?"Загружаем…":"Показать следующие 100 SKU"}
        </button>:null}
        {selectedItem&&canProcure?<div className="wms-ops-section">
          <h3>Черновик заказа поставщику</h3>
          <p>{selectedItem.productName} · {selectedItem.sku} ·
            рекомендуется {quantity(selectedItem.recommendedPurchaseMilli)}.</p>
          <p>Черновик не пополняет остатки и не создаёт оплату.
            Количество и цену подтвердит закупщик перед отправкой.</p>
          <label>Поставщик
            <select value={supplierId} onChange={e=>setSupplierId(e.target.value)}>
              <option value="">Выберите поставщика</option>
              {suppliers.map(x=><option key={x.id} value={x.id}>
                {x.displayName}</option>)}
            </select>
          </label>
          {suppliers.length===0?<p><a href="/app/purchases">
            Сначала добавьте поставщика →</a></p>:null}
          <button type="button" disabled={purchaseBusy||!supplierId}
            onClick={()=>void createPurchase()}>
            {purchaseBusy?"Создаём…":"Создать черновик закупки"}
          </button>
          <button type="button" onClick={()=>setSelectedSku("")}>
            Отменить
          </button>
        </div>:null}
        {purchaseNotice?<p role="status">{purchaseNotice}{" "}
          <a href="/app/purchases">Открыть закупки →</a></p>:null}

      </section>:null}
      {(countReview||countIssue)?(
        <section className="wms-ops-section" aria-label="Расхождения инвентаризации">
          <div className="wms-ops-title">
            <div><h2>Расхождения инвентаризации</h2>
              <p>Кладовщик фиксирует подсчёт. Другой сотрудник утверждает
                корректировку или возвращает ячейку на пересчёт.</p>
            </div>
            {countReview?<strong>{countReview.items.length} на проверке</strong>:null}
          </div>
          {countIssue?<p role="status" className="muted">
            Очередь недоступна для текущей роли либо временно не отвечает:
            {" "}{countIssue}</p>:null}
          {countFeedback?<p role="status">{countFeedback}</p>:null}
          {countReview?.mayHaveMore?<p role="alert">
            Показаны первые 200 записей, очередь может быть больше.</p>:null}
          <div className="wms-count-review-list">
            {countReview?.items.map(line=><article className="wms-count-review-row"
              key={line.id}>
              <div><strong>SKU {line.sku_code} · {line.location_code}</strong>
                <p>Учёт: {quantity(line.expected_milli)}
                  {" · "}Факт: {quantity(line.counted_milli)}
                  {" · "}Разница: {quantity(line.variance_milli)}</p>
              </div>
              <label>Причина решения
                <input maxLength={1500} value={countNotes[line.id]??""}
                  placeholder="Повторно проверено по документу…"
                  onChange={e=>setCountNotes(prev=>({
                    ...prev,[line.id]:e.target.value
                  }))}/>
              </label>
              <div className="wms-count-review-actions">
                <button disabled={countPending||loading||
                  (countNotes[line.id]??"").trim().length<8}
                  onClick={()=>void resolveCount(line,"APPROVE")}>
                  Утвердить разницу
                </button>
                <button className="secondary-button" disabled={countPending||loading||
                  (countNotes[line.id]??"").trim().length<8}
                  onClick={()=>void resolveCount(line,"RECOUNT")}>
                  Пересчитать заново
                </button>
              </div>
            </article>)}
          </div>
          {countReview?.items.length===0?<p className="muted">
            Нет расхождений, ожидающих решения.</p>:null}
        </section>
      ):null}
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
