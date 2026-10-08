"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Warehouse = { id:string; name:string; code:string; owner_tracking_state?:string };
type Owner = {
  id:string; code:string; name:string; owner_type:"INTERNAL"|"CLIENT";
  is_default:boolean; status:string; party_id:string|null; party_name:string|null;
};
type Reconciliation = {
  warehouseId:string; ownerTrackingState:string; reconciled:boolean;
  aggregateMismatch:number; locationMismatch:number;
  aggregate:Array<{
    sku_id:string; sku_code:string;
    aggregate_physical_milli:string; owner_physical_milli:string;
    physical_difference_milli:string; aggregate_reserved_milli:string;
    owner_reserved_milli:string; reserved_difference_milli:string;
  }>;
  locations:Array<{
    location_id:string;full_code:string;sku_code:string;
    aggregate_milli:string;owner_milli:string;difference_milli:string;
  }>;
};
function qty(value:string){return (Number(value)/1000).toLocaleString("ru-RU",{maximumFractionDigits:3});}

export default function WmsOwnersPage(){
  const [warehouses,setWarehouses]=useState<Warehouse[]>([]);
  const [warehouseId,setWarehouseId]=useState("");
  const [owners,setOwners]=useState<Owner[]>([]);
  const [check,setCheck]=useState<Reconciliation|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);

  const load=useCallback(async()=>{
    try{
      const [w,o]=await Promise.all([
        apiRequest<Warehouse[]>("/wms/warehouses"),
        apiRequest<Owner[]>("/wms/owners")
      ]);
      setWarehouses(w);setOwners(o);
      setWarehouseId(current=>current||w[0]?.id||"");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить владельцев");}
  },[]);

  const reconcile=useCallback(async(id:string)=>{
    if(!id){setCheck(null);return;}
    try{
      setCheck(await apiRequest<Reconciliation>(
        "/wms/warehouses/"+id+"/owner-reconciliation"
      ));
    }catch(e){
      setCheck(null);
      setError(e instanceof Error?e.message:"Сверка недоступна");
    }
  },[]);

  useEffect(()=>{void load();},[load]);
  useEffect(()=>{void reconcile(warehouseId);},[warehouseId,reconcile]);

  async function initialize(){
    if(!warehouseId||busy)return;
    if(!window.confirm(
      "Инициализировать учёт по владельцам? Перед включением требуется сверка общего и адресного остатков. Операция не меняет историю складских движений."
    ))return;
    setBusy(true);setError("");
    try{
      const result=await apiRequest<{initialized:boolean;skuCount:number;locationRows:number}>(
        "/wms/warehouses/"+warehouseId+"/owner-ledger/initialize",{method:"POST"}
      );
      window.alert(result.initialized
        ?"Учёт включён. SKU: "+result.skuCount+"; ячеек: "+result.locationRows
        :"Учёт по владельцам уже включён.");
      await reconcile(warehouseId);
    }catch(e){setError(e instanceof Error?e.message:"Инициализация не выполнена");}
    finally{setBusy(false);}
  }

  async function createOwner(){
    const partyId=window.prompt("UUID организации-клиента из CRM");
    if(!partyId?.trim())return;
    const code=window.prompt("Код владельца");
    if(!code?.trim())return;
    const name=window.prompt("Название владельца (необязательно)")??"";
    setBusy(true);setError("");
    try{
      await apiRequest("/wms/owners",{
        method:"POST",
        body:JSON.stringify({partyId:partyId.trim(),code:code.trim(),name:name.trim()})
      });
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось добавить владельца");}
    finally{setBusy(false);}
  }

  async function activateContract(owner:Owner){
    if(!warehouseId||owner.owner_type!=="CLIENT")return;
    if(!window.confirm("Активировать договор хранения для "+owner.name+" на выбранном складе?"))return;
    setBusy(true);setError("");
    try{
      await apiRequest(
        "/wms/warehouses/"+warehouseId+"/3pl/"+owner.id,
        {method:"PUT",body:JSON.stringify({status:"ACTIVE",services:{},billingRules:{}})}
      );
      window.alert("Договор активирован. Тарифы и услуги 3PL требуется настроить отдельно.");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось активировать договор");}
    finally{setBusy(false);}
  }

  const aggregateProblems=check?.aggregate.filter(row=>
    row.physical_difference_milli!=="0"||row.reserved_difference_milli!=="0")??[];
  const locationProblems=check?.locations.filter(row=>row.difference_milli!=="0")??[];

  return (
    <main className="app-shell">
      <AppSidebar active="wms" />
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Склад / 3PL</p>
            <h1>Владельцы товара</h1>
            <p className="workspace-summary">
              Собственные и клиентские запасы разделены по владельцам.
              Проверяйте сверку до выполнения 3PL-операций.
            </p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={()=>void load()} disabled={busy}>Обновить</button>
            <button onClick={()=>void createOwner()} disabled={busy}>+ Владелец</button>
          </div>
        </header>
        {error?<div className="inline-error"><strong>Ошибка</strong><span>{error}</span></div>:null}
        <section className="section-block">
          <div className="section-heading"><div><p className="muted">Контроль склада</p><h2>Сверка владельцев</h2></div></div>
          <div className="header-actions">
            <select value={warehouseId} onChange={e=>setWarehouseId(e.target.value)}>
              {warehouses.map(w=><option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}
            </select>
            <button type="button" className="secondary-button" onClick={()=>void reconcile(warehouseId)}>Проверить</button>
            <button type="button" disabled={busy||check?.ownerTrackingState==="OWNER_LEDGER"} onClick={()=>void initialize()}>
              Включить учёт по владельцам
            </button>
          </div>
          {check?<div className="owner-kpi-grid">
            <article className="owner-kpi"><span>Режим</span><strong>{check.ownerTrackingState}</strong></article>
            <article className="owner-kpi"><span>Результат сверки</span><strong>{check.reconciled?"Совпадает":"Есть расхождения"}</strong></article>
            <article className="owner-kpi"><span>Расхождения остатков</span><strong>{check.aggregateMismatch}</strong></article>
            <article className="owner-kpi"><span>Расхождения по ячейкам</span><strong>{check.locationMismatch}</strong></article>
          </div>:null}
          {check&&!check.reconciled&&check.ownerTrackingState==="OWNER_LEDGER"?
            <div className="inline-error"><strong>Операции требуют проверки</strong>
              <span>Субрегистр владельцев не сходится с общим учётом. Не корректируйте цифры вручную.</span>
            </div>:null}
        </section>
        <section className="section-block">
          <div className="section-heading"><div><p className="muted">3PL / Договоры</p><h2>Справочник владельцев</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Владелец</th><th>Тип</th><th>Статус</th><th>Клиент CRM</th><th>Действие</th></tr></thead>
              <tbody>{owners.map(o=><tr key={o.id}>
                <td><strong>{o.name}</strong><small>{o.code}</small></td>
                <td>{o.owner_type==="INTERNAL"?"Собственный товар":"3PL-клиент"}</td>
                <td>{o.status}</td><td>{o.party_name??"—"}</td>
                <td>{o.owner_type==="CLIENT"?
                  <button className="secondary-button" disabled={busy||!warehouseId} onClick={()=>void activateContract(o)}>Активировать договор</button>
                  :"По умолчанию"}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </section>
        {(aggregateProblems.length>0||locationProblems.length>0)&&
          <section className="section-block">
            <div className="section-heading"><div><h2>Расхождения для расследования</h2></div></div>
            <div className="data-table-wrap"><table className="data-table">
              <thead><tr><th>Место / SKU</th><th>Общий остаток</th><th>По владельцам</th><th>Разница</th></tr></thead>
              <tbody>
                {aggregateProblems.map(x=><tr key={"a:"+x.sku_id}>
                  <td>{x.sku_code} · склад</td><td>{qty(x.aggregate_physical_milli)}</td>
                  <td>{qty(x.owner_physical_milli)}</td><td>{qty(x.physical_difference_milli)}</td>
                </tr>)}
                {locationProblems.map(x=><tr key={"l:"+x.location_id+":"+x.sku_code}>
                  <td>{x.full_code} · {x.sku_code}</td><td>{qty(x.aggregate_milli)}</td>
                  <td>{qty(x.owner_milli)}</td><td>{qty(x.difference_milli)}</td>
                </tr>)}
              </tbody>
            </table></div>
          </section>}
      </section>
    </main>
  );
}
