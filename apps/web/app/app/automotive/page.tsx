"use client";

import { FormEvent,useCallback,useEffect,useMemo,useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Dashboard={
  orders:{open_orders:number;waiting_parts:number;overdue:number;delivered_revenue_minor:string};
  donors:{active_donors:number;invested_minor:string};
  parts:{available_parts:number;reserved_parts:number;stock_cost_minor:string;stock_asking_minor:string};
};
type Vehicle={
  id:string;vin:string|null;plate_number:string|null;make:string;model:string;
  generation:string|null;production_year:number|null;mileage_km:number|null;
  owner_name:string|null;last_visit_at:string|null;
};
type WorkOrder={
  id:string;business_number:string;status:string;complaint:string|null;
  promised_at:string|null;estimated_total_minor:string;actual_total_minor:string;
  vin:string|null;plate_number:string|null;make:string;model:string;
  customer_name:string|null;line_count:number;
};
type WorkOrderLine={
  id:string;lineType:"LABOR"|"PART"|"MATERIAL"|"OTHER";description:string;
  quantityMilli:string;unitPriceMinor:string;unitCostMinor:string;
  approved:boolean;completed:boolean;
};
type WorkOrderDetail=WorkOrder&{
  diagnosis:string|null;mileage_in_km:number|null;mileage_out_km:number|null;
  authorization_limit_minor:string|null;approved_total_minor:string;
  lines:WorkOrderLine[];
};

type Donor={
  id:string;stock_number:string;vin:string|null;make:string;model:string;
  production_year:number|null;status:string;purchase_price_minor:string;
  dismantling_cost_minor:string;parts_total:number;parts_available:number;
  allocated_cost_minor:string;remaining_asking_minor:string;
};
type Part={
  id:string;part_name:string;oem_number:string|null;condition_grade:string;
  status:string;allocated_cost_minor:string;asking_price_minor:string;
  stock_number:string;donor_make:string;donor_model:string;sku_code:string|null;
};

function money(value:string|number|null|undefined){
  if(value===null||value===undefined)return "—";
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency:"RUB",maximumFractionDigits:0
  }).format(Number(value??0)/100);
}
function statusLabel(value:string){
  return ({
    DRAFT:"Черновик",DIAGNOSIS:"Диагностика",WAITING_APPROVAL:"Ждёт согласования",
    WAITING_PARTS:"Ждёт запчасти",IN_PROGRESS:"В работе",QUALITY_CHECK:"Контроль качества",
    READY:"Готов к выдаче",DELIVERED:"Выдан",CANCELLED:"Отменён",
    RECEIVED:"Принят",DISMANTLING:"Разбирается",DISMANTLED:"Разобран",
    AVAILABLE:"В продаже",RESERVED:"Резерв",SOLD:"Продано",INSTALLED:"Установлено"
  } as Record<string,string>)[value]??value;
}

export default function AutomotivePage(){
  const [tab,setTab]=useState<"orders"|"vehicles"|"dismantling">("orders");
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [vehicles,setVehicles]=useState<Vehicle[]>([]);
  const [orders,setOrders]=useState<WorkOrder[]>([]);
  const [donors,setDonors]=useState<Donor[]>([]);
  const [parts,setParts]=useState<Part[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [showVehicleForm,setShowVehicleForm]=useState(false);
  const [selectedOrder,setSelectedOrder]=useState<WorkOrderDetail|null>(null);
  const [lineType,setLineType]=useState<WorkOrderLine["lineType"]>("LABOR");
  const [lineDescription,setLineDescription]=useState("");
  const [lineQuantity,setLineQuantity]=useState("1");
  const [linePrice,setLinePrice]=useState("");
  const [lineCost,setLineCost]=useState("");
  const [showOrderForm,setShowOrderForm]=useState(false);
  const [showDonorForm,setShowDonorForm]=useState(false);
  const [showPartForm,setShowPartForm]=useState(false);
  const [partDonorId,setPartDonorId]=useState("");
  const [partName,setPartName]=useState("");
  const [partOem,setPartOem]=useState("");
  const [partCondition,setPartCondition]=useState("USED_B");
  const [partCost,setPartCost]=useState("");
  const [partPrice,setPartPrice]=useState("");

  const [vMake,setVMake]=useState("");
  const [vModel,setVModel]=useState("");
  const [vVin,setVVin]=useState("");
  const [vPlate,setVPlate]=useState("");
  const [vYear,setVYear]=useState("");
  const [vMileage,setVMileage]=useState("");

  const [orderVehicleId,setOrderVehicleId]=useState("");
  const [orderComplaint,setOrderComplaint]=useState("");
  const [orderPromise,setOrderPromise]=useState("");
  const [orderMileage,setOrderMileage]=useState("");
  const [orderBudget,setOrderBudget]=useState("");
  const [approvalEdit,setApprovalEdit]=useState(false);
  const [approvalRub,setApprovalRub]=useState("");
  const [approvalNote,setApprovalNote]=useState("");

  const [dMake,setDMake]=useState("");
  const [dModel,setDModel]=useState("");
  const [dVin,setDVin]=useState("");
  const [dYear,setDYear]=useState("");
  const [dPurchase,setDPurchase]=useState("");
  const [dDismantling,setDDismantling]=useState("");

  const load=useCallback(async()=>{
    setBusy(true); setError("");
    try{
      const [d,v,o,ds,ps]=await Promise.all([
        apiRequest<Dashboard>("/automotive/dashboard"),
        apiRequest<Vehicle[]>("/automotive/vehicles"),
        apiRequest<WorkOrder[]>("/automotive/work-orders"),
        apiRequest<Donor[]>("/automotive/donors").catch(()=>[]),
        apiRequest<Part[]>("/automotive/parts").catch(()=>[])
      ]);
      setDashboard(d); setVehicles(v); setOrders(o); setDonors(ds); setParts(ps);
      if(!orderVehicleId&&v[0]) setOrderVehicleId(v[0].id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить автомобильный контур");
    }finally{ setBusy(false); }
  },[orderVehicleId]);

  useEffect(()=>{void load();},[load]);

  const activeOrders=useMemo(
    ()=>orders.filter(item=>!["DELIVERED","CANCELLED"].includes(item.status)),
    [orders]
  );

  async function createVehicle(event:FormEvent){
    event.preventDefault(); setBusy(true); setError(""); setNotice("");
    try{
      await apiRequest("/automotive/vehicles",{
        method:"POST",
        body:JSON.stringify({
          make:vMake,model:vModel,vin:vVin||undefined,plateNumber:vPlate||undefined,
          productionYear:vYear?Number(vYear):undefined,
          mileageKm:vMileage?Number(vMileage):undefined
        })
      });
      setVMake("");setVModel("");setVVin("");setVPlate("");setVYear("");setVMileage("");
      setShowVehicleForm(false);setNotice("Автомобиль добавлен.");await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось добавить автомобиль");}
    finally{setBusy(false);}
  }

  async function createOrder(event:FormEvent){
    event.preventDefault(); if(!orderVehicleId)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/automotive/work-orders",{
        method:"POST",
        body:JSON.stringify({
          vehicleId:orderVehicleId,complaint:orderComplaint||undefined,
          promisedAt:orderPromise||undefined,
          mileageInKm:orderMileage?Number(orderMileage):undefined,
          authorizationLimitMinor:orderBudget?String(Math.round(Number(orderBudget.replace(",","."))*100)):undefined
        })
      });
      setOrderComplaint("");setOrderPromise("");setOrderMileage("");setOrderBudget("");
      setShowOrderForm(false);setNotice("Заказ-наряд создан.");await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось создать заказ-наряд");}
    finally{setBusy(false);}
  }

  async function openOrder(id:string){
    setBusy(true);setError("");
    try{
      const detail=await apiRequest<WorkOrderDetail>("/automotive/work-orders/"+id);
      setSelectedOrder(detail);
      setApprovalEdit(false);
      setApprovalRub(detail.authorization_limit_minor===null?""
        :String(Number(detail.authorization_limit_minor)/100));
      setApprovalNote("");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось открыть заказ-наряд");
    }finally{setBusy(false);}
  }

  async function saveCustomerApproval(event:FormEvent){
    event.preventDefault();
    if(!selectedOrder||busy)return;
    const amount=Number(approvalRub.replace(",","."));
    if(!Number.isFinite(amount)||amount<=0||amount>10_000_000_000){
      setError("Проверьте согласованную сумму");return;
    }
    if(approvalNote.trim().length<10){
      setError("Укажите основание изменения лимита не короче 10 символов");return;
    }
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/automotive/work-orders/"+selectedOrder.id,{
        method:"PATCH",body:JSON.stringify({
          authorizationLimitMinor:String(Math.round(amount*100)),
          authorizationNote:approvalNote.trim()
        })
      });
      setNotice("Лимит согласования обновлён, основание сохранено в журнале.");
      await openOrder(selectedOrder.id);
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось согласовать сумму");}
    finally{setBusy(false);}
  }

  function nextOrderStatus(status:string){
    return ({
      DRAFT:"DIAGNOSIS",
      DIAGNOSIS:"WAITING_APPROVAL",
      WAITING_APPROVAL:"IN_PROGRESS",
      WAITING_PARTS:"IN_PROGRESS",
      IN_PROGRESS:"QUALITY_CHECK",
      QUALITY_CHECK:"READY",
      READY:"DELIVERED"
    } as Record<string,string>)[status]??null;
  }

  async function advanceOrder(order:WorkOrder|WorkOrderDetail){
    const next=nextOrderStatus(order.status);
    if(!next)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/automotive/work-orders/"+order.id,{
        method:"PATCH",body:JSON.stringify({status:next})
      });
      setNotice("Заказ-наряд переведён: "+statusLabel(next)+".");
      await load();
      if(selectedOrder?.id===order.id) await openOrder(order.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось изменить этап ремонта");
    }finally{setBusy(false);}
  }

  async function setWaitingParts(order:WorkOrder|WorkOrderDetail){
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/automotive/work-orders/"+order.id,{
        method:"PATCH",body:JSON.stringify({status:"WAITING_PARTS"})
      });
      setNotice("Заказ-наряд переведён в ожидание запчастей.");
      await load();
      if(selectedOrder?.id===order.id) await openOrder(order.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось изменить этап ремонта");
    }finally{setBusy(false);}
  }

  async function addOrderLine(event:FormEvent){
    event.preventDefault();
    if(!selectedOrder||!lineDescription.trim())return;
    const quantity=Math.max(0.001,Number(lineQuantity||"1"));
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/automotive/work-orders/"+selectedOrder.id+"/lines",{
        method:"POST",
        body:JSON.stringify({
          lineType,description:lineDescription.trim(),
          quantityMilli:Math.round(quantity*1000).toString(),
          unitPriceMinor:Math.round(Number(linePrice||0)*100),
          unitCostMinor:Math.round(Number(lineCost||0)*100),
          approved:false
        })
      });
      setLineDescription("");setLineQuantity("1");setLinePrice("");setLineCost("");
      setNotice("Позиция добавлена в заказ-наряд.");
      await openOrder(selectedOrder.id);
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось добавить позицию");
    }finally{setBusy(false);}
  }

  async function updateLine(line:WorkOrderLine,action:"approve"|"complete"){
    if(!selectedOrder)return;
    setBusy(true);setError("");
    try{
      await apiRequest(
        "/automotive/work-orders/"+selectedOrder.id+"/lines/"+line.id,
        {
          method:"PATCH",
          body:JSON.stringify(
            action==="approve"
              ?{approved:true}
              :{approved:true,completed:true}
          )
        }
      );
      await openOrder(selectedOrder.id);
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось обновить позицию");
    }finally{setBusy(false);}
  }

  async function createDonor(event:FormEvent){
    event.preventDefault();setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/automotive/donors",{
        method:"POST",
        body:JSON.stringify({
          make:dMake,model:dModel,vin:dVin||undefined,
          productionYear:dYear?Number(dYear):undefined,
          purchasePriceMinor:dPurchase?Math.round(Number(dPurchase)*100):0,
          dismantlingCostMinor:dDismantling?Math.round(Number(dDismantling)*100):0
        })
      });
      setDMake("");setDModel("");setDVin("");setDYear("");setDPurchase("");setDDismantling("");
      setShowDonorForm(false);setNotice("Донор принят в разбор.");await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Не удалось добавить донора");}
    finally{setBusy(false);}
  }

  async function createPart(event:FormEvent){
    event.preventDefault();
    if(!partDonorId||!partName.trim())return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/automotive/donors/"+partDonorId+"/parts",{
        method:"POST",
        body:JSON.stringify({
          partName:partName.trim(),
          oemNumber:partOem.trim()||undefined,
          conditionGrade:partCondition,
          allocatedCostMinor:partCost?Math.round(Number(partCost)*100):0,
          askingPriceMinor:partPrice?Math.round(Number(partPrice)*100):0
        })
      });
      setPartName("");setPartOem("");setPartCost("");setPartPrice("");
      setShowPartForm(false);
      setNotice("Снятая деталь добавлена в авторазбор.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось добавить снятую деталь");
    }finally{setBusy(false);}
  }

  return (
    <main className="app-shell">
      <AppSidebar active="automotive" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero">
          <div>
            <span className="studio-eyebrow">Автобизнес / единый рабочий контур</span>
            <h1>Автосервис и авторазбор</h1>
            <p>
              От VIN и жалобы клиента до заказ-наряда, запчастей, донора,
              себестоимости и фактической маржи — без разрыва между сервисом и складом.
            </p>
          </div>
          <div className="studio-hero-actions">
            <button className="secondary-button" type="button"
              onClick={()=>setShowVehicleForm(v=>!v)}>+ Автомобиль</button>
            <button type="button" onClick={()=>setShowOrderForm(v=>!v)}>+ Заказ-наряд</button>
          </div>
        </header>

        {error?<div className="studio-message error"><strong>Нужно проверить</strong><span>{error}</span></div>:null}
        {notice?<div className="studio-message success"><strong>Готово</strong><span>{notice}</span></div>:null}

        <div className="studio-score-grid">
          <article><span>Заказ-наряды</span><strong>{dashboard?.orders.open_orders??0}</strong><p>{dashboard?.orders.waiting_parts??0} ждут запчасти · {dashboard?.orders.overdue??0} просрочено</p></article>
          <article><span>Выдано клиентам</span><strong>{money(dashboard?.orders.delivered_revenue_minor)}</strong><p>Фактическая сумма закрытых заказ-нарядов.</p></article>
          <article><span>Деньги в донорах</span><strong>{money(dashboard?.donors.invested_minor)}</strong><p>{dashboard?.donors.active_donors??0} доноров ещё в работе.</p></article>
          <article><span>Склад авторазбора</span><strong>{dashboard?.parts.available_parts??0}</strong><p>{money(dashboard?.parts.stock_cost_minor)} себестоимость · {money(dashboard?.parts.stock_asking_minor)} цена продажи</p></article>
        </div>

        {(showVehicleForm||showOrderForm||showDonorForm)?(
          <section className="studio-section">
            {showVehicleForm?(
              <form className="studio-form-grid" onSubmit={createVehicle}>
                <label><span>Марка</span><input value={vMake} onChange={e=>setVMake(e.target.value)} required placeholder="BMW" /></label>
                <label><span>Модель</span><input value={vModel} onChange={e=>setVModel(e.target.value)} required placeholder="X5" /></label>
                <label><span>VIN</span><input value={vVin} onChange={e=>setVVin(e.target.value.toUpperCase())} placeholder="17 символов" /></label>
                <label><span>Госномер</span><input value={vPlate} onChange={e=>setVPlate(e.target.value.toUpperCase())} /></label>
                <label><span>Год</span><input type="number" value={vYear} onChange={e=>setVYear(e.target.value)} /></label>
                <label><span>Пробег, км</span><input type="number" value={vMileage} onChange={e=>setVMileage(e.target.value)} /></label>
                <div className="studio-form-actions"><button type="submit" disabled={busy}>Сохранить автомобиль</button></div>
              </form>
            ):null}
            {showOrderForm?(
              <form className="studio-form-grid" onSubmit={createOrder}>
                <label className="studio-form-wide"><span>Автомобиль</span>
                  <select value={orderVehicleId} onChange={e=>setOrderVehicleId(e.target.value)} required>
                    <option value="">Выберите автомобиль</option>
                    {vehicles.map(v=><option key={v.id} value={v.id}>{v.make} {v.model}{v.plate_number?" · "+v.plate_number:""}{v.vin?" · "+v.vin:""}</option>)}
                  </select>
                </label>
                <label className="studio-form-wide"><span>Что беспокоит клиента</span><input value={orderComplaint} onChange={e=>setOrderComplaint(e.target.value)} placeholder="Стук спереди, заменить масло..." /></label>
                <label><span>Обещали к</span><input type="datetime-local" value={orderPromise} onChange={e=>setOrderPromise(e.target.value)} /></label>
                <label><span>Пробег при приёмке</span><input type="number" value={orderMileage} onChange={e=>setOrderMileage(e.target.value)} /></label>
                <label><span>Согласованный лимит, ₽</span><input type="number" min="0" step="0.01" value={orderBudget} onChange={e=>setOrderBudget(e.target.value)} placeholder="Например, 15000" /></label>
                <div className="studio-form-actions"><button type="submit" disabled={busy}>Создать заказ-наряд</button></div>
              </form>
            ):null}
            {showDonorForm?(
              <form className="studio-form-grid" onSubmit={createDonor}>
                <label><span>Марка донора</span><input value={dMake} onChange={e=>setDMake(e.target.value)} required /></label>
                <label><span>Модель</span><input value={dModel} onChange={e=>setDModel(e.target.value)} required /></label>
                <label><span>VIN</span><input value={dVin} onChange={e=>setDVin(e.target.value.toUpperCase())} /></label>
                <label><span>Год</span><input type="number" value={dYear} onChange={e=>setDYear(e.target.value)} /></label>
                <label><span>Цена покупки, ₽</span><input type="number" value={dPurchase} onChange={e=>setDPurchase(e.target.value)} /></label>
                <label><span>Стоимость разборки, ₽</span><input type="number" value={dDismantling} onChange={e=>setDDismantling(e.target.value)} /></label>
                <div className="studio-form-actions"><button type="submit" disabled={busy}>Принять донора</button></div>
              </form>
            ):null}
          </section>
        ):null}

        <div className="studio-tabs">
          <button className={tab==="orders"?"active":""} type="button" onClick={()=>setTab("orders")}>Заказ-наряды <span>{activeOrders.length}</span></button>
          <button className={tab==="vehicles"?"active":""} type="button" onClick={()=>setTab("vehicles")}>Автомобили <span>{vehicles.length}</span></button>
          <button className={tab==="dismantling"?"active":""} type="button" onClick={()=>setTab("dismantling")}>Авторазбор <span>{donors.length}</span></button>
        </div>

        {tab==="orders"&&selectedOrder?(
          <section className="studio-section">
            <div className="studio-section-head">
              <div>
                <span>{selectedOrder.business_number} · {statusLabel(selectedOrder.status)}</span>
                <h2>{selectedOrder.make} {selectedOrder.model}</h2>
                <p>
                  {selectedOrder.plate_number??selectedOrder.vin??"Без номера"}
                  {selectedOrder.customer_name?" · "+selectedOrder.customer_name:""}
                </p>
              </div>
              <div className="studio-card-actions">
                {nextOrderStatus(selectedOrder.status)?(
                  <button type="button" onClick={()=>void advanceOrder(selectedOrder)} disabled={busy}>
                    {statusLabel(nextOrderStatus(selectedOrder.status)!)} →
                  </button>
                ):null}
                <button className="secondary-button" type="button" onClick={()=>setSelectedOrder(null)}>Закрыть</button>
              </div>
            </div>

            <div className="studio-score-grid">
              <article><span>Согласовано</span><strong>{money(selectedOrder.approved_total_minor)}</strong>
                <p>Сумма утверждённых работ и деталей.</p></article>
              <article><span>Выполнено</span><strong>{money(selectedOrder.actual_total_minor)}</strong><p>Фактически выполненные позиции.</p></article>
              <article><span>Приёмка</span><strong>{selectedOrder.mileage_in_km??"—"}</strong><p>Пробег при заезде, км.</p></article>
              <article><span>Позиций</span><strong>{selectedOrder.lines.length}</strong><p>Работы, детали и расходные материалы.</p></article>
            </div>

            <div className="studio-message" role="status">
              <strong>Лимит согласования клиента</strong>
              <span>{selectedOrder.authorization_limit_minor!==null
                ?money(selectedOrder.authorization_limit_minor)
                :"Не указан — необходимо зафиксировать согласованный бюджет"}
                {selectedOrder.authorization_limit_minor!==null
                  ?" · Доступно ещё "+money(Math.max(0,Number(selectedOrder.authorization_limit_minor)-
                    Number(selectedOrder.approved_total_minor)))
                  :""}
              </span>
            </div>
            {!["DELIVERED","CANCELLED"].includes(selectedOrder.status)?(
              <div className="studio-card">
                <button className="secondary-button" type="button"
                  onClick={()=>setApprovalEdit(value=>!value)}>
                  {approvalEdit?"Скрыть изменение лимита":"Изменить согласованный бюджет"}
                </button>
                {approvalEdit?(
                  <form onSubmit={saveCustomerApproval} className="studio-form-grid">
                    <label><span>Новый лимит клиента, ₽</span>
                      <input type="number" min="0.01" step="0.01" required
                        value={approvalRub} onChange={event=>setApprovalRub(event.target.value)}/>
                    </label>
                    <label className="studio-form-wide"><span>Основание согласования</span>
                      <input required minLength={10} value={approvalNote}
                        onChange={event=>setApprovalNote(event.target.value)}
                        placeholder="Например: согласовано с владельцем автомобиля по телефону"/>
                    </label>
                    <div className="studio-form-actions">
                      <button type="submit" disabled={busy}>Подтвердить новый лимит</button>
                    </div>
                  </form>
                ):null}
              </div>
            ):null}
            <div className="studio-rule-grid">
              {selectedOrder.lines.map(line=>(
                <article className="studio-rule-card" key={line.id}>
                  <header>
                    <div>
                      <span className="studio-chip">
                        {line.lineType} · {line.completed?"Выполнено":line.approved?"Согласовано":"На согласовании"}
                      </span>
                      <h3>{line.description}</h3>
                      <p>{Number(line.quantityMilli)/1000} × {money(line.unitPriceMinor)}</p>
                    </div>
                    <strong>{money(Math.round(Number(line.unitPriceMinor)*Number(line.quantityMilli)/1000))}</strong>
                  </header>
                  <footer>
                    {!line.approved?(
                      <button className="secondary-button" type="button" onClick={()=>void updateLine(line,"approve")} disabled={busy}>Согласовать</button>
                    ):null}
                    {!line.completed?(
                      <button type="button" onClick={()=>void updateLine(line,"complete")} disabled={busy}>Выполнено</button>
                    ):null}
                  </footer>
                </article>
              ))}
            </div>

            <form className="studio-form-grid" onSubmit={addOrderLine}>
              <label><span>Тип</span>
                <select value={lineType} onChange={e=>setLineType(e.target.value as WorkOrderLine["lineType"])}>
                  <option value="LABOR">Работа</option>
                  <option value="PART">Запчасть</option>
                  <option value="MATERIAL">Расходник</option>
                  <option value="OTHER">Другое</option>
                </select>
              </label>
              <label className="studio-form-wide"><span>Что делаем / что ставим</span><input value={lineDescription} onChange={e=>setLineDescription(e.target.value)} required placeholder="Замена масла / фильтр / рычаг..." /></label>
              <label><span>Количество</span><input type="number" min="0.001" step="0.001" value={lineQuantity} onChange={e=>setLineQuantity(e.target.value)} /></label>
              <label><span>Цена клиенту, ₽</span><input type="number" min="0" value={linePrice} onChange={e=>setLinePrice(e.target.value)} /></label>
              <label><span>Себестоимость, ₽</span><input type="number" min="0" value={lineCost} onChange={e=>setLineCost(e.target.value)} /></label>
              <div className="studio-form-actions"><button type="submit" disabled={busy}>Добавить позицию</button></div>
            </form>
          </section>
        ):null}

        {tab==="orders"?(
          <section className="studio-section">
            <div className="studio-section-head"><div><span>Приёмка → диагностика → ремонт → выдача</span><h2>Заказ-наряды</h2><p>Видно, где автомобиль завис и чего ждёт.</p></div></div>
            <div className="studio-rule-grid">
              {orders.map(o=>(
                <article className="studio-rule-card" key={o.id}>
                  <header><div><span className="studio-chip">{statusLabel(o.status)}</span><h3>{o.business_number} · {o.make} {o.model}</h3><p>{o.plate_number??o.vin??"Без номера"}{o.customer_name?" · "+o.customer_name:""}</p></div><strong>{money(o.estimated_total_minor)}</strong></header>
                  <div><p>{o.complaint||"Жалоба клиента не указана"}</p><p className="muted">{o.line_count} позиций{ o.promised_at?" · обещано "+new Date(o.promised_at).toLocaleString("ru-RU"):""}</p></div>
                  <footer>
                    <button className="secondary-button" type="button" onClick={()=>void openOrder(o.id)} disabled={busy}>Открыть</button>
                    {["DIAGNOSIS","WAITING_APPROVAL","IN_PROGRESS"].includes(o.status)?(
                      <button className="secondary-button" type="button" onClick={()=>void setWaitingParts(o)} disabled={busy}>Ждём детали</button>
                    ):null}
                    {nextOrderStatus(o.status)?(
                      <button type="button" onClick={()=>void advanceOrder(o)} disabled={busy}>
                        {statusLabel(nextOrderStatus(o.status)!)} →
                      </button>
                    ):null}
                  </footer>
                </article>
              ))}
              {!orders.length&&!busy?<div className="studio-empty"><span>01</span><strong>Нет заказ-нарядов</strong><p>Создайте первый заказ-наряд после приёмки автомобиля.</p></div>:null}
            </div>
          </section>
        ):null}

        {tab==="vehicles"?(
          <section className="studio-section">
            <div className="studio-section-head"><div><span>История автомобиля</span><h2>Автомобили клиентов</h2><p>VIN, пробег и вся история работ в одной карточке.</p></div></div>
            <div className="studio-rule-grid">
              {vehicles.map(v=>(
                <article className="studio-rule-card" key={v.id}>
                  <header><div><span className="studio-chip">{v.production_year??"Год не указан"}</span><h3>{v.make} {v.model}</h3><p>{v.plate_number??"Без госномера"}{v.vin?" · "+v.vin:""}</p></div><strong>{v.mileage_km?new Intl.NumberFormat("ru-RU").format(v.mileage_km)+" км":"—"}</strong></header>
                  <div><p>{v.owner_name??"Владелец не привязан"}</p><p className="muted">{v.last_visit_at?"Последний визит "+new Date(v.last_visit_at).toLocaleDateString("ru-RU"):"Истории обслуживания пока нет"}</p></div>
                </article>
              ))}
            </div>
          </section>
        ):null}

        {tab==="dismantling"?(
          <>
            <section className="studio-section">
              <div className="studio-section-head">
                <div><span>Донор → детали → деньги</span><h2>Авторазбор</h2><p>Каждый донор как отдельный инвестиционный объект.</p></div>
                <div className="studio-card-actions">
                  <button className="secondary-button" type="button" onClick={()=>setShowPartForm(v=>!v)}>+ Снятая деталь</button>
                  <button type="button" onClick={()=>setShowDonorForm(v=>!v)}>+ Принять донора</button>
                </div>
              </div>
              {showPartForm?(
                <form className="studio-form-grid" onSubmit={createPart}>
                  <label className="studio-form-wide"><span>Донор</span>
                    <select value={partDonorId} onChange={e=>setPartDonorId(e.target.value)} required>
                      <option value="">Выберите донора</option>
                      {donors.map(d=>(
                        <option key={d.id} value={d.id}>
                          {d.stock_number} · {d.make} {d.model}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="studio-form-wide"><span>Деталь</span><input value={partName} onChange={e=>setPartName(e.target.value)} required placeholder="Фара левая / двигатель / дверь..." /></label>
                  <label><span>OEM номер</span><input value={partOem} onChange={e=>setPartOem(e.target.value)} placeholder="Оригинальный номер" /></label>
                  <label><span>Состояние</span>
                    <select value={partCondition} onChange={e=>setPartCondition(e.target.value)}>
                      <option value="USED_A">A · отличное</option>
                      <option value="USED_B">B · хорошее</option>
                      <option value="USED_C">C · с дефектами</option>
                      <option value="FOR_REPAIR">Под ремонт</option>
                      <option value="SCRAP">Утиль</option>
                    </select>
                  </label>
                  <label><span>Себестоимость, ₽</span><input type="number" min="0" value={partCost} onChange={e=>setPartCost(e.target.value)} /></label>
                  <label><span>Цена продажи, ₽</span><input type="number" min="0" value={partPrice} onChange={e=>setPartPrice(e.target.value)} /></label>
                  <div className="studio-form-actions"><button type="submit" disabled={busy}>Добавить деталь</button></div>
                </form>
              ):null}
              <div className="studio-rule-grid">
                {donors.map(d=>(
                  <article className="studio-rule-card" key={d.id}>
                    <header><div><span className="studio-chip">{statusLabel(d.status)}</span><h3>{d.stock_number} · {d.make} {d.model}</h3><p>{d.vin??"VIN не указан"}{d.production_year?" · "+d.production_year:""}</p></div><strong>{money(Number(d.purchase_price_minor)+Number(d.dismantling_cost_minor))}</strong></header>
                    <div><p>{d.parts_available} из {d.parts_total} деталей доступны</p><p className="muted">Распределено себестоимости {money(d.allocated_cost_minor)} · цена остатка {money(d.remaining_asking_minor)}</p></div>
                    <footer>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={()=>{
                          setPartDonorId(d.id);
                          setShowPartForm(true);
                        }}
                      >
                        + Снятая деталь
                      </button>
                    </footer>
                  </article>
                ))}
              </div>
            </section>
            <section className="studio-section">
              <div className="studio-section-head"><div><span>Снятые детали</span><h2>Детали в продаже</h2><p>OEM, состояние, донор и экономика каждой позиции.</p></div></div>
              <div className="studio-rule-grid">
                {parts.slice(0,24).map(p=>(
                  <article className="studio-rule-card" key={p.id}>
                    <header><div><span className="studio-chip">{statusLabel(p.status)} · {p.condition_grade}</span><h3>{p.part_name}</h3><p>{p.oem_number?"OEM "+p.oem_number+" · ":""}{p.stock_number} · {p.donor_make} {p.donor_model}</p></div><strong>{money(p.asking_price_minor)}</strong></header>
                    <div><p className="muted">Себестоимость {money(p.allocated_cost_minor)}{p.sku_code?" · SKU "+p.sku_code:""}</p></div>
                  </article>
                ))}
              </div>
            </section>
          </>
        ):null}
      </section>
    </main>
  );
}
