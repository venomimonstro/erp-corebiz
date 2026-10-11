"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Project={
  id:string;
  business_number:string;
  name:string;
  status:string;
  billing_mode:string;
  project_type:string|null;
  currency:string;
  budget_minor:string;
  monthly_retainer_minor:string;
  media_budget_minor:string;
  target_margin_bps:number|null;
  due_on:string|null;
  party_name:string|null;
  actual_minutes:number;
  labor_cost_minor:string;
  other_cost_minor:string;
  pending_deliverables:number;
  overdue_deliverables:number;
  pending_approvals:number;
  overdue_approvals:number;
};

type OwnerHealth={
  score:{
    overdueInvoices:number;overdueDeliveries:number;renewalDue:number;
    unworkedDeals:number;unpaidInvoiceCount:number;
    outstandingMinor:string;overdueMinor:string;
    contractedMonthlyRevenueMinor:string;activeMonthlyContracts:number;
    crmVisible:boolean;
  };
  alerts:Array<{
    type:string;title:string;description:string;
    href:string;dueAt:string|null;priority:"high"|"medium";
  }>;
};

type StatementPreview={
  projectId:string; period:string; currency:string; billingMode:string;
  serviceRevenueMinor:string; laborCostMinor:string; otherCostMinor:string;
  grossMarginMinor:string; marginBps:number|null; billableMinutes:number;
  contractBillingNeedsReview:boolean;sourceContractIds:string[];
  billingSource:string;
  warnings:string[];
};
type StatementRow={
  id:string;period_key:string;status:string;service_revenue_minor:string;
  labor_cost_minor:string;other_cost_minor:string;gross_margin_minor:string;
  invoice_id:string|null;invoice_number:string|null;invoice_status:string|null;
  invoice_due_at:string|null;
};
const lastPeriod=()=>{
  const now=new Date();
  const date=new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth()-1,1));
  return date.toISOString().slice(0,7);
};

const money=(v:string,c="RUB")=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:c,maximumFractionDigits:0
}).format(Number(v||0)/100);

export default function AgencyPage(){
  const [rows,setRows]=useState<Project[]>([]);
  const [health,setHealth]=useState<OwnerHealth|null>(null);
  const [allAlerts,setAllAlerts]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [expenseProject,setExpenseProject]=useState("");
  const [expenseCategory,setExpenseCategory]=useState("CONTRACTOR");
  const [expenseDescription,setExpenseDescription]=useState("");
  const [expenseAmount,setExpenseAmount]=useState("");
  const [expenseError,setExpenseError]=useState("");
  const [expenseSaving,setExpenseSaving]=useState(false);
  const [billProject,setBillProject]=useState("");
  const [billPeriod,setBillPeriod]=useState(lastPeriod);
  const [billPreview,setBillPreview]=useState<StatementPreview|null>(null);
  const [billRows,setBillRows]=useState<StatementRow[]>([]);
  const [billBusy,setBillBusy]=useState(false);
  const [billOverride,setBillOverride]=useState("");
  const [billReason,setBillReason]=useState("");
  const [billError,setBillError]=useState("");
  const [billNotice,setBillNotice]=useState("");



  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{

      const [projects,healthResult]=await Promise.all([
        apiRequest<Project[]>("/projects/agency/overview"),
        apiRequest<OwnerHealth>("/projects/agency/health")
      ]);
      setRows(projects);
      setHealth(healthResult);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить агентство");
    }finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);

  const saveExpense=async()=>{
    setExpenseError("");
    const value=expenseAmount.trim().replace(",",".");
    if(!/^\d+(?:\.\d{1,2})?$/.test(value) || Number(value)<=0){
      setExpenseError("Укажите положительную сумму в рублях");return;
    }
    const [rub,kopecks=""]=value.split(".");
    const amountMinor=(BigInt(rub)*100n+BigInt(kopecks.padEnd(2,"0"))).toString();
    setExpenseSaving(true);
    try{
      await apiRequest("/projects/"+expenseProject+"/expenses",{
        method:"POST",
        body:JSON.stringify({category:expenseCategory,description:expenseDescription,amountMinor})
      });
      setExpenseAmount("");setExpenseDescription("");setExpenseProject("");
      await load();
    }catch(e){setExpenseError(e instanceof Error?e.message:"Не удалось сохранить расход");}
    finally{setExpenseSaving(false);}
  };

  const refreshStatements=useCallback(async(id:string)=>{
    if(!id){setBillRows([]);return;}
    setBillRows(await apiRequest<StatementRow[]>("/projects/"+id+"/statements"));
  },[]);
  useEffect(()=>{
    setBillPreview(null);setBillError("");setBillNotice("");
    void refreshStatements(billProject).catch(e=>
      setBillError(e instanceof Error?e.message:"Не удалось загрузить периоды")
    );
  },[billProject,refreshStatements]);

  const showPreview=async()=>{
    if(!billProject)return;
    setBillError("");setBillNotice("");setBillBusy(true);
    try{
      const value=await apiRequest<StatementPreview>(
        "/projects/"+billProject+"/statements/preview?period="+encodeURIComponent(billPeriod)
      );
      setBillPreview(value);
    }catch(e){setBillError(e instanceof Error?e.message:"Не удалось рассчитать период");}
    finally{setBillBusy(false);}
  };
  const finalizeMonth=async()=>{
    if(!billProject||!billPreview||billPreview.period!==billPeriod)return;
    setBillError("");setBillBusy(true);
    try{
      let adjustment:{serviceRevenueOverrideMinor:string;adjustmentReason:string}|undefined;
      if(billOverride.trim()){
        const value=billOverride.trim().replace(",",".");
        if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(value))throw new Error("Некорректная сумма корректировки");
        if(billReason.trim().length<12)throw new Error("Укажите основание корректировки (от 12 символов)");
        const [whole,fraction=""]=value.split(".");
        adjustment={
          serviceRevenueOverrideMinor:(BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0"))).toString(),
          adjustmentReason:billReason.trim()
        };
      }
      await apiRequest("/projects/"+billProject+"/statements/finalize",{
        method:"POST",body:JSON.stringify({period:billPeriod,...adjustment})
      });
      await refreshStatements(billProject);
      setBillPreview(null);setBillOverride("");setBillReason("");
      setBillNotice("Месяц закрыт. Можно выставить счёт.");
    }catch(e){setBillError(e instanceof Error?e.message:"Не удалось закрыть месяц");}
    finally{setBillBusy(false);}
  };
  const invoiceMonth=async(statementId:string)=>{
    if(!billProject)return;
    setBillBusy(true);setBillError("");setBillNotice("");
    try{
      const result=await apiRequest<{number:string}>(
        "/finance/invoices/from-agency/"+statementId,
        {method:"POST",body:"{}"}
      );
      await refreshStatements(billProject);
      setBillNotice("Счёт "+result.number+" создан в разделе «Финансы».");
    }catch(e){setBillError(e instanceof Error?e.message:"Не удалось выставить счёт");}
    finally{setBillBusy(false);}
  };

  const metrics=useMemo(()=>{
    let revenue=0n,media=0n,labor=0n,other=0n,atRisk=0,approvals=0,foreign=0;
    for(const row of rows){
      if(row.currency!=="RUB"){foreign++;continue;}
      revenue+=BigInt(
        row.billing_mode==="RETAINER"
          ?row.monthly_retainer_minor||"0"
          :row.budget_minor||"0"
      );
      media+=BigInt(row.media_budget_minor||"0");
      labor+=BigInt(row.labor_cost_minor||"0");
      other+=BigInt(row.other_cost_minor||"0");
      if(row.overdue_deliverables||row.overdue_approvals) atRisk++;
      approvals+=row.pending_approvals;
    }
    return {revenue,media,labor,other,atRisk,approvals,foreign};
  },[rows]);

  return <main className="app-shell">
    <AppSidebar active="agency"/>
    <section className="workspace workspace-wide agency-premium">
      <header className="agency-hero">
        <div>
          <span className="studio-eyebrow">Профессиональные услуги</span>
          <h1>Агентство</h1>
          <p>
            Сделка превращается в проект. Проект — в понятный контур:
            что обещали клиенту, что команда делает сейчас, что ждёт согласования
            и сколько остаётся после прямых расходов и трудозатрат.
          </p>
        </div>
        <div className="agency-hero-actions">
          <a className="secondary-button" href="/app/crm/deals">Воронка продаж</a>
          <a className="secondary-button" href="/app/agency/contracts">Договоры</a>
          <a className="secondary-button" href="/app/agency/team">Команда и ставки</a>
          <a className="secondary-button" href="/app/agency/contracts">Договоры и продления</a>
          <a className="button-link" href="/app/projects?create=1">+ Новый проект</a>
        </div>
      </header>

      {error?<div className="studio-message error"><strong>Нужно проверить</strong><span>{error}</span></div>:null}
      {loading?<div className="board-loading">Собираем картину по клиентам…</div>:null}

      {!loading?<>
        <div className="agency-score-grid">
          <article><span>Активные клиенты</span><strong>{rows.length}</strong><small>проекты в работе</small></article>
          <article><span>Плановая выручка</span><strong>{money(metrics.revenue.toString())}</strong><small>не фактические поступления</small></article>
          <article><span>Себестоимость команды</span><strong>{money(metrics.labor.toString())}</strong><small>по фактически учтённым часам, RUB</small></article>
          <article><span>Медиабюджеты клиентов</span><strong>{money(metrics.media.toString())}</strong><small>отдельно от выручки агентства</small></article>
          <article><span>Прямые расходы</span><strong>{money(metrics.other.toString())}</strong><small>подрядчики, ПО и прочее</small></article>
          {metrics.foreign>0?<article><span>Иные валюты</span><strong>{metrics.foreign}</strong>
            <small>В общей сумме показаны только рублёвые проекты</small></article>:null}
          <article className={metrics.atRisk?"is-risk":""}><span>Требуют внимания</span><strong>{metrics.atRisk}</strong><small>{metrics.approvals} согласований у клиентов</small></article>
        </div>

        {health?<section className="agency-board">
          <div className="studio-section-head">
            <div>
              <span>Контроль владельца</span>
              <h2>Что требует внимания сегодня</h2>
              <p>Важные действия из CRM, клиентских проектов, договоров и счетов. Суммы в рублях; валютные договоры учитываются отдельно.</p>
            </div>
            <button className="secondary-button" type="button" onClick={()=>setAllAlerts(v=>!v)}>
              {allAlerts?"Свернуть":"Все сигналы ("+health.alerts.length+")"}
            </button>
          </div>
          <div className="agency-score-grid">
            <article><span>Договорная выручка / месяц</span>
              <strong>{money(health.score.contractedMonthlyRevenueMinor)}</strong>
              <small>{health.score.activeMonthlyContracts} действующих месячных договоров</small>
            </article>
            <article><span>Дебиторка по счетам</span>
              <strong>{money(health.score.outstandingMinor)}</strong>
              <small>{health.score.unpaidInvoiceCount} неоплаченных счетов</small>
            </article>
            <article className={health.score.overdueInvoices?"is-risk":""}>
              <span>Просрочено к оплате</span>
              <strong>{money(health.score.overdueMinor)}</strong>
              <small>{health.score.overdueInvoices} просроченных счетов</small>
            </article>
            <article className={health.score.renewalDue?"is-risk":""}>
              <span>Продления договоров</span>
              <strong>{health.score.renewalDue}</strong>
              <small>пора связаться с клиентами</small>
            </article>
            <article className={health.score.overdueDeliveries?"is-risk":""}>
              <span>Срыв сроков</span>
              <strong>{health.score.overdueDeliveries}</strong>
              <small>задачи сдачи и согласования</small>
            </article>
            {health.score.crmVisible?<article className={health.score.unworkedDeals?"is-risk":""}>
              <span>Сделки без действия</span>
              <strong>{health.score.unworkedDeals}</strong>
              <small>откройте CRM и назначьте follow-up</small>
            </article>:null}
          </div>
          <div className="agency-project-grid">
            {(allAlerts?health.alerts:health.alerts.slice(0,6)).map((alert,i)=>
              <a key={alert.type+alert.title+i} href={alert.href} className="agency-project-card">
                <header><div><span className="agency-client">{alert.type}</span>
                  <h3>{alert.title}</h3><p>{alert.description}</p></div>
                  <span className={"agency-health "+(alert.priority==="high"?"risk":"ok")}>
                    {alert.priority==="high"?"Срочно":"Запланировать"}
                  </span>
                </header>
                <footer><span>{alert.dueAt?new Date(alert.dueAt).toLocaleDateString("ru-RU"):"Без срока"}</span>
                  <span>Открыть →</span></footer>
              </a>
            )}
            {!health.alerts.length?<div className="studio-empty"><strong>Критических сигналов нет</strong>
              <p>Следите за продлениями, сроками и следующими действиями в CRM.</p></div>:null}
          </div>
          {health.alerts.length>=120?<p>Показаны первые 120 сигналов по приоритету.</p>:null}
        </section>:null}
        <section className="agency-board">
          <div className="studio-section-head">
            <div><span>Расчёты с клиентами</span><h2>Закрытие месяца и счета</h2>
            <p>Сначала проверьте трудозатраты и расходы, затем закройте завершённый месяц. После закрытия сумма фиксируется и может быть выставлена к оплате.</p></div>
          </div>
          <div className="agency-hero-actions">
            <select aria-label="Проект для закрытия месяца" value={billProject} onChange={e=>setBillProject(e.target.value)}>
              <option value="">Выберите клиентский проект</option>
              {rows.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input aria-label="Отчётный месяц" type="month" max={lastPeriod()} value={billPeriod}
              onChange={e=>{setBillPeriod(e.target.value);setBillPreview(null);setBillNotice("");}}/>
            <button disabled={billBusy||!billProject} onClick={()=>void showPreview()}>Рассчитать период</button>
          </div>
          {billError?<p role="alert" className="studio-message error">{billError}</p>:null}
          {billNotice?<p role="status">{billNotice}</p>:null}
          {billPreview?<div className="agency-score-grid">
            <article><span>Выручка услуг</span><strong>{money(billPreview.serviceRevenueMinor,billPreview.currency)}</strong></article>
            <article><span>Труд сотрудников</span><strong>{money(billPreview.laborCostMinor,billPreview.currency)}</strong></article>
            <article><span>Прямые расходы</span><strong>{money(billPreview.otherCostMinor,billPreview.currency)}</strong></article>
            <article><span>Маржинальный результат</span><strong>{money(billPreview.grossMarginMinor,billPreview.currency)}</strong></article>
          </div>:null}
          {billPreview?<div>
            {billPreview.warnings.length>0?
              <ul>{billPreview.warnings.map(w=><li key={w}>{w}</li>)}</ul>:null}
            <p>Источник начисления: {billPreview.billingSource}. Модель: {billPreview.billingMode}, учтено часов: {Math.round(billPreview.billableMinutes/60*10)/10}.</p>
                        <div className="agency-hero-actions">
              <label>Ручная корректировка выручки, ₽ (необязательно)
                <input inputMode="decimal" placeholder="Например, 50000.00"
                  value={billOverride} onChange={e=>setBillOverride(e.target.value)}/>
              </label>
              {billOverride||billPreview.contractBillingNeedsReview?<label>Основание корректировки
                <input maxLength={1000} placeholder="Причина, документ, согласование (от 12 символов)"
                  value={billReason} onChange={e=>setBillReason(e.target.value)}/>
              </label>:null}
            </div>
            {billPreview.contractBillingNeedsReview?
              <p role="alert">Договоры требуют ручной проверки. Для закрытия укажите согласованную сумму и основание.</p>:null}
            <button disabled={billBusy||billPreview.period!==billPeriod||
              billPreview.warnings.some(w=>w.includes("себестоимость сотрудника")||w.includes("не привязан клиент"))||
              (billPreview.contractBillingNeedsReview&&(!billOverride.trim()||billReason.trim().length<12))}
              onClick={()=>void finalizeMonth()}>Зафиксировать месяц</button>
          </div>:null}
          {billProject?<div className="agency-project-grid">
            {billRows.map(row=><article className="agency-project-card" key={row.id}>
              <header><div><span className="agency-client">{row.period_key}</span>
                <h3>{row.invoice_number??"Без счёта"}</h3></div>
                <span className="agency-health">{row.invoice_status??row.status}</span>
              </header>
              <div className="agency-money-row">
                <div><span>Выручка</span><strong>{money(row.service_revenue_minor)}</strong></div>
                <div><span>Маржинальный результат</span><strong>{money(row.gross_margin_minor)}</strong></div>
              </div>
              {row.status==="FINALIZED" && BigInt(row.service_revenue_minor)>0n?
                <button disabled={billBusy} onClick={()=>void invoiceMonth(row.id)}>Выставить счёт</button>:null}
              {row.invoice_id?<a href="/app/finance">Открыть финансы</a>:null}
            </article>)}
          </div>:null}
        </section>
        <section className="agency-board">
          <div className="studio-section-head"><div><span>Финансы проекта</span><h2>Прямые расходы</h2><p>Учитывайте подрядчиков, программное обеспечение и дополнительные затраты отдельно от клиентского рекламного бюджета.</p></div></div>
          <div className="agency-hero-actions">
            <select aria-label="Проект" value={expenseProject} onChange={e=>setExpenseProject(e.target.value)}>
              <option value="">Выберите проект</option>
              {rows.filter(p=>p.currency==="RUB").map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select aria-label="Категория" value={expenseCategory} onChange={e=>setExpenseCategory(e.target.value)}>
              <option value="CONTRACTOR">Подрядчики</option><option value="SOFTWARE">ПО</option><option value="TRAVEL">Командировки</option><option value="OTHER">Другое</option>
            </select>
            <input aria-label="Описание" placeholder="Описание расхода" value={expenseDescription} maxLength={240} onChange={e=>setExpenseDescription(e.target.value)}/>
            <input aria-label="Сумма в рублях" placeholder="Сумма, ₽" inputMode="decimal" value={expenseAmount} onChange={e=>setExpenseAmount(e.target.value)}/>
            <button disabled={expenseSaving||!expenseProject||expenseDescription.trim().length<2} onClick={()=>void saveExpense()}>{expenseSaving?"Сохранение…":"Добавить"}</button>
          </div>
          {expenseError?<p role="alert">{expenseError}</p>:null}
        </section>
        <section className="agency-board">
          <div className="studio-section-head">
            <div>
              <span>Клиентский портфель</span>
              <h2>Что происходит сейчас</h2>
              <p>Сначала показываем риск и зависшие согласования, а не сортируем по алфавиту.</p>
            </div>
          </div>

          <div className="agency-project-grid">
            {rows.map(project=>{
              const risk=project.overdue_deliverables+project.overdue_approvals;
              const planned=BigInt(
                project.billing_mode==="RETAINER"
                  ?project.monthly_retainer_minor||"0"
                  :project.budget_minor||"0"
              );
              const labor=BigInt(project.labor_cost_minor||"0");
              const contribution=planned-labor-BigInt(project.other_cost_minor||"0");
              return <a href={"/app/projects/"+project.id} className="agency-project-card" key={project.id}>
                <header>
                  <div>
                    <span className="agency-client">{project.party_name??"Внутренний проект"}</span>
                    <h3>{project.name}</h3>
                    <p>{project.project_type??project.billing_mode.replaceAll("_"," ")}</p>
                  </div>
                  <span className={"agency-health "+(risk?"risk":"ok")}>{risk?"Нужен контроль":"По плану"}</span>
                </header>
                <div className="agency-money-row">
                  <div><span>Контракт</span><strong>{money(planned.toString(),project.currency)}</strong></div>
                  <div><span>Вклад после труда и подрядчиков</span><strong>{money(contribution.toString(),project.currency)}</strong></div>
                </div>
                <div className="agency-progress-row">
                  <div><span>Результаты клиенту</span><strong>{project.pending_deliverables}</strong><small>{project.overdue_deliverables?"просрочено "+project.overdue_deliverables:"без просрочек"}</small></div>
                  <div><span>Ждём клиента</span><strong>{project.pending_approvals}</strong><small>{project.overdue_approvals?"просрочено "+project.overdue_approvals:"согласования"}</small></div>
                  <div><span>Команда</span><strong>{Math.round(project.actual_minutes/60)} ч</strong><small>{money(project.labor_cost_minor,project.currency)}</small></div>
                  <div><span>Прямые расходы</span><strong>{money(project.other_cost_minor||"0",project.currency)}</strong></div>
                </div>
                <footer>
                  <span>{project.business_number}</span>
                  <span>{project.due_on?"срок "+new Date(project.due_on).toLocaleDateString("ru-RU"):"без общего дедлайна"}</span>
                </footer>
              </a>;
            })}
          </div>

          {!rows.length?<div className="studio-empty"><strong>Клиентских проектов пока нет</strong><p>Выиграйте сделку в CRM или создайте первый проект вручную.</p></div>:null}
        </section>
      </>:null}
    </section>
  </main>;
}
