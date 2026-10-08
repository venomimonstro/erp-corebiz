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
  const [tab,setTab]=useState<"stock"|"locations"|"movements"|"orders"|"billing">("stock");
  const [busy,setBusy]=useState(false);

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
    setToken("");
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
            ["billing","Расчёты"]
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
      </section>
    </main>
  );
}
