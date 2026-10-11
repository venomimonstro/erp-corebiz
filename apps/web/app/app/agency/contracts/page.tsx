"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Project={id:string;name:string;currency:string};
type Contract={
  id:string;project_id:string;project_name:string;customer_name:string|null;
  contract_number:string;title:string;contract_type:string;billing_cycle:string;
  service_fee_minor:string;client_media_budget_minor:string;currency:string;
  starts_on:string;ends_on:string|null;signed_on:string|null;
  renewal_notice_days:number;status:string;version:number;renewal_due:boolean;
};
const types=[
  ["WEBSITE_BUILD","Разработка сайта"],["SUPPORT","Поддержка"],
  ["SEO","SEO"],["PPC","Контекстная реклама"],["SMM","SMM"],
  ["MARKETING_RETAINER","Комплексный маркетинг"],["OTHER","Другое"]
];
function minor(value:string){
  const clean=value.trim().replace(",",".");
  if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(clean))throw new Error("Укажите корректную сумму");
  const [rub,kopecks=""]=clean.split(".");
  return (BigInt(rub)*100n+BigInt(kopecks.padEnd(2,"0"))).toString();
}
const money=(v:string,c="RUB")=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:c,maximumFractionDigits:0
}).format(Number(v)/100);

export default function ContractsPage(){
  const [contracts,setContracts]=useState<Contract[]>([]);
  const [projects,setProjects]=useState<Project[]>([]);
  const [projectId,setProjectId]=useState("");
  const [number,setNumber]=useState("");
  const [title,setTitle]=useState("");
  const [kind,setKind]=useState("MARKETING_RETAINER");
  const [cycle,setCycle]=useState("MONTHLY");
  const [fee,setFee]=useState("0");
  const [media,setMedia]=useState("0");
  const [start,setStart]=useState(new Date().toISOString().slice(0,10));
  const [end,setEnd]=useState("");
  const [noticeDays,setNoticeDays]=useState("30");
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);

  const load=useCallback(async()=>{
    const [projects,contracts]=await Promise.all([
      apiRequest<Project[]>("/projects/agency/overview"),
      apiRequest<Contract[]>("/projects/agency/contracts")
    ]);
    setProjects(projects);setContracts(contracts);
  },[]);
  useEffect(()=>{void load().catch(e=>setError(e instanceof Error?e.message:"Не удалось загрузить договоры"));},[load]);

  const create=async()=>{
    if(!projectId||!number.trim()||!title.trim()){
      setError("Выберите проект, укажите номер и название договора");return;
    }
    setBusy(true);setError("");setMessage("");
    try{
      await apiRequest("/projects/"+projectId+"/contracts",{
        method:"POST",body:JSON.stringify({
          contractNumber:number.trim(),title:title.trim(),contractType:kind,
          billingCycle:cycle,serviceFeeMinor:minor(fee),clientMediaBudgetMinor:minor(media),
          startsOn:start,endsOn:end||undefined,renewalNoticeDays:Number(noticeDays)
        })
      });
      await load();
      setNumber("");setTitle("");setMessage("Черновик договора зарегистрирован.");
    }catch(e){setError(e instanceof Error?e.message:"Ошибка создания договора");}
    finally{setBusy(false);}
  };
  const transition=async(row:Contract,status:"ACTIVE"|"PAUSED"|"EXPIRED"|"TERMINATED")=>{
    if(status==="TERMINATED"&&!window.confirm("Завершить договор? Это действие нельзя отменить."))return;
    const signedOn=status==="ACTIVE"&&!row.signed_on
      ?window.prompt("Дата подписания (ГГГГ-ММ-ДД)",new Date().toISOString().slice(0,10))
      :undefined;
    if(status==="ACTIVE"&&!row.signed_on&&!signedOn?.trim())return;
    setBusy(true);setError("");setMessage("");
    try{
      await apiRequest("/projects/"+row.project_id+"/contracts/"+row.id+"/status",{
        method:"PATCH",body:JSON.stringify({
          status,version:row.version,signedOn:signedOn??undefined
        })
      });
      await load();
      setMessage("Статус договора обновлён.");
    }catch(e){setError(e instanceof Error?e.message:"Ошибка обновления договора");}
    finally{setBusy(false);}
  };

  const alerts=contracts.filter(c=>c.renewal_due);
  const currency=projects.find(p=>p.id===projectId)?.currency??"RUB";

  return <main className="app-shell">
    <AppSidebar active="agency"/>
    <section className="workspace workspace-wide agency-premium">
      <header className="agency-hero">
        <div><span className="studio-eyebrow">Клиенты и обязательства</span><h1>Договоры агентства</h1>
          <p>Ведите реестр договоров, услуги, сроки, стоимость и продления.
            Договоры пока не подписываются электронно в системе: дата подписания вносится вручную.</p></div>
        <div className="agency-hero-actions"><a className="secondary-button" href="/app/agency">← К агентству</a></div>
      </header>
      <div className="agency-score-grid">
        <article><span>Все договоры</span><strong>{contracts.length}</strong></article>
        <article><span>Активные</span><strong>{contracts.filter(c=>c.status==="ACTIVE").length}</strong></article>
        <article className={alerts.length?"is-risk":""}><span>Требуют продления</span><strong>{alerts.length}</strong><small>по настроенным срокам уведомления</small></article>
      </div>
      <section className="agency-board">
        <div className="studio-section-head"><div><h2>Новый договор</h2>
          <p>Регистрация документа отдельно от выставления счетов. Не создаёт списаний и не изменяет сумму проекта.</p></div></div>
        <div className="agency-hero-actions">
          <select aria-label="Клиентский проект" value={projectId} onChange={e=>setProjectId(e.target.value)}>
            <option value="">Выберите проект</option>
            {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input aria-label="Номер договора" placeholder="Номер договора" maxLength={80} value={number} onChange={e=>setNumber(e.target.value)}/>
          <input aria-label="Название договора" placeholder="Название договора" maxLength={220} value={title} onChange={e=>setTitle(e.target.value)}/>
        </div>
        <div className="agency-hero-actions">
          <select aria-label="Услуга" value={kind} onChange={e=>setKind(e.target.value)}>
            {types.map(([code,name])=><option key={code} value={code}>{name}</option>)}
          </select>
          <select aria-label="Периодичность" value={cycle} onChange={e=>setCycle(e.target.value)}>
            <option value="ONE_TIME">Разово</option><option value="MONTHLY">Ежемесячно</option>
            <option value="QUARTERLY">Ежеквартально</option>
          </select>
          <label>Вознаграждение, {currency}
            <input inputMode="decimal" value={fee} onChange={e=>setFee(e.target.value)}/>
          </label>
          <label>Медиабюджет клиента, {currency}
            <input inputMode="decimal" value={media} onChange={e=>setMedia(e.target.value)}/>
          </label>
        </div>
        <div className="agency-hero-actions">
          <label>Начало <input type="date" value={start} onChange={e=>setStart(e.target.value)}/></label>
          <label>Окончание <input type="date" value={end} onChange={e=>setEnd(e.target.value)}/></label>
          <label>Уведомить за дней <input type="number" min={0} max={365} value={noticeDays} onChange={e=>setNoticeDays(e.target.value)}/></label>
          <button disabled={busy||!projectId} onClick={()=>void create()}>{busy?"Сохранение…":"Зарегистрировать договор"}</button>
        </div>
        {error?<p role="alert" className="studio-message error">{error}</p>:null}
        {message?<p role="status">{message}</p>:null}
      </section>
      <section className="agency-board">
        <div className="studio-section-head"><div><h2>Договоры клиентов</h2>
          <p>Первыми показаны договоры, срок продления которых приближается или уже наступил.</p></div></div>
        <div className="agency-project-grid">
          {contracts.map(c=><article key={c.id} className="agency-project-card">
            <header><div><span className="agency-client">{c.customer_name??c.project_name}</span>
              <h3>{c.contract_number}: {c.title}</h3>
              <p>{c.contract_type} · {c.billing_cycle}</p>
            </div><span className={"agency-health "+(c.renewal_due?"risk":"ok")}>
              {c.renewal_due?"Продление":c.status}</span></header>
            <div className="agency-money-row"><div><span>Услуги</span>
              <strong>{money(c.service_fee_minor,c.currency)}</strong></div>
              <div><span>Бюджет клиента</span><strong>{money(c.client_media_budget_minor,c.currency)}</strong></div></div>
            <p>Действует с {new Date(c.starts_on).toLocaleDateString("ru-RU")}
              {c.ends_on?" по "+new Date(c.ends_on).toLocaleDateString("ru-RU"):" · без даты окончания"}</p>
            <footer>
              {c.status==="DRAFT"?
                <button disabled={busy} onClick={()=>void transition(c,"ACTIVE")}>Отметить подписанным</button>:null}
              {c.status==="ACTIVE"?<>
                <button disabled={busy} onClick={()=>void transition(c,"PAUSED")}>Приостановить</button>
                <button disabled={busy} onClick={()=>void transition(c,"EXPIRED")}>Истёк</button>
                <button disabled={busy} onClick={()=>void transition(c,"TERMINATED")}>Завершить</button>
              </>:null}
              {c.status==="PAUSED"?<button disabled={busy} onClick={()=>void transition(c,"ACTIVE")}>Возобновить</button>:null}
              <a href={"/app/projects/"+c.project_id}>Открыть проект</a>
            </footer>
          </article>)}
        </div>
        {!contracts.length?<p>Договоров пока нет.</p>:null}
      </section>
    </section>
  </main>;
}
