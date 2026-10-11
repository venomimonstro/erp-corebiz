"use client";

import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Vertical = {
  code: string; title: string; summary: string; profileCode: string;
  operatingFlows: string[]; attentionSignals: string[];
};
type BusinessProfile = {
  profileCode: string; verticalCode: string | null; verticalTitle: string | null;
};
type Activation = {
  profile: string; verticalCode?: string | null; completed: boolean;
  progressPercent: number; doneCount: number; total: number;
  milestones: Array<{key:string; title:string;detail:string;href:string;done:boolean}>;
};
const startPage:Record<string,string>={
  DANCE_FITNESS:"/app/dance/setup",
  AUTO_SERVICE:"/app/automotive",
  AUTO_PARTS_DISMANTLING:"/app/automotive",
  ECOMMERCE_STORE:"/app/sites",
  MARKETPLACE_SELLER:"/app/channels",
  WAREHOUSE_3PL:"/app/wms/inbound",
  RETAIL_STORE:"/app/catalog/products",
  WHOLESALE_B2B:"/app/crm/customers",
  PROFESSIONAL_SERVICES:"/app/projects",
  WEB_STUDIO:"/app/agency",
  WEB_MARKETING_AGENCY:"/app/agency",
  MARKETING_AGENCY:"/app/agency",
  BEAUTY_SALON:"/app/service/setup",
  BARBERSHOP:"/app/service/setup",
  NAIL_SALON:"/app/service/setup",
  GENERAL:"/app"
};
const niches: Record<string,string> = {
  DANCE_FITNESS:"Студии и спорт",
  BEAUTY_SALON:"Услуги и запись",NAIL_SALON:"Услуги и запись",
  BARBERSHOP:"Услуги и запись",AUTO_SERVICE:"Автосервис",
  AUTO_PARTS_DISMANTLING:"Автосервис",
  ECOMMERCE_STORE:"Торговля",MARKETPLACE_SELLER:"Торговля",
  RETAIL_STORE:"Торговля",WHOLESALE_B2B:"Торговля",
  WAREHOUSE_3PL:"Логистика",WEB_STUDIO:"Проекты и агентства",
  WEB_MARKETING_AGENCY:"Проекты и агентства",
  MARKETING_AGENCY:"Проекты и агентства",
  PROFESSIONAL_SERVICES:"Проекты и агентства",GENERAL:"Универсально"
};

export default function FirstDayPage(){
  const query=useSearchParams();
  const [verticals,setVerticals]=useState<Vertical[]>([]);
  const [profile,setProfile]=useState<BusinessProfile|null>(null);
  const [activation,setActivation]=useState<Activation|null>(null);
  const [chosen,setChosen]=useState("");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [confirmChange,setConfirmChange]=useState(false);

  const reload=useCallback(async()=>{
    setLoading(true);
    try{
      const [options,current,progress]=await Promise.all([
        apiRequest<Vertical[]>("/customization/business-verticals"),
        apiRequest<BusinessProfile>("/customization/business-profile"),
        apiRequest<Activation>("/dashboard/activation")
      ]);
      setVerticals(options);
      setProfile(current);
      setActivation(progress);
      const requested=query.get("vertical");
      setChosen(prev=>prev ||
        (requested && options.some(x=>x.code===requested)?requested:
          current.verticalCode??"GENERAL"));
      setError("");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось открыть настройку компании");
    }finally{setLoading(false);}
  },[query]);
  useEffect(()=>{void reload();},[reload]);

  const selected=verticals.find(x=>x.code===chosen);
  const isChange=profile?.verticalCode!==null && profile?.verticalCode!==chosen;
  const applied=profile?.verticalCode===chosen;

  async function apply(){
    if(!selected || busy || (isChange&&!confirmChange))return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/customization/business-vertical",{
        method:"PUT",body:JSON.stringify({verticalCode:chosen})
      });
      // A vertical can change both permissions and module switches. Invalidate
      // sidebar capability caches after the operation has committed.
      window.dispatchEvent(new Event("corebiz-capabilities-changed"));
      setConfirmChange(false);
      setNotice("Рабочее пространство настроено. Теперь выполните шаги первого запуска.");
      await reload();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Настройки не сохранены");
    }finally{setBusy(false);}
  }
  const steps=activation?.milestones??[];
  const groupKeys=Array.from(new Set(verticals.map(v=>niches[v.code]??"Другие")));

  return (
    <main className="app-shell">
      <AppSidebar active="first-day"/>
      <section className="workspace workspace-wide studio-premium first-day">
        <header className="studio-hero compact">
          <div>
            <span className="studio-eyebrow">CoreBiz · первый день</span>
            <h1>Настройте бизнес, а не программу</h1>
            <p>Выберите свою нишу. Мы покажем нужные рабочие разделы,
              а затем проведём от первого клиента до реальной операции.</p>
          </div>
          <a href="/app" className="secondary-button">Мой кабинет →</a>
        </header>
        {loading?<p>Проверяем рабочее пространство…</p>:null}
        {error?<p role="alert" className="inline-error">{error}</p>:null}
        {notice?<p role="status">{notice}</p>:null}
        {verticals.length>0 ? (
          <section className="studio-section">
            <div className="studio-section-head">
              <div>
                <span>01 · Профиль компании</span>
                <h2>Какие процессы вы ведёте?</h2>
                <p>Это изменит видимые разделы и рекомендации, но не удалит товары,
                  клиентов или заказы. Профиль можно поменять позднее.</p>
              </div>
            </div>
            <div className="first-day-options">
              {groupKeys.map(group=>(
                <div key={group}>
                  <strong>{group}</strong>
                  <div className="first-day-choices">
                    {verticals.filter(v=>(niches[v.code]??"Другие")===group)
                      .map(v=>(
                        <button type="button" key={v.code}
                          className={v.code===chosen?"first-day-choice selected":"first-day-choice"}
                          aria-pressed={v.code===chosen}
                          disabled={busy}
                          onClick={()=>{
                            setChosen(v.code);setConfirmChange(false);
                          }}>
                          <b>{v.title}</b>
                          <small>{v.summary}</small>
                        </button>
                      ))}
                  </div>
                </div>
              ))}
            </div>
            {selected?<div className="first-day-summary">
              <strong>{selected.title}</strong>
              <p>Ваш основной сценарий:</p>
              <ol>{selected.operatingFlows.slice(0,4).map(flow=>
                <li key={flow}>{flow}</li>)}</ol>
            </div>:null}
            {isChange?<label className="first-day-confirm">
              <input type="checkbox" checked={confirmChange}
                onChange={e=>setConfirmChange(e.target.checked)}/>
              Понимаю, что смена ниши переключит модули и меню,
              но не удалит существующие записи
            </label>:null}
            <button type="button" disabled={busy||!selected||
              (isChange&&!confirmChange)}
              onClick={()=>void apply()}>
              {busy?"Настраиваем…":applied?"Применить настройки заново":"Применить профиль"}
            </button>
          </section>
        ):null}
        {applied && activation ? (
          <section className="studio-section">
            <div className="studio-section-head">
              <div>
                <span>02 · Первая польза</span>
                <h2>{activation.completed?"Основной сценарий настроен":
                  "Пройдите первые рабочие шаги"}</h2>
                <p>{activation.doneCount} из {activation.total} ·
                  {activation.progressPercent}% выполнено по реальным данным вашей компании</p>
              </div>
              <a href={startPage[chosen]??"/app"} className="secondary-button">
                Открыть рабочее место →
              </a>
            </div>
            <div className="first-day-steps">
              {steps.map((step,index)=>(
                <a href={step.href} key={step.key}
                  className={step.done?"first-day-step done":"first-day-step"}>
                  <span>{step.done?"✓":String(index+1).padStart(2,"0")}</span>
                  <div><strong>{step.title}</strong><p>{step.detail}</p></div>
                  <b aria-hidden="true">↗</b>
                </a>
              ))}
            </div>
            <p className="muted">Готовность этих шагов не означает
              подтверждённый приём онлайн-платежей, сдачу отчётности или
              успешный тест всех операций на вашем сервере.</p>
          </section>
        ):null}
        {selected?.attentionSignals?.length?(
          <section className="studio-section">
            <h2>На что владельцу обращать внимание</h2>
            <ul>{selected.attentionSignals.slice(0,5).map(x=>
              <li key={x}>{x}</li>)}</ul>
          </section>
        ):null}
      </section>
    </main>
  );
}
