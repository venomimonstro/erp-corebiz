"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Contract = {
  id: string;
  warehouse_id: string;
  warehouse_name: string;
  owner_id: string;
  owner_code: string;
  owner_name: string;
  status: string;
  rates: Array<{
    id: string;
    serviceCode: string;
    unit: string;
    rateMinor: string;
    currency: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
};

type Statement = {
  id: string;
  contract_id: string;
  warehouse_name: string;
  owner_name: string;
  period_from: string;
  period_to: string;
  status: string;
  currency: string;
  total_minor: string;
  generated_at: string;
  finalized_at: string | null;
};

type StatementDetails = {
  statement: Statement & {
    owner_code: string;
  };
  lines: Array<{
    id: string;
    service_code: string;
    quantity_milli: string;
    unit: string;
    rate_minor: string;
    amount_minor: string;
    calculation: {
      rateFrom?: string;
      rateTo?: string;
      formula?: string;
    };
    effective_from: string;
    effective_to: string | null;
  }>;
};

const SERVICE_LABELS: Record<string,string> = {
  RECEIPT_UNIT: "Приёмка, ед.",
  PUTAWAY_TASK: "Размещение, задача",
  PICK_TASK: "Отбор, задача",
  PACK_TASK: "Упаковка, задача",
  SHIPMENT_UNIT: "Отгрузка, ед.",
  STORAGE_UNIT_DAY: "Хранение, ед./день"
};

function rub(value:string,currency="RUB"){
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",
    currency,
    maximumFractionDigits:2
  }).format(Number(value)/100);
}

function quantity(value:string,unit:string){
  const amount=Number(value)/1000;
  if(unit==="TASK") return amount.toLocaleString("ru-RU")+" задач";
  if(unit==="UNIT_DAY") return amount.toLocaleString("ru-RU")+" ед./дней";
  return amount.toLocaleString("ru-RU")+" ед.";
}

export default function Wms3plBillingPage(){
  const [contracts,setContracts]=useState<Contract[]>([]);
  const [statements,setStatements]=useState<Statement[]>([]);
  const [selectedContract,setSelectedContract]=useState("");
  const [details,setDetails]=useState<StatementDetails|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState("");

  const load=useCallback(async()=>{
    setError("");
    try{
      const [c,s]=await Promise.all([
        apiRequest<Contract[]>("/wms/3pl-billing/contracts"),
        apiRequest<Statement[]>("/wms/3pl-billing/statements")
      ]);
      setContracts(c);
      setStatements(s);
      setSelectedContract(current=>current||c[0]?.id||"");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить 3PL billing");
    }
  },[]);

  useEffect(()=>{void load();},[load]);

  const current=useMemo(
    ()=>contracts.find(x=>x.id===selectedContract)??null,
    [contracts,selectedContract]
  );

  async function setRate(){
    if(!selectedContract)return;

    const serviceCode=(
      window.prompt(
        "Услуга: RECEIPT_UNIT, PUTAWAY_TASK, PICK_TASK, PACK_TASK, SHIPMENT_UNIT, STORAGE_UNIT_DAY",
        "STORAGE_UNIT_DAY"
      )??""
    ).toUpperCase();

    if(!SERVICE_LABELS[serviceCode]){
      setError("Неизвестная услуга");
      return;
    }

    const rateRub=window.prompt(
      "Тариф, ₽ за единицу тарификации",
      serviceCode==="STORAGE_UNIT_DAY"?"0.10":"10"
    );
    if(rateRub===null)return;

    const rate=Number(rateRub.replace(",","."));
    if(!Number.isFinite(rate)||rate<0){
      setError("Некорректный тариф");
      return;
    }

    const effectiveFrom=window.prompt(
      "Дата начала тарифа YYYY-MM-DD",
      new Date().toISOString().slice(0,10)
    );
    if(!effectiveFrom)return;

    setBusy("rate");
    try{
      await apiRequest(
        "/wms/3pl-billing/contracts/"+selectedContract+"/rates",
        {
          method:"PUT",
          body:JSON.stringify({
            serviceCode,
            rateMinor:String(Math.round(rate*100)),
            currency:"RUB",
            effectiveFrom
          })
        }
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось сохранить тариф");
    }finally{
      setBusy("");
    }
  }

  async function generate(){
    if(!selectedContract)return;
    const now=new Date();
    const monthStart=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),1))
      .toISOString().slice(0,10);
    const today=now.toISOString().slice(0,10);

    const periodFrom=window.prompt("Начало периода YYYY-MM-DD",monthStart);
    if(!periodFrom)return;
    const periodTo=window.prompt("Конец периода YYYY-MM-DD",today);
    if(!periodTo)return;

    setBusy("generate");
    try{
      const result=await apiRequest<{id:string;totalMinor:string;lines:number}>(
        "/wms/3pl-billing/contracts/"+selectedContract+"/statements",
        {
          method:"POST",
          body:JSON.stringify({periodFrom,periodTo})
        }
      );
      await load();
      await openStatement(result.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось сформировать statement");
    }finally{
      setBusy("");
    }
  }

  async function openStatement(id:string){
    try{
      setDetails(
        await apiRequest<StatementDetails>("/wms/3pl-billing/statements/"+id)
      );
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось открыть statement");
    }
  }

  async function finalize(id:string){
    if(!window.confirm(
      "Финализировать statement? После этого расчёт и строки нельзя будет изменить."
    ))return;

    setBusy(id);
    try{
      await apiRequest("/wms/3pl-billing/statements/"+id+"/finalize",{
        method:"POST"
      });
      await load();
      await openStatement(id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось финализировать statement");
    }finally{
      setBusy("");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="wms-billing"/>
      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">WMS / 3PL / Billing</p>
            <h1>Расчёты с владельцами товара</h1>
            <p className="workspace-summary">
              Тарифы версионируются по дате. Statement строится из фактических складских движений и завершённых задач.
            </p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={()=>void setRate()} disabled={!selectedContract||busy!==""}>
              + Тариф
            </button>
            <button onClick={()=>void generate()} disabled={!selectedContract||busy!==""}>
              Сформировать statement
            </button>
          </div>
        </header>

        {error?<div className="inline-error"><strong>3PL Billing</strong><span>{error}</span></div>:null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Договор</p>
              <h2>Тарифы</h2>
            </div>
          </div>

          <select
            value={selectedContract}
            onChange={event=>setSelectedContract(event.target.value)}
          >
            {contracts.map(contract=>(
              <option key={contract.id} value={contract.id}>
                {contract.owner_name} · {contract.warehouse_name}
              </option>
            ))}
          </select>

          {current?(
            <div className="data-table-wrap section-block">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Услуга</th>
                    <th>Тариф</th>
                    <th>Единица</th>
                    <th>Действует</th>
                  </tr>
                </thead>
                <tbody>
                  {current.rates.map(rate=>(
                    <tr key={rate.id}>
                      <td><strong>{SERVICE_LABELS[rate.serviceCode]??rate.serviceCode}</strong></td>
                      <td>{rub(rate.rateMinor,rate.currency)}</td>
                      <td>{rate.unit}</td>
                      <td>
                        {rate.effectiveFrom}
                        <small>{rate.effectiveTo?"до "+rate.effectiveTo:"без даты окончания"}</small>
                      </td>
                    </tr>
                  ))}
                  {!current.rates.length?(
                    <tr><td colSpan={4}>Тарифы ещё не настроены.</td></tr>
                  ):null}
                </tbody>
              </table>
            </div>
          ):null}
        </section>

        <div className="oms-layout section-block">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Владелец</th>
                  <th>Период</th>
                  <th>Статус</th>
                  <th>Сумма</th>
                  <th/>
                </tr>
              </thead>
              <tbody>
                {statements.map(statement=>(
                  <tr key={statement.id}>
                    <td>
                      <strong>{statement.owner_name}</strong>
                      <small>{statement.warehouse_name}</small>
                    </td>
                    <td>{statement.period_from} — {statement.period_to}</td>
                    <td><span className="status-pill">{statement.status}</span></td>
                    <td><strong>{rub(statement.total_minor,statement.currency)}</strong></td>
                    <td className="table-actions">
                      <button className="secondary-button" onClick={()=>void openStatement(statement.id)}>
                        Расшифровка
                      </button>
                      {statement.status==="DRAFT"?(
                        <button disabled={busy===statement.id} onClick={()=>void finalize(statement.id)}>
                          Финализировать
                        </button>
                      ):null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {details?(
            <aside className="oms-panel">
              <header>
                <div>
                  <span>Statement</span>
                  <strong>{details.statement.owner_name}</strong>
                </div>
                <button className="secondary-button" onClick={()=>setDetails(null)}>×</button>
              </header>

              <div className="oms-panel-section">
                <small>
                  {details.statement.period_from} — {details.statement.period_to}
                </small>
                {details.lines.map(line=>(
                  <article className="oms-allocation" key={line.id}>
                    <div>
                      <strong>{SERVICE_LABELS[line.service_code]??line.service_code}</strong>
                      <span>
                        {quantity(line.quantity_milli,line.unit)} × {rub(line.rate_minor,details.statement.currency)}
                      </span>
                    </div>
                    <b>{rub(line.amount_minor,details.statement.currency)}</b>
                    <p>
                      {line.calculation.rateFrom} — {line.calculation.rateTo}
                    </p>
                  </article>
                ))}
              </div>

              <div className="quality-banner">
                <strong>Итого</strong>
                <span>{rub(details.statement.total_minor,details.statement.currency)}</span>
              </div>
            </aside>
          ):null}
        </div>
      </section>
    </main>
  );
}
