"use client";

import { useEffect, useMemo, useState } from "react";

type ApiResponse<T> =
  | {ok:true;data:T}
  | {ok:false;error:{message:string}};

type Overview = {
  owner:{id:string;code:string;name:string;status:string};
  balances:Array<{
    warehouse_name:string;
    sku_code:string;
    product_name:string;
    physical_milli:string;
    reserved_milli:string;
    available_milli:string;
  }>;
  locations:Array<{
    warehouse_name:string;
    full_code:string;
    sku_code:string;
    product_name:string;
    physical_milli:string;
  }>;
  movements:Array<{
    id:string;
    warehouse_name:string;
    sku_code:string;
    product_name:string;
    movement_type:string;
    physical_delta_milli:string;
    reserved_delta_milli:string;
    source_type:string;
    created_at:string;
  }>;
  orders:Array<{
    id:string;
    business_number:string;
    order_status:string;
    payment_status:string;
    fulfillment_status:string;
    total_minor:string;
    currency:string;
    created_at:string;
  }>;
  statements:Array<{
    id:string;
    warehouse_name:string;
    period_from:string;
    period_to:string;
    currency:string;
    total_minor:string;
    finalized_at:string;
  }>;
};

type ClientRequest = {
  id:string;
  request_number:string;
  request_type:string;
  priority:string;
  status:string;
  subject:string;
  sla_due_at:string;
  first_response_at:string|null;
  resolved_at:string|null;
  created_at:string;
};

const API_URL=process.env.NEXT_PUBLIC_API_URL??"/api/v1";

function qty(value:string){
  return (Number(value)/1000).toLocaleString("ru-RU",{maximumFractionDigits:3});
}
function money(value:string,currency:string){
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency,maximumFractionDigits:2
  }).format(Number(value)/100);
}

export default function ThreePlPortalPage(){
  const [token,setToken]=useState("");
  const [data,setData]=useState<Overview|null>(null);
  const [error,setError]=useState("");
  const [tab,setTab]=useState<"stock"|"locations"|"movements"|"orders"|"billing"|"requests">("stock");
  const [busy,setBusy]=useState(false);
  const [requests,setRequests]=useState<ClientRequest[]>([]);

  useEffect(()=>{
    const saved=sessionStorage.getItem("corebiz_3pl_token");
    if(saved){
      setToken(saved);
      void load(saved);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[]);

  async function load(value=token){
    const normalized=value.trim();
    if(!normalized)return;

    setBusy(true);
    setError("");
    try{
      const response=await fetch(API_URL+"/wms/3pl-portal/public/overview",{
        headers:{Authorization:"Bearer "+normalized},
        cache:"no-store"
      });
      const payload=(await response.json()) as ApiResponse<Overview>;
      if(!payload.ok)throw new Error(payload.error.message);
      setData(payload.data);

      const requestsResponse=await fetch(
        API_URL+"/wms/3pl-requests/public/list",
        {
          headers:{Authorization:"Bearer "+normalized},
          cache:"no-store"
        }
      );
      const requestsPayload=(await requestsResponse.json()) as ApiResponse<ClientRequest[]>;
      if(requestsPayload.ok)setRequests(requestsPayload.data);

      sessionStorage.setItem("corebiz_3pl_token",normalized);
    }catch(cause){
      setData(null);
      sessionStorage.removeItem("corebiz_3pl_token");
      setError(cause instanceof Error?cause.message:"Доступ не выполнен");
    }finally{
      setBusy(false);
    }
  }

  function logout(){
    sessionStorage.removeItem("corebiz_3pl_token");
    setData(null);
    setRequests([]);
    setToken("");
  }

  async function createRequest(){
    const type=(
      window.prompt(
        "Тип обращения: DAMAGE, SHORTAGE, DELAY, DOCUMENT, GENERAL",
        "GENERAL"
      )??""
    ).toUpperCase();

    if(!["DAMAGE","SHORTAGE","DELAY","DOCUMENT","GENERAL"].includes(type)){
      setError("Неизвестный тип обращения");
      return;
    }

    const subject=window.prompt("Тема обращения");
    if(!subject?.trim())return;
    const body=window.prompt("Опишите проблему или запрос");
    if(!body?.trim())return;

    setBusy(true);setError("");
    try{
      const response=await fetch(
        API_URL+"/wms/3pl-requests/public/create",
        {
          method:"POST",
          headers:{
            Authorization:"Bearer "+token,
            "Content-Type":"application/json"
          },
          body:JSON.stringify({
            requestType:type,
            subject:subject.trim(),
            body:body.trim()
          })
        }
      );
      const payload=(await response.json()) as ApiResponse<{number:string}>;
      if(!payload.ok)throw new Error(payload.error.message);
      window.alert("Обращение "+payload.data.number+" создано");

      const listResponse=await fetch(
        API_URL+"/wms/3pl-requests/public/list",
        {headers:{Authorization:"Bearer "+token},cache:"no-store"}
      );
      const listPayload=(await listResponse.json()) as ApiResponse<ClientRequest[]>;
      if(listPayload.ok)setRequests(listPayload.data);
      setTab("requests");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать обращение");
    }finally{
      setBusy(false);
    }
  }

  const totalAvailable=useMemo(
    ()=>data?.balances.reduce((sum,row)=>sum+Number(row.available_milli),0)??0,
    [data]
  );

  if(!data){
    return (
      <main className="portal-shell">
        <section className="portal-login">
          <div className="portal-mark">Business OS · 3PL</div>
          <h1>Кабинет владельца товара</h1>
          <p>
            Введите токен, который выдал складской оператор. Кабинет доступен только для просмотра ваших остатков, движений, заказов и расчётов.
          </p>
          <label>
            <span>Portal token</span>
            <input
              type="password"
              value={token}
              onChange={e=>setToken(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter")void load();}}
              autoComplete="off"
            />
          </label>
          {error?<div className="public-store-error">{error}</div>:null}
          <button
            className="portal-primary"
            disabled={busy||!token.trim()}
            onClick={()=>void load()}
          >
            {busy?"Проверяем…":"Войти"}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="portal-shell portal-dashboard">
      <header className="portal-header">
        <div>
          <span>Business OS · 3PL</span>
          <strong>{data.owner.name}</strong>
        </div>
        <button onClick={logout}>Выйти</button>
      </header>

      <section className="portal-content">
        <div className="owner-kpi-grid">
          <article className="owner-kpi">
            <span>SKU с остатком</span>
            <strong>{data.balances.length}</strong>
          </article>
          <article className="owner-kpi">
            <span>Доступно, ед.</span>
            <strong>{qty(String(totalAvailable))}</strong>
          </article>
          <article className="owner-kpi">
            <span>Заказы</span>
            <strong>{data.orders.length}</strong>
          </article>
          <article className="owner-kpi">
            <span>Акты / statements</span>
            <strong>{data.statements.length}</strong>
          </article>
        </div>

        <nav className="portal-tabs">
          {[
            ["stock","Остатки"],
            ["locations","Ячейки"],
            ["movements","Движения"],
            ["orders","Заказы"],
            ["billing","Расчёты"],
            ["requests","Обращения"]
          ].map(([key,label])=>(
            <button
              key={key}
              className={tab===key?"active":""}
              onClick={()=>setTab(key as typeof tab)}
            >
              {label}
            </button>
          ))}
        </nav>

        {tab==="stock"?(
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Товар</th><th>Склад</th><th>Физически</th><th>Резерв</th><th>Доступно</th></tr></thead>
              <tbody>{data.balances.map((row,index)=>(
                <tr key={row.sku_code+":"+row.warehouse_name+":"+index}>
                  <td><strong>{row.product_name}</strong><small>{row.sku_code}</small></td>
                  <td>{row.warehouse_name}</td>
                  <td>{qty(row.physical_milli)}</td>
                  <td>{qty(row.reserved_milli)}</td>
                  <td><strong>{qty(row.available_milli)}</strong></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ):null}

        {tab==="locations"?(
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Ячейка</th><th>Товар</th><th>Склад</th><th>Количество</th></tr></thead>
              <tbody>{data.locations.map((row,index)=>(
                <tr key={row.full_code+":"+row.sku_code+":"+index}>
                  <td><strong>{row.full_code}</strong></td>
                  <td>{row.product_name}<small>{row.sku_code}</small></td>
                  <td>{row.warehouse_name}</td>
                  <td>{qty(row.physical_milli)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ):null}

        {tab==="movements"?(
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Дата</th><th>Товар</th><th>Операция</th><th>Физ.</th><th>Резерв</th></tr></thead>
              <tbody>{data.movements.map(row=>(
                <tr key={row.id}>
                  <td>{new Date(row.created_at).toLocaleString("ru-RU")}</td>
                  <td>{row.product_name}<small>{row.sku_code} · {row.warehouse_name}</small></td>
                  <td>{row.movement_type}<small>{row.source_type}</small></td>
                  <td>{qty(row.physical_delta_milli)}</td>
                  <td>{qty(row.reserved_delta_milli)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ):null}

        {tab==="orders"?(
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Заказ</th><th>Дата</th><th>Статус</th><th>Отгрузка</th><th>Сумма</th></tr></thead>
              <tbody>{data.orders.map(row=>(
                <tr key={row.id}>
                  <td><strong>{row.business_number}</strong></td>
                  <td>{new Date(row.created_at).toLocaleString("ru-RU")}</td>
                  <td>{row.order_status}</td>
                  <td>{row.fulfillment_status}</td>
                  <td>{money(row.total_minor,row.currency)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ):null}

        {tab==="billing"?(
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Период</th><th>Склад</th><th>Сумма</th><th>Финализирован</th></tr></thead>
              <tbody>{data.statements.map(row=>(
                <tr key={row.id}>
                  <td><strong>{row.period_from} — {row.period_to}</strong></td>
                  <td>{row.warehouse_name}</td>
                  <td>{money(row.total_minor,row.currency)}</td>
                  <td>{new Date(row.finalized_at).toLocaleString("ru-RU")}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ):null}

        {tab==="requests"?(
          <section>
            <div className="header-actions" style={{marginBottom:12}}>
              <button
                className="portal-primary"
                disabled={busy}
                onClick={()=>void createRequest()}
                type="button"
              >
                + Обращение
              </button>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Номер</th>
                    <th>Тема</th>
                    <th>Тип</th>
                    <th>Приоритет</th>
                    <th>Статус</th>
                    <th>SLA до</th>
                  </tr>
                </thead>
                <tbody>{requests.map(row=>(
                  <tr key={row.id}>
                    <td><strong>{row.request_number}</strong></td>
                    <td>{row.subject}</td>
                    <td>{row.request_type}</td>
                    <td>{row.priority}</td>
                    <td><span className="status-pill">{row.status}</span></td>
                    <td>{new Date(row.sla_due_at).toLocaleString("ru-RU")}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </section>
        ):null}
      </section>
    </main>
  );
}
