"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";
import industryPlaybooks from "../../../lib/owner-industry-playbooks.json";

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
type LaunchCheck={
  code:string;title:string;detail:string;href:string;ok:boolean;blocking:boolean;
};
type LaunchReadiness={
  ready:boolean;stage:string;blockers:LaunchCheck[];warnings:LaunchCheck[];
  checks:LaunchCheck[];
};
const startPage:Record<string,string>={
  DANCE_FITNESS:"/app/dance/setup",
  AUTO_SERVICE:"/app/automotive",
  AUTO_PARTS_DISMANTLING:"/app/automotive",
  ECOMMERCE_STORE:"/app/commerce/launch",
  MARKETPLACE_SELLER:"/app/channels",
  WAREHOUSE_3PL:"/app/wms/inbound",
  RETAIL_STORE:"/app/catalog/products",
  OMNICHANNEL_RETAIL:"/app/retail",
  WHOLESALE_B2B:"/app/crm/customers",
  PROFESSIONAL_SERVICES:"/app/projects",
  WEB_STUDIO:"/app/agency",
  WEB_MARKETING_AGENCY:"/app/agency",
  MARKETING_AGENCY:"/app/agency",
  BEAUTY_SALON:"/app/service/desk",
  BARBERSHOP:"/app/service/desk",
  NAIL_SALON:"/app/service/desk",
  GENERAL:"/app"
};
const niches: Record<string,string> = {
  DANCE_FITNESS:"Студии и спорт",
  BEAUTY_SALON:"Услуги и запись",NAIL_SALON:"Услуги и запись",
  BARBERSHOP:"Услуги и запись",AUTO_SERVICE:"Автосервис",
  AUTO_PARTS_DISMANTLING:"Автосервис",
  ECOMMERCE_STORE:"Торговля",MARKETPLACE_SELLER:"Торговля",
  RETAIL_STORE:"Торговля",OMNICHANNEL_RETAIL:"Торговля",
  WHOLESALE_B2B:"Торговля",
  WAREHOUSE_3PL:"Логистика",WEB_STUDIO:"Проекты и агентства",
  WEB_MARKETING_AGENCY:"Проекты и агентства",
  MARKETING_AGENCY:"Проекты и агентства",
  PROFESSIONAL_SERVICES:"Проекты и агентства",GENERAL:"Универсально"
};

export default function FirstDayPage(){
  const [verticals,setVerticals]=useState<Vertical[]>([]);
  const [profile,setProfile]=useState<BusinessProfile|null>(null);
  const [activation,setActivation]=useState<Activation|null>(null);
  const [chosen,setChosen]=useState("");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [confirmChange,setConfirmChange]=useState(false);
  const [launch,setLaunch]=useState<LaunchReadiness|null>(null);
  const [launchLoading,setLaunchLoading]=useState(false);
  const [launchError,setLaunchError]=useState("");

  const reload=useCallback(async()=>{
    setLoading(true);
    try{
      // The catalog and current profile are critical. Activation progress
      // is optional: a delayed dashboard must not block business setup.
      const [optionsResult,currentResult,progressResult]=await Promise.allSettled([
        apiRequest<Vertical[]>("/customization/business-verticals"),
        apiRequest<BusinessProfile>("/customization/business-profile"),
        apiRequest<Activation>("/dashboard/activation")
      ]);
      const warnings:string[]=[];
      let options:Vertical[]|null=null;
      let current:BusinessProfile|null=null;
      if(optionsResult.status==="fulfilled"){
        options=optionsResult.value;
        setVerticals(options);
      }else{
        warnings.push("Не удалось загрузить список видов бизнеса.");
      }
      if(currentResult.status==="fulfilled"){
        current=currentResult.value;
        setProfile(current);
      }else{
        // Do not let the user blindly overwrite an unknown saved profile.
        setProfile(null);
        warnings.push("Не удалось проверить текущие настройки компании.");
      }
      if(progressResult.status==="fulfilled"){
        setActivation(progressResult.value);
      }else{
        setActivation(null);
        warnings.push("Шаги первого запуска временно недоступны.");
      }
      if(options&&current){
        const requested=typeof window==="undefined"?null:
          new URLSearchParams(window.location.search).get("vertical");
        setChosen(prev=>prev&&options.some(v=>v.code===prev)?prev:
          requested&&options.some(v=>v.code===requested)?requested:
            current.verticalCode??"GENERAL");
      }
      setError(warnings.join(" "));
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось открыть настройку компании");
    }finally{setLoading(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);

  // Commercial readiness is intentionally separate from activation.
  // A successful first booking is NOT proof of acquiring, fiscalization,
  // backups or production-release checks.
  useEffect(()=>{
    if(!profile?.verticalCode)return;
    let cancelled=false;
    setLaunchLoading(true);setLaunch(null);setLaunchError("");
    void apiRequest<LaunchReadiness>("/go-live/readiness")
      .then(value=>{if(!cancelled)setLaunch(value);})
      .catch(()=>{if(!cancelled){
        setLaunch(null);
        setLaunchError("Проверка коммерческого запуска сейчас недоступна. "
          +"Это не подтверждение готовности к продаже.");
      }})
      .finally(()=>{if(!cancelled)setLaunchLoading(false);});
    return()=>{cancelled=true;};
  },[profile?.verticalCode]);
  const selected=verticals.find(x=>x.code===chosen);
  const isChange=Boolean(profile?.verticalCode&&profile.verticalCode!==chosen);
  const applied=profile?.verticalCode===chosen;

  async function apply(){
    if(!selected || !profile || busy || (isChange&&!confirmChange))return;
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
  const nextAction=applied?steps.find(step=>!step.done):null;
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
        {error?<div role="alert" className="inline-error">
          <p>{error}</p>
          <button className="secondary-button" type="button"
            disabled={loading||busy} onClick={()=>void reload()}>
            Повторить загрузку
          </button>
        </div>:null}
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
            <button type="button" disabled={busy||!profile||!selected||
              (isChange&&!confirmChange)}
              onClick={()=>void apply()}>
              {busy?"Настраиваем…":applied?"Применить настройки заново":"Применить профиль"}
            </button>
          </section>
        ):null}
        {applied&&nextAction?(
          <section className="first-day-next-action" aria-label="Следующее действие">
            <div>
              <span>Рекомендуемый следующий шаг</span>
              <h2>{nextAction.title}</h2>
              <p>{nextAction.detail}</p>
            </div>
            <a className="secondary-button" href={nextAction.href}>
              Выполнить →
            </a>
          </section>
        ):null}
        {applied&&activation===null&&!loading?(
          <section className="studio-section">
            <h2>Первый запуск</h2>
            <p className="muted">Система пока не смогла проверить выполненные шаги.
              Вы можете продолжить настройку бизнеса, но прогресс не подтверждён.</p>
            <button type="button" className="secondary-button" onClick={()=>void reload()}>
              Проверить ещё раз
            </button>
          </section>
        ):null}
        {applied && activation ? (
          <section className="studio-section">
            <div className="studio-section-head">
              <div>
                <span>02 · Первая польза</span>
                <h2>{activation.completed?"Первая полезная операция выполнена":
                  "Подготовьте первую рабочую операцию"}</h2>
                <p>{activation.doneCount} из {activation.total} ·
                  {activation.progressPercent}% первых шагов выполнено.
                  Это не процент коммерческой готовности к продаже.</p>
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
        {applied?(
          <section className="studio-section first-day-launch-readiness" aria-label="Готовность к работе с клиентами">
            <div className="studio-section-head">
              <div>
                <span>03 · Готовность к запуску</span>
                <h2>Можно ли уже работать с клиентами?</h2>
                <p>Проверка платежей, прав доступа, данных компании и подтверждений релиза.
                  Это отдельный контроль, не процент заполнения карточек.</p>
              </div>
              <a href="/app/settings/go-live" className="secondary-button">
                Центр проверки запуска →
              </a>
            </div>
            {launchLoading?<p role="status" className="muted">Проверяем блокирующие условия…</p>:null}
            {launchError?<p role="status" className="muted">{launchError}</p>:null}
            {launch&&!launchLoading?(
              <>
                <p className="first-day-readiness-state" role="status">
                  {launch.ready
                    ?"По доступным проверкам сервера нет блокирующих условий. "
                     +"Перед реальными продажами завершите внешние и юридические проверки."
                    :"Запуск ещё не подтверждён: "+
                      launch.blockers.length+" блокирующих условий, "+
                      launch.warnings.length+" предупреждений."}
                </p>
                {launch.blockers.length>0?(
                  <div className="first-day-readiness-blockers">
                    {launch.blockers.slice(0,6).map(item=>(
                      <a href={item.href} key={item.code} className="first-day-readiness-item">
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                        <span aria-hidden="true">→</span>
                      </a>
                    ))}
                  </div>
                ):null}
                {launch.blockers.length>6?<p className="muted">
                  Ещё {launch.blockers.length-6} причин. Полный список — в центре запуска.</p>:null}
                {launch.warnings.length>0?<p className="muted">
                  Предупреждений: {launch.warnings.length}. Они также требуют внимания владельца.</p>:null}
              </>
            ):null}
          </section>
        ):null}
        {selected&&Array.isArray(industryPlaybooks.verticals[chosen as keyof typeof industryPlaybooks.verticals])?(
          <section className="studio-section" aria-label="Полный маршрут владельца">
            <div className="studio-section-head">
              <div>
                <span>04 · Настройка и самопроверка</span>
                <h2>Все экраны для «{selected.title}»</h2>
                <p>После первых рабочих шагов проверьте бизнес целиком:
                  что вводить на экране, какой результат получить и как действовать при ошибке.</p>
              </div>
            </div>
            <p className="muted">
              Это подробный план действий владельца, а не автоматический сертификат готовности.
              Зелёные отметки выше относятся только к тем операциям, которые проверил сервер.
              Платежи, фискализация, интеграции и сквозные процессы требуют отдельных испытаний.
            </p>
            <div className="owner-playbook-groups">
              {([
                {label:"Общие настройки компании",entries:industryPlaybooks.common},
                {label:"Процессы вашей ниши",
                  entries:industryPlaybooks.verticals[chosen as keyof typeof industryPlaybooks.verticals]}
              ]).map(group=>(
                <div className="owner-playbook-group" key={group.label}>
                  <h3>{group.label}</h3>
                  <div className="owner-playbook-list">
                    {group.entries.map((entry,index)=>(
                      <details key={entry.route+"-"+index} className="owner-playbook-item">
                        <summary>
                          <span className="owner-playbook-index">{String(index+1).padStart(2,"0")}</span>
                          <strong>{entry.title}</strong>
                          <span className="owner-playbook-pending">Проверить вручную</span>
                        </summary>
                        <div className="owner-playbook-body">
                          <p><strong>Что указать:</strong> {entry.fields.join(", ")}.</p>
                          <p><strong>Ожидаемый результат:</strong> {entry.expected}.</p>
                          <p><strong>Если не получилось:</strong> {entry.blocked}.</p>
                          <p><strong>Как восстановить:</strong> {entry.fix}.</p>
                          <a className="secondary-button" href={entry.route}>
                            Открыть экран настройки →
                          </a>
                        </div>
                      </details>
                    ))}
                  </div>
                </div>
              ))}
            </div>
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
