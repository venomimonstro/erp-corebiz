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

const money=(v:string,c="RUB")=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:c,maximumFractionDigits:0
}).format(Number(v||0)/100);

export default function AgencyPage(){
  const [rows,setRows]=useState<Project[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [expenseProject,setExpenseProject]=useState("");
  const [expenseCategory,setExpenseCategory]=useState("CONTRACTOR");
  const [expenseDescription,setExpenseDescription]=useState("");
  const [expenseAmount,setExpenseAmount]=useState("");
  const [expenseError,setExpenseError]=useState("");
  const [expenseSaving,setExpenseSaving]=useState(false);


  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      setRows(await apiRequest<Project[]>("/projects/agency/overview"));
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

  const metrics=useMemo(()=>{
    let revenue=0n,media=0n,labor=0n,other=0n,atRisk=0,approvals=0;
    for(const row of rows){
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
    return {revenue,media,labor,other,atRisk,approvals};
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
            и сколько денег остаётся после трудозатрат и рекламного бюджета.
          </p>
        </div>
        <div className="agency-hero-actions">
          <a className="secondary-button" href="/app/crm/deals">Воронка продаж</a>
          <a className="button-link" href="/app/projects?create=1">+ Новый проект</a>
        </div>
      </header>

      {error?<div className="studio-message error"><strong>Нужно проверить</strong><span>{error}</span></div>:null}
      {loading?<div className="board-loading">Собираем картину по клиентам…</div>:null}

      {!loading?<>
        <div className="agency-score-grid">
          <article><span>Активные клиенты</span><strong>{rows.length}</strong><small>проекты в работе</small></article>
          <article><span>Контрактная выручка</span><strong>{money(metrics.revenue.toString())}</strong><small>бюджеты + месячные ретейнеры</small></article>
          <article><span>Себестоимость команды</span><strong>{money(metrics.labor.toString())}</strong><small>по фактически учтённым часам</small></article>
          <article><span>Прямые расходы</span><strong>{money(metrics.other.toString())}</strong><small>подрядчики, ПО и прочее</small></article>
          <article className={metrics.atRisk?"is-risk":""}><span>Требуют внимания</span><strong>{metrics.atRisk}</strong><small>{metrics.approvals} согласований у клиентов</small></article>
        </div>

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
