"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../components/app-sidebar";
import {apiRequest} from "../../../lib/api";

type Warehouse={id:string;name:string;code:string};
type Owner={id:string;name:string;code:string;owner_type:string;status:string};
type Purchase={id:string;number:string;status:string;inventoryOwnerId:string;inventoryOwnerName:string};
type Asn={
  id:string;warehouse_id:string;warehouse_name:string;owner_id:string;owner_name:string;
  purchase_order_id:string|null;purchase_order_number:string|null;external_reference:string|null;
  status:string;expected_from:string|null;expected_to:string|null;vehicle_plate:string|null;
  carrier_name:string|null;lines:number;expected_quantity_milli:string;received_quantity_milli:string;
};
type Topology={locations:Array<{id:string;full_code:string;location_type:string;status:string}>};
type Detail={
  asn:any;
  lines:Array<{id:string;sku_code:string;product_name:string;expected_quantity_milli:string;received_quantity_milli:string}>;
  appointments:Array<{
    id:string;dock_location_id:string;dock_code:string;scheduled_from:string;scheduled_to:string;
    status:string;driver_name:string|null;vehicle_plate:string|null;
  }>;
};

function qty(v:string){
  return (Number(v)/1000).toLocaleString("ru-RU",{maximumFractionDigits:3});
}

export default function WmsInboundPage(){
  const [warehouses,setWarehouses]=useState<Warehouse[]>([]);
  const [owners,setOwners]=useState<Owner[]>([]);
  const [purchases,setPurchases]=useState<Purchase[]>([]);
  const [warehouseId,setWarehouseId]=useState("");
  const [rows,setRows]=useState<Asn[]>([]);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [docks,setDocks]=useState<Topology["locations"]>([]);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState("");

  const loadMaster=useCallback(async()=>{
    try{
      const [w,o,p]=await Promise.all([
        apiRequest<Warehouse[]>("/wms/warehouses"),
        apiRequest<Owner[]>("/wms/owners"),
        apiRequest<Purchase[]>("/procurement/orders")
      ]);
      setWarehouses(w);
      setOwners(o.filter(x=>x.status==="ACTIVE"));
      setPurchases(p.filter(x=>["CONFIRMED","PARTIALLY_RECEIVED"].includes(x.status)));
      setWarehouseId(current=>current||w[0]?.id||"");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить inbound workspace");
    }
  },[]);

  const loadInbound=useCallback(async(id:string)=>{
    if(!id){setRows([]);setDocks([]);return;}
    try{
      const [a,t]=await Promise.all([
        apiRequest<Asn[]>("/wms/inbound/asn?warehouseId="+encodeURIComponent(id)),
        apiRequest<Topology>("/wms/warehouses/"+id+"/topology")
      ]);
      setRows(a);
      setDocks(t.locations.filter(x=>x.location_type==="DOCK"&&x.status==="ACTIVE"));
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить входящие поставки");
    }
  },[]);

  useEffect(()=>{void loadMaster();},[loadMaster]);
  useEffect(()=>{void loadInbound(warehouseId);},[warehouseId,loadInbound]);

  async function open(id:string){
    try{
      setDetail(await apiRequest<Detail>("/wms/inbound/asn/"+id));
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось открыть ASN");
    }
  }

  async function createAsn(){
    if(!warehouseId)return;
    const candidates=purchases.filter(p=>p.inventoryOwnerId);
    if(!candidates.length){
      setError("Нет подтверждённых закупок для ASN.");
      return;
    }

    const list=candidates.slice(0,30).map((p,i)=>
      (i+1)+". "+p.number+" · "+p.inventoryOwnerName+" · "+p.status
    ).join("\n");
    const index=Number(window.prompt("Выберите Purchase Order:\n"+list,"1"))-1;
    const po=candidates[index];
    if(!po)return;

    const ref=window.prompt("Внешний номер ASN / поставки","ASN-"+po.number)??"";
    const plate=window.prompt("Госномер машины (необязательно)","")??"";
    const carrier=window.prompt("Перевозчик (необязательно)","")??"";

    setBusy("create");setError("");
    try{
      const result=await apiRequest<{id:string}>("/wms/inbound/asn",{
        method:"POST",
        body:JSON.stringify({
          warehouseId,
          ownerId:po.inventoryOwnerId,
          purchaseOrderId:po.id,
          externalReference:ref.trim()||undefined,
          vehiclePlate:plate.trim()||undefined,
          carrierName:carrier.trim()||undefined
        })
      });
      await loadInbound(warehouseId);
      await open(result.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать ASN");
    }finally{setBusy("");}
  }

  async function schedule(){
    if(!detail)return;
    if(!docks.length){
      setError("На складе нет активной локации типа DOCK.");
      return;
    }

    const dockList=docks.map((d,i)=>(i+1)+". "+d.full_code).join("\n");
    const dockIndex=Number(window.prompt("Выберите док:\n"+dockList,"1"))-1;
    const dock=docks[dockIndex];
    if(!dock)return;

    const defaultFrom=new Date(Date.now()+3600000);
    defaultFrom.setMinutes(Math.ceil(defaultFrom.getMinutes()/30)*30,0,0);
    const local=(date:Date)=>{
      const offset=date.getTimezoneOffset()*60000;
      return new Date(date.getTime()-offset).toISOString().slice(0,16);
    };
    const fromRaw=window.prompt("Начало окна YYYY-MM-DDTHH:mm",local(defaultFrom));
    if(!fromRaw)return;
    const toDate=new Date(fromRaw);
    toDate.setHours(toDate.getHours()+1);
    const toRaw=window.prompt("Конец окна YYYY-MM-DDTHH:mm",local(toDate));
    if(!toRaw)return;

    try{
      await apiRequest("/wms/inbound/asn/"+detail.asn.id+"/schedule",{
        method:"POST",
        body:JSON.stringify({
          dockLocationId:dock.id,
          scheduledFrom:new Date(fromRaw).toISOString(),
          scheduledTo:new Date(toRaw).toISOString(),
          vehiclePlate:detail.asn.vehicle_plate??undefined
        })
      });
      await loadInbound(warehouseId);
      await open(detail.asn.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось назначить док");
    }
  }

  async function action(id:string,action:"CHECK_IN"|"START"|"COMPLETE"|"NO_SHOW"|"CANCEL"){
    setBusy(id);setError("");
    try{
      await apiRequest("/wms/inbound/appointments/"+id+"/action",{
        method:"POST",
        body:JSON.stringify({action})
      });
      if(detail)await open(detail.asn.id);
      await loadInbound(warehouseId);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось изменить состояние окна");
    }finally{setBusy("");}
  }

  const selectedWarehouse=useMemo(
    ()=>warehouses.find(w=>w.id===warehouseId),
    [warehouses,warehouseId]
  );

  return (
    <main className="app-shell">
      <AppSidebar active="wms-inbound"/>
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">WMS / Inbound</p>
            <h1>Ожидаемые поставки и доки</h1>
            <p className="workspace-summary">
              ASN планирует поток и окно разгрузки. Фактический остаток меняется только после Goods Receipt.
            </p>
          </div>
          <div className="header-actions">
            <select value={warehouseId} onChange={e=>setWarehouseId(e.target.value)}>
              {warehouses.map(w=><option key={w.id} value={w.id}>{w.name} · {w.code}</option>)}
            </select>
            <button disabled={busy!==""||!warehouseId} onClick={()=>void createAsn()}>
              + ASN
            </button>
          </div>
        </header>

        {error?<div className="inline-error"><strong>Inbound</strong><span>{error}</span></div>:null}

        <div className="owner-kpi-grid">
          <article className="owner-kpi">
            <span>Склад</span><strong>{selectedWarehouse?.name??"—"}</strong>
          </article>
          <article className="owner-kpi">
            <span>Ожидается ASN</span>
            <strong>{rows.filter(x=>!["RECEIVED","CANCELLED"].includes(x.status)).length}</strong>
          </article>
          <article className="owner-kpi">
            <span>Доков доступно</span><strong>{docks.length}</strong>
          </article>
          <article className="owner-kpi">
            <span>К приёмке, ед.</span>
            <strong>{qty(rows.reduce((sum,row)=>
              sum+BigInt(row.expected_quantity_milli)-BigInt(row.received_quantity_milli),0n
            ).toString())}</strong>
          </article>
        </div>

        <div className="inbound-layout">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>ASN</th><th>Владелец</th><th>PO</th><th>Статус</th>
                  <th>Ожидается / принято</th><th>Окно</th><th/>
                </tr>
              </thead>
              <tbody>{rows.map(row=>(
                <tr key={row.id}>
                  <td>
                    <strong>{row.external_reference??row.id.slice(0,8)}</strong>
                    <small>{row.carrier_name??"без перевозчика"}{row.vehicle_plate?" · "+row.vehicle_plate:""}</small>
                  </td>
                  <td>{row.owner_name}</td>
                  <td>{row.purchase_order_number??"—"}</td>
                  <td><span className="status-pill">{row.status}</span></td>
                  <td>{qty(row.expected_quantity_milli)} / {qty(row.received_quantity_milli)}</td>
                  <td>
                    {row.expected_from
                      ? new Date(row.expected_from).toLocaleString("ru-RU")
                      : "не назначено"}
                  </td>
                  <td className="table-actions">
                    <button className="secondary-button" onClick={()=>void open(row.id)}>Открыть</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          {detail?<aside className="inbound-panel">
            <header>
              <div>
                <small>ASN</small>
                <strong>{detail.asn.external_reference??detail.asn.id.slice(0,8)}</strong>
                <span>{detail.asn.status}</span>
              </div>
              <button className="secondary-button" onClick={()=>setDetail(null)}>×</button>
            </header>

            <section>
              <div className="section-heading">
                <div><p className="muted">План</p><h3>Позиции</h3></div>
                {!["RECEIVED","CANCELLED"].includes(detail.asn.status)?
                  <button onClick={()=>void schedule()}>Назначить док</button>:null}
              </div>
              <div className="inbound-lines">
                {detail.lines.map(line=>(
                  <article key={line.id}>
                    <div><strong>{line.product_name}</strong><span>{line.sku_code}</span></div>
                    <b>{qty(line.received_quantity_milli)} / {qty(line.expected_quantity_milli)}</b>
                  </article>
                ))}
              </div>
            </section>

            <section>
              <div className="section-heading"><div><p className="muted">Dock</p><h3>Окна</h3></div></div>
              <div className="inbound-appointments">
                {detail.appointments.map(a=>(
                  <article key={a.id}>
                    <div>
                      <strong>{a.dock_code}</strong>
                      <span>
                        {new Date(a.scheduled_from).toLocaleString("ru-RU")} —{" "}
                        {new Date(a.scheduled_to).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}
                      </span>
                    </div>
                    <span className="status-pill">{a.status}</span>
                    <div className="table-actions">
                      {a.status==="SCHEDULED"?<>
                        <button onClick={()=>void action(a.id,"CHECK_IN")} disabled={busy===a.id}>Прибыл</button>
                        <button className="secondary-button" onClick={()=>void action(a.id,"NO_SHOW")}>Не приехал</button>
                      </>:null}
                      {a.status==="CHECKED_IN"?
                        <button onClick={()=>void action(a.id,"START")} disabled={busy===a.id}>Начать разгрузку</button>:null}
                      {a.status==="IN_SERVICE"?
                        <button onClick={()=>void action(a.id,"COMPLETE")} disabled={busy===a.id}>Завершить док</button>:null}
                    </div>
                  </article>
                ))}
                {!detail.appointments.length?<div className="table-empty"><strong>Окно не назначено</strong><span>Выберите активный DOCK и время.</span></div>:null}
              </div>
            </section>
          </aside>:null}
        </div>
      </section>
    </main>
  );
}
