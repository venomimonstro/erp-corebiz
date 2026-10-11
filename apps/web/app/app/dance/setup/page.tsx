"use client";
import {useCallback,useEffect,useState} from "react";
import {ServiceBusinessSetup} from "../../../../components/service-business-setup";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Step={
  id:string;title:string;subtitle:string;href:string;count:number;
  required:boolean;done:boolean;
};
type Readiness={ready:number;all:number;canLaunch:boolean;steps:Step[]};

export default function DanceSetupPage(){
  const [advanced,setAdvanced]=useState(false);
  const [data,setData]=useState<Readiness|null>(null);
  const [error,setError]=useState("");
  const [refreshing,setRefreshing]=useState(false);
  const reload=useCallback(async()=>{
    setRefreshing(true);
    try{
      const result=await apiRequest<Readiness>("/dance/readiness");
      setData(result);setError("");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось проверить настройки");}
    finally{setRefreshing(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);

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
      {error?<div className="dance-owner-error" role="alert">
        <span>{error}</span>
        <button onClick={()=>void reload()} type="button">Повторить</button>
      </div>:null}
      {!data&&!error?<p className="dance-owner-loading">Проверяем структуру студии…</p>:null}
      {data?<>
        <section className="dance-setup-progress">
          <div><p className="dance-owner-kicker">Готовность к работе</p>
            <h2>{data.ready} из {data.all} шагов настроены</h2>
            <p>{data.canLaunch?"Базовый процесс занятий настроен. Дальше — абонементы, зарплата и оптимизация.":
              "Пройдите обязательные шаги, чтобы начать управлять занятиями."}</p>
          </div>
          <div className="dance-setup-progress-chart">
            <strong>{Math.round(data.ready/data.all*100)}%</strong>
            <div role="progressbar" aria-label="Готовность студии"
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
