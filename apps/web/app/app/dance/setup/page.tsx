"use client";
import {useCallback,useEffect,useState} from "react";
import {ServiceBusinessSetup} from "../../../../components/service-business-setup";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";
import {danceBusinessStages,type BusinessAction} from "../../../../lib/shared-business-stage-actions";

type Step={
  id:string;title:string;subtitle:string;href:string;count:number;
  required:boolean;done:boolean;
};
type Readiness={ready:number;all:number;canLaunch:boolean;steps:Step[]};
type Context={permissions:Array<{code:string;scope:string}>};

export default function DanceSetupPage(){
  const [advanced,setAdvanced]=useState(false);
  const [data,setData]=useState<Readiness|null>(null);
  const [error,setError]=useState("");
  const [refreshing,setRefreshing]=useState(false);
  const [context,setContext]=useState<Context|null>(null);
  const reload=useCallback(async()=>{
    // An old green progress bar cannot survive a failed server refresh.
    setData(null);setError("");
    setRefreshing(true);
    try{
      const result=await apiRequest<Readiness>("/dance/readiness");
      setData(result);setError("");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось проверить настройки");}
    finally{setRefreshing(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  useEffect(()=>{
    let cancelled=false;
    void apiRequest<Context>("/workspace/context")
      .then(value=>{if(!cancelled)setContext(value);})
      .catch(()=>{if(!cancelled)setContext(null);});
    return()=>{cancelled=true;};
  },[]);
  const can=(code:string)=>Boolean(context?.permissions.some(entry=>
    (entry.code===code||entry.code==="*")&&entry.scope==="all"
  ));
  const action=(input:BusinessAction,kind:string)=>(
    can(input.permission)?
      <a key={kind} className="dance-lifecycle-action" href={input.href}>
        {input.label} →
      </a>:
      <span key={kind} className="dance-lifecycle-disabled" title={
        context?"Нужны права "+input.permission:"Права доступа ещё не проверены"
      }>{input.label} · нет прав</span>
  );


  if(advanced)return <>
    <div className="dance-setup-return">
      <button type="button" onClick={()=>{
        setAdvanced(false);void reload();
      }}>← К плану запуска</button>
    </div>
    <ServiceBusinessSetup mode="dance"/>
  </>;
  return <main className="app-shell">
    <AppSidebar active="dance-setup"/>
    <section className="workspace workspace-wide dance-owner dance-setup-page">
      <header className="dance-owner-heading">
        <div><p className="dance-owner-kicker">Начало работы</p>
          <h1>Настройка студии</h1>
          <p>От первой услуги и тренера до действующего расписания.
            Можно начать с малого и добавить остальные возможности позже.</p>
        </div>
        <div className="dance-owner-actions">
          <button type="button" className="dance-owner-secondary" disabled={refreshing}
            onClick={()=>void reload()}>{refreshing?"Проверяем…":"Проверить готовность"}</button>
          <button type="button" className="dance-owner-primary" onClick={()=>setAdvanced(true)}>
            Расширенные настройки ↗
          </button>
        </div>
      </header>
      <DanceWorkspaceNav active="setup"/>
      <section className="dance-setup-troubleshooting">
        <strong>Не можете закончить настройку?</strong>
        <p>Проверьте отсутствие услуги у тренера, занятого зала,
          просроченного абонемента, роли менеджера и финансовых связей.
          Система покажет конкретные недостающие данные и способ исправления.</p>
        <a href="/app/dance/diagnostics" className="secondary-button">
          Найти ошибку и исправить →
        </a>
      </section>
      <section className="dance-owner-surface dance-lifecycle-guide">
        <div className="dance-owner-section-heading">
          <div>
            <span className="dance-owner-eyebrow">Полный цикл управления</span>
            <h2>Что можно создать, изменить, архивировать и восстановить</h2>
            <p>Действия из одного рабочего места. Общие сущности CoreBiz
              используются во всех нишах; специальные — только в студии.
              Удаление истории платежей и посещений не допускается.</p>
          </div>
        </div>
        <div className="dance-lifecycle-grid">
          {danceBusinessStages.map((stage,index)=><article key={stage.id}
            className="dance-lifecycle-card">
            <div className="dance-lifecycle-heading">
              <small>{String(index+1).padStart(2,"0")} ·
                {stage.origin==="shared"?"Общий модуль":"Студия танцев"}</small>
              <h3>{stage.title}</h3>
            </div>
            <p>{stage.why}</p>
            <div className="dance-lifecycle-actions">
              {action(stage.configure,"create")}
              {stage.change?action(stage.change,"edit"):null}
              {stage.retire?action(stage.retire,"retire"):null}
              {stage.recover?action(stage.recover,"restore"):null}
            </div>
            <p className="dance-lifecycle-record">
              <strong>Единый источник:</strong> {stage.systemOfRecord}
            </p>
            <p className="dance-lifecycle-invariant">{stage.invariant}</p>
          </article>)}
        </div>
        {!context?<p className="muted" role="status">
          Права доступа пока не удалось проверить: изменение данных не разрешено
          через эти ссылки. Повторно войдите в компанию и проверьте роль.
        </p>:null}
      </section>
      {error?<div className="dance-owner-error" role="alert">
        <span>{error}</span>
        <button onClick={()=>void reload()} type="button">Повторить</button>
      </div>:null}
      {!data&&!error?<p className="dance-owner-loading">Проверяем структуру студии…</p>:null}
      {data?<>
        <section className="dance-setup-progress">
          <div><p className="dance-owner-kicker">Первые настройки</p>
            <h2>{data.ready} из {data.all} шагов настроены</h2>
            <p>{data.canLaunch?"Первые операции можно пробовать на тестовых данных. Финансы, права, абонементы и коммерческий запуск проверяются отдельно.":
              "Заполните основные данные и сформируйте расписание. Это ещё не разрешение принимать реальные платежи."}</p>
          </div>
          <div className="dance-setup-progress-chart">
            <strong>{Math.round(data.ready/data.all*100)}%</strong>
            <div role="progressbar" aria-label="Заполненные первые шаги студии"
              aria-valuenow={data.ready} aria-valuemin={0} aria-valuemax={data.all}>
              <span style={{width:Math.round(data.ready/data.all*100)+"%"}}/>
            </div>
          </div>
        </section>
        <section className="dance-owner-surface">
          <div className="dance-owner-section-heading">
            <div><span className="dance-owner-eyebrow">Простой старт</span>
              <h2>План запуска студии</h2></div>
          </div>
          <div className="dance-setup-steps">
            {data.steps.map((step,index)=><article className="dance-setup-step" key={step.id}>
              <span className={"dance-setup-step-indicator "+(step.done?"complete":"")}>
                {step.done?"✓":String(index+1).padStart(2,"0")}
              </span>
              <div><h3>{step.title}</h3><p>{step.subtitle}</p>
                <small>{step.required?"Для запуска":"Рекомендуется"}
                  {step.count>0?" · настроено: "+step.count:""}</small>
              </div>
              {step.href==="/app/dance/setup"?
                <button type="button" className="dance-setup-step-link"
                  onClick={()=>setAdvanced(true)}>
                  {step.done?"Изменить":"Настроить"} →
                </button>:
                <a className="dance-setup-step-link" href={step.href}>
                  {step.done?"Открыть":"Начать"} →
                </a>}
            </article>)}
          </div>
        </section>
        <div className="dance-setup-footer">
          <a href="/app/dance" className="dance-owner-secondary">Панель студии</a>
          <a href="/app/dance/groups" className="dance-owner-primary">Расписание и группы ↗</a>
        </div>
      </>:null}
    </section>
  </main>;
}
