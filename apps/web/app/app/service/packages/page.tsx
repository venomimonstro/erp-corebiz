"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Customer={id:string;displayName:string;phone:string|null};
type Service={id:string;name:string};
type Resource={id:string;name:string;type:string};

type Entitlement={
  id?:string;
  serviceId:string|null;
  trainerResourceId:string|null;
  lessonType:string|null;
  danceProgramId:string|null;
  danceGroupId:string|null;
  weekdays:number[];
  startMinute:number;
  endMinute:number;
  visitLimit:number|null;
  managementVisitValueMinor:string;
  priority:number;
};

type PackagePlan={
  id:string;
  name:string;
  code:string|null;
  description:string|null;
  applicable_service_id:string|null;
  applicable_service_name:string|null;
  package_kind:"VISITS"|"PERIOD"|"UNLIMITED"|"FAMILY"|"INDIVIDUAL"|"COMBO"|"TRIAL"|"GIFT";
  visit_limit:number|null;
  duration_days:number;
  management_visit_value_minor:string;
  freeze_days_allowed:number;
  makeup_days_valid:number;
  allow_makeup:boolean;
  family_eligible:boolean;
  activation_policy:string;
  price_minor:string;
  currency:string;
  no_show_policy:"RELEASE"|"CONSUME";
  entitlements:Entitlement[];
};

type ServicePackage={
  id:string;party_id:string;plan_id:string;starts_at:string;expires_at:string;
  visit_limit_snapshot:number|null;reserved_visits:number;used_visits:number;
  available_visits:number|null;package_kind_snapshot:string;price_minor_snapshot:string;
  currency:string;status:string;party_name:string;plan_name:string;no_show_policy:string;
};

type DraftRule={
  serviceId:string;
  trainerResourceId:string;
  lessonType:""|"GROUP"|"INDIVIDUAL"|"SELF_PRACTICE";
  visitLimit:string;
  weekdays:number[];
  startMinute:number;
  endMinute:number;
};

const DAYS=[["1","Пн"],["2","Вт"],["3","Ср"],["4","Чт"],["5","Пт"],["6","Сб"],["7","Вс"]] as const;

function money(value:string,currency:string){
  return new Intl.NumberFormat("ru-RU",{style:"currency",currency,maximumFractionDigits:0})
    .format(Number(value)/100);
}
function toMinor(value:string){
  const parsed=Number(value.replace(",","."));
  return Number.isFinite(parsed)&&parsed>=0?String(Math.round(parsed*100)):null;
}
function time(value:number){
  return String(Math.floor(value/60)).padStart(2,"0")+":"+String(value%60).padStart(2,"0");
}
function formatKind(kind:string){
  return ({
    VISITS:"Пакет посещений",PERIOD:"На период",UNLIMITED:"Безлимит",
    FAMILY:"Семейный",INDIVIDUAL:"Персональный",COMBO:"Комбинированный",
    TRIAL:"Пробный",GIFT:"Подарочный"
  } as Record<string,string>)[kind]??kind;
}

const emptyRule=():DraftRule=>({
  serviceId:"",trainerResourceId:"",lessonType:"",
  visitLimit:"",weekdays:[1,2,3,4,5,6,7],startMinute:0,endMinute:1440
});

export default function ServicePackagesPage(){
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [services,setServices]=useState<Service[]>([]);
  const [resources,setResources]=useState<Resource[]>([]);
  const [plans,setPlans]=useState<PackagePlan[]>([]);
  const [packages,setPackages]=useState<ServicePackage[]>([]);
  const [selectedCustomer,setSelectedCustomer]=useState("");
  const [selectedPlan,setSelectedPlan]=useState("");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pending,setPending]=useState(false);
  const [showBuilder,setShowBuilder]=useState(false);

  const [name,setName]=useState("8 занятий");
  const [kind,setKind]=useState<PackagePlan["package_kind"]>("VISITS");
  const [visits,setVisits]=useState("8");
  const [days,setDays]=useState("30");
  const [price,setPrice]=useState("0");
  const [freezeDays,setFreezeDays]=useState("0");
  const [makeupDays,setMakeupDays]=useState("0");
  const [noShow,setNoShow]=useState<"RELEASE"|"CONSUME">("RELEASE");
  const [activation,setActivation]=useState("FULL_PAYMENT");
  const [rules,setRules]=useState<DraftRule[]>([]);

  const load=useCallback(async()=>{
    setError("");
    try{
      const [customerRows,serviceRows,resourceRows,planRows,packageRows]=await Promise.all([
        apiRequest<Customer[]>("/crm/customers"),
        apiRequest<Service[]>("/service/catalog"),
        apiRequest<Resource[]>("/service/resources"),
        apiRequest<PackagePlan[]>("/service/package-plans"),
        apiRequest<ServicePackage[]>("/service/packages")
      ]);
      setCustomers(customerRows);
      setServices(serviceRows);
      setResources(resourceRows);
      setPlans(planRows);
      setPackages(packageRows);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить абонементы");
    }
  },[]);

  useEffect(()=>{void load();},[load]);

  const trainers=useMemo(
    ()=>resources.filter(item=>item.type==="EMPLOYEE"),[resources]
  );
  const activePackages=useMemo(
    ()=>packages.filter(item=>item.status==="ACTIVE"),[packages]
  );
  const expiring=useMemo(
    ()=>activePackages.filter(item=>{
      const left=new Date(item.expires_at).getTime()-Date.now();
      return left>=0&&left<=7*86400000;
    }).length,
    [activePackages]
  );

  function resetBuilder(preset:"VISITS"|"UNLIMITED"|"COMBO"|"FAMILY"="VISITS"){
    setKind(preset);
    setName(
      preset==="UNLIMITED"?"Безлимит 30 дней":
      preset==="COMBO"?"Группа + практика":
      preset==="FAMILY"?"Семейный абонемент":"8 занятий"
    );
    setVisits(preset==="UNLIMITED"?"":preset==="COMBO"?"12":"8");
    setDays("30");
    setPrice("0");
    setFreezeDays("0");
    setMakeupDays("0");
    setNoShow("RELEASE");
    setActivation("FULL_PAYMENT");
    setRules(
      preset==="COMBO"
        ?[
          {...emptyRule(),lessonType:"GROUP",visitLimit:"8",priority:10} as DraftRule,
          {...emptyRule(),lessonType:"SELF_PRACTICE",visitLimit:"4",priority:20} as DraftRule
        ]
        :[]
    );
    setShowBuilder(true);
  }

  function updateRule(index:number,patch:Partial<DraftRule>){
    setRules(current=>current.map((rule,i)=>i===index?{...rule,...patch}:rule));
  }

  function toggleRuleDay(index:number,day:number){
    const current=rules[index];
    if(!current)return;
    updateRule(index,{
      weekdays:current.weekdays.includes(day)
        ?current.weekdays.filter(item=>item!==day)
        :[...current.weekdays,day].sort((a,b)=>a-b)
    });
  }

  async function createPlan(event:FormEvent){
    event.preventDefault();
    setError("");
    setNotice("");
    const durationDays=Number(days);
    const visitLimit=kind==="UNLIMITED"?undefined:Number(visits);
    const priceMinor=toMinor(price);
    if(
      !name.trim()||!Number.isSafeInteger(durationDays)||durationDays<1||
      (kind!=="UNLIMITED"&&(!Number.isSafeInteger(visitLimit)||Number(visitLimit)<1))||
      priceMinor===null
    ){
      setError("Проверьте название, срок, посещения и цену");
      return;
    }

    const normalizedRules=rules.map((rule,index)=>{
      const quota=rule.visitLimit.trim()?Number(rule.visitLimit):null;
      if(quota!==null&&(!Number.isSafeInteger(quota)||quota<1)){
        throw new Error("Проверьте квоту посещений в правилах");
      }
      if(!rule.weekdays.length) throw new Error("В каждой квоте нужен хотя бы один день");
      return {
        serviceId:rule.serviceId||undefined,
        trainerResourceId:rule.trainerResourceId||undefined,
        lessonType:rule.lessonType||undefined,
        weekdays:rule.weekdays,
        startMinute:rule.startMinute,
        endMinute:rule.endMinute,
        visitLimit:quota,
        managementVisitValueMinor:"0",
        priority:100+index
      };
    });

    setPending(true);
    try{
      await apiRequest("/service/package-plans",{
        method:"POST",
        body:JSON.stringify({
          name:name.trim(),
          packageKind:kind,
          visitLimit,
          durationDays,
          priceMinor,
          managementVisitValueMinor:"0",
          freezeDaysAllowed:Number(freezeDays)||0,
          makeupDaysValid:Number(makeupDays)||0,
          allowMakeup:(Number(makeupDays)||0)>0,
          familyEligible:kind==="FAMILY",
          activationPolicy:activation,
          allowedDebtMinor:"0",
          gracePeriodDays:activation==="GRACE_PERIOD"?7:0,
          entitlements:normalizedRules,
          noShowPolicy:noShow
        })
      });
      setShowBuilder(false);
      setNotice("Тариф создан и готов к выдаче клиентам.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать тариф");
    }finally{
      setPending(false);
    }
  }

  async function issuePackage(){
    if(!selectedCustomer||!selectedPlan){
      setError("Выберите клиента и тариф");
      return;
    }
    setPending(true);setError("");setNotice("");
    try{
      await apiRequest("/service/packages",{
        method:"POST",
        body:JSON.stringify({
          partyId:selectedCustomer,planId:selectedPlan,startsAt:new Date().toISOString()
        })
      });
      setNotice("Абонемент выдан клиенту.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось выдать абонемент");
    }finally{setPending(false);}
  }

  return(
    <main className="app-shell">
      <AppSidebar active="service-packages"/>
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero compact">
          <div>
            <span className="studio-eyebrow">Тарифы и подписки</span>
            <h1>Абонементы</h1>
            <p>
              Простые пакеты и сложные COMBO-тарифы с ограничениями по услуге,
              тренеру, дням недели и времени.
            </p>
          </div>
          <div className="studio-hero-actions">
            <button className="secondary-button" type="button" onClick={()=>resetBuilder("VISITS")}>
              + Новый тариф
            </button>
            <a className="secondary-button" href="/app/dance/setup">Настройка услуг</a>
          </div>
        </header>

        {error?<div className="studio-message error"><strong>Проверьте данные</strong><span>{error}</span></div>:null}
        {notice?<div className="studio-message success"><strong>Готово</strong><span>{notice}</span></div>:null}

        <div className="studio-score-grid">
          <article><span>Активных абонементов</span><strong>{activePackages.length}</strong><p>{plans.length} тарифов в каталоге.</p></article>
          <article><span>Заканчиваются за 7 дней</span><strong>{expiring}</strong><p>Готовый список для продления.</p></article>
          <article><span>Доступно посещений</span><strong>{activePackages.some(x=>x.available_visits===null)?"∞":activePackages.reduce((s,x)=>s+Number(x.available_visits??0),0)}</strong><p>По всем активным клиентам.</p></article>
          <article><span>Гибкие тарифы</span><strong>{plans.filter(x=>(x.entitlements?.length??0)>0).length}</strong><p>С отдельными правилами доступа.</p></article>
        </div>

        <section className="studio-section">
          <div className="studio-section-head">
            <div><span>Быстрый старт</span><h2>Какой тариф нужен?</h2><p>Выберите основу — все параметры можно изменить перед сохранением.</p></div>
          </div>
          <div className="package-preset-grid">
            <button type="button" onClick={()=>resetBuilder("VISITS")}><span>01</span><strong>Пакет посещений</strong><p>8, 12 или любое количество занятий.</p></button>
            <button type="button" onClick={()=>resetBuilder("UNLIMITED")}><span>02</span><strong>Безлимит</strong><p>Неограниченные посещения на период.</p></button>
            <button type="button" onClick={()=>resetBuilder("COMBO")}><span>03</span><strong>COMBO</strong><p>Например, группа + самостоятельная практика.</p></button>
            <button type="button" onClick={()=>resetBuilder("FAMILY")}><span>04</span><strong>Семейный</strong><p>Один платёж и несколько детей-бенефициаров.</p></button>
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-head">
            <div><span>Продажа</span><h2>Выдать абонемент</h2><p>Выберите клиента и уже настроенный тариф.</p></div>
          </div>
          <div className="premium-inline-form">
            <label><span>Клиент</span><select value={selectedCustomer} onChange={e=>setSelectedCustomer(e.target.value)}><option value="">Выберите клиента</option>{customers.map(c=><option key={c.id} value={c.id}>{c.displayName}{c.phone?" · "+c.phone:""}</option>)}</select></label>
            <label><span>Тариф</span><select value={selectedPlan} onChange={e=>setSelectedPlan(e.target.value)}><option value="">Выберите тариф</option>{plans.map(p=><option key={p.id} value={p.id}>{p.name} · {money(p.price_minor,p.currency)}</option>)}</select></label>
            <button disabled={pending} type="button" onClick={()=>void issuePackage()}>{pending?"Сохраняем…":"Выдать"}</button>
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-head"><div><span>Каталог</span><h2>Тарифы</h2><p>Все условия видны без открытия карточки.</p></div></div>
          <div className="premium-plan-grid">
            {plans.map(plan=>(
              <article key={plan.id}>
                <header><span>{formatKind(plan.package_kind)}</span><strong>{money(plan.price_minor,plan.currency)}</strong></header>
                <h3>{plan.name}</h3>
                <p>{plan.visit_limit===null?"Безлимит":plan.visit_limit+" посещений"} · {plan.duration_days} дней</p>
                <div className="premium-plan-tags">
                  {plan.freeze_days_allowed>0?<span>Заморозка {plan.freeze_days_allowed} дн.</span>:null}
                  {plan.allow_makeup?<span>Отработки {plan.makeup_days_valid} дн.</span>:null}
                  <span>{plan.no_show_policy==="CONSUME"?"No-show списывается":"No-show не списывается"}</span>
                </div>
                {(plan.entitlements??[]).length?(
                  <div className="premium-entitlement-list">
                    {(plan.entitlements??[]).map((rule,index)=>(
                      <div key={rule.id??index}>
                        <b>{rule.lessonType??"Любой формат"}</b>
                        <span>{rule.visitLimit===null?"без лимита":rule.visitLimit+" посещ."} · {time(rule.startMinute)}–{time(rule.endMinute)}</span>
                      </div>
                    ))}
                  </div>
                ):<small>Действует без дополнительных ограничений.</small>}
              </article>
            ))}
            {!plans.length?<div className="studio-empty"><span>01</span><strong>Тарифов пока нет</strong><p>Создайте первый пакет за несколько шагов.</p></div>:null}
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-head"><div><span>Клиенты</span><h2>Выданные абонементы</h2><p>Остаток, резервы и срок действия.</p></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Клиент</th><th>Абонемент</th><th>Использовано</th><th>В резерве</th><th>Осталось</th><th>До</th><th>Статус</th></tr></thead>
              <tbody>
                {packages.map(item=>(
                  <tr key={item.id}>
                    <td><strong>{item.party_name}</strong></td><td>{item.plan_name}</td>
                    <td>{item.used_visits}</td><td>{item.reserved_visits}</td>
                    <td><strong>{item.available_visits===null?"∞":item.available_visits}</strong></td>
                    <td>{new Date(item.expires_at).toLocaleDateString("ru-RU")}</td>
                    <td><span className="status-pill">{item.status}</span></td>
                  </tr>
                ))}
                {!packages.length?<tr><td colSpan={7}><div className="table-empty"><strong>Абонементы ещё не выдавались</strong></div></td></tr>:null}
              </tbody>
            </table>
          </div>
        </section>

        {showBuilder?(
          <div className="studio-drawer-backdrop" onMouseDown={()=>setShowBuilder(false)}>
            <aside className="studio-drawer package-builder" onMouseDown={e=>e.stopPropagation()}>
              <header><div><span>Конструктор тарифа</span><h2>Условия абонемента</h2></div><button className="studio-close" type="button" onClick={()=>setShowBuilder(false)}>×</button></header>
              <form onSubmit={createPlan}>
                <label><span>Название</span><input value={name} onChange={e=>setName(e.target.value)} required/></label>
                <div className="studio-form-grid">
                  <label><span>Тип</span><select value={kind} onChange={e=>setKind(e.target.value as PackagePlan["package_kind"])}><option value="VISITS">Пакет посещений</option><option value="PERIOD">На период</option><option value="UNLIMITED">Безлимит</option><option value="FAMILY">Семейный</option><option value="INDIVIDUAL">Персональный</option><option value="COMBO">COMBO</option><option value="TRIAL">Пробный</option><option value="GIFT">Подарочный</option></select></label>
                  <label><span>Цена, ₽</span><input inputMode="decimal" value={price} onChange={e=>setPrice(e.target.value)}/></label>
                </div>
                <div className="studio-form-grid">
                  {kind!=="UNLIMITED"?<label><span>Всего посещений</span><input type="number" min="1" value={visits} onChange={e=>setVisits(e.target.value)}/></label>:<div className="package-unlimited-note"><strong>Безлимит</strong><span>Общий счётчик посещений не ограничен.</span></div>}
                  <label><span>Срок, дней</span><input type="number" min="1" value={days} onChange={e=>setDays(e.target.value)}/></label>
                </div>
                <div className="studio-form-grid">
                  <label><span>Заморозка, дней</span><input type="number" min="0" value={freezeDays} onChange={e=>setFreezeDays(e.target.value)}/></label>
                  <label><span>Отработка действует, дней</span><input type="number" min="0" value={makeupDays} onChange={e=>setMakeupDays(e.target.value)}/></label>
                </div>
                <div className="studio-form-grid">
                  <label><span>No-show</span><select value={noShow} onChange={e=>setNoShow(e.target.value as "RELEASE"|"CONSUME")}><option value="RELEASE">Не списывать посещение</option><option value="CONSUME">Списывать посещение</option></select></label>
                  <label><span>Активация</span><select value={activation} onChange={e=>setActivation(e.target.value)}><option value="FULL_PAYMENT">После полной оплаты</option><option value="IMMEDIATE">Сразу</option><option value="PROPORTIONAL">По оплаченной доле</option><option value="GRACE_PERIOD">С льготным периодом</option></select></label>
                </div>

                <div className="package-rules-head">
                  <div><strong>Правила доступа</strong><span>Необязательно. Нужны для COMBO и специальных тарифов.</span></div>
                  <button type="button" className="secondary-button" onClick={()=>setRules(current=>[...current,emptyRule()])}>+ Квота</button>
                </div>

                <div className="package-rule-list">
                  {rules.map((rule,index)=>(
                    <article key={index}>
                      <header><strong>Квота {index+1}</strong><button type="button" onClick={()=>setRules(current=>current.filter((_,i)=>i!==index))}>Удалить</button></header>
                      <div className="studio-form-grid">
                        <label><span>Формат</span><select value={rule.lessonType} onChange={e=>updateRule(index,{lessonType:e.target.value as DraftRule["lessonType"]})}><option value="">Любой</option><option value="GROUP">Группа</option><option value="INDIVIDUAL">Индивидуально</option><option value="SELF_PRACTICE">Самостоятельная практика</option></select></label>
                        <label><span>Квота посещений</span><input type="number" min="1" placeholder="Без отдельного лимита" value={rule.visitLimit} onChange={e=>updateRule(index,{visitLimit:e.target.value})}/></label>
                      </div>
                      <div className="studio-form-grid">
                        <label><span>Услуга</span><select value={rule.serviceId} onChange={e=>updateRule(index,{serviceId:e.target.value})}><option value="">Любая</option>{services.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
                        <label><span>Тренер</span><select value={rule.trainerResourceId} onChange={e=>updateRule(index,{trainerResourceId:e.target.value})}><option value="">Любой / без тренера</option>{trainers.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
                      </div>
                      <fieldset className="studio-weekdays"><legend>Дни</legend>{DAYS.map(([day,label])=><button key={day} type="button" className={rule.weekdays.includes(Number(day))?"active":""} onClick={()=>toggleRuleDay(index,Number(day))}>{label}</button>)}</fieldset>
                      <div className="package-time-row">
                        <label><span>С</span><input type="time" value={time(rule.startMinute)} onChange={e=>{const [h,m]=e.target.value.split(":").map(Number);updateRule(index,{startMinute:h*60+m});}}/></label>
                        <label><span>До</span><input type="time" value={time(rule.endMinute===1440?1439:rule.endMinute)} onChange={e=>{const [h,m]=e.target.value.split(":").map(Number);updateRule(index,{endMinute:h*60+m});}}/></label>
                      </div>
                    </article>
                  ))}
                </div>

                <div className="studio-drawer-actions"><button className="secondary-button" type="button" onClick={()=>setShowBuilder(false)}>Отмена</button><button disabled={pending} type="submit">{pending?"Сохраняем…":"Создать тариф"}</button></div>
              </form>
            </aside>
          </div>
        ):null}
      </section>
    </main>
  );
}
