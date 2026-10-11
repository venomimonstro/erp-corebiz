"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Project={id:string;name:string;currency:string;status:string};
type Staff={membership_id:string;email:string;allocated_percent:number};
type Member={
  membership_id:string;email:string;role_code:string;allocation_percent:number;
  cost_rate_minor:string|null;billable_rate_minor:string|null;
  status:string;month_minutes:number;
};
const roles=[
  ["SPECIALIST","Специалист"],["PROJECT_MANAGER","Проджект-менеджер"],
  ["ACCOUNT_MANAGER","Аккаунт-менеджер"],["DESIGNER","Дизайнер"],
  ["DEVELOPER","Разработчик"],["QA","Тестировщик"],["SEO","SEO"],
  ["PPC","Контекстная реклама"],["SMM","SMM"],
  ["ANALYST","Аналитик"],["COPYWRITER","Копирайтер"],["OTHER","Другое"]
];
function minor(value:string){
  const parsed=value.trim().replace(",",".");
  if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(parsed))
    throw new Error("Ставка должна быть положительной суммой, максимум 2 знака после запятой");
  const [whole,fraction=""]=parsed.split(".");
  return (BigInt(whole)*100n+BigInt(fraction.padEnd(2,"0"))).toString();
}
function rub(minorValue:string|null) {
  if(minorValue===null)return "0";
  return (Number(minorValue)/100).toFixed(2);
}

export default function AgencyTeamPage(){
  const [projects,setProjects]=useState<Project[]>([]);
  const [staff,setStaff]=useState<Staff[]>([]);
  const [projectId,setProjectId]=useState("");
  const [members,setMembers]=useState<Member[]>([]);
  const [membershipId,setMembershipId]=useState("");
  const [role,setRole]=useState("SPECIALIST");
  const [allocation,setAllocation]=useState("100");
  const [costRate,setCostRate]=useState("0");
  const [billableRate,setBillableRate]=useState("0");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);

  const refresh=useCallback(async(id:string)=>{
    if(!id){setMembers([]);return;}
    setMembers(await apiRequest<Member[]>("/projects/"+id+"/team"));
  },[]);
  useEffect(()=>{
    Promise.all([
      apiRequest<Project[]>("/projects/agency/overview"),
      apiRequest<Staff[]>("/projects/agency/staff")
    ]).then(([projects,staff])=>{setProjects(projects);setStaff(staff);})
      .catch(e=>setError(e instanceof Error?e.message:"Не удалось загрузить сотрудников"));
  },[]);
  useEffect(()=>{
    setError("");setNotice("");
    void refresh(projectId).catch(e=>
      setError(e instanceof Error?e.message:"Не удалось получить состав команды"));
  },[projectId,refresh]);

  const fill=(m:Member)=>{
    setMembershipId(m.membership_id);
    setRole(m.role_code);
    setAllocation(String(m.allocation_percent));
    setCostRate(rub(m.cost_rate_minor));
    setBillableRate(rub(m.billable_rate_minor));
    setNotice("Данные сотрудника перенесены в форму.");
  };

  const save=async(memberId=membershipId,status:"ACTIVE"|"ARCHIVED"="ACTIVE",
    row?:Member)=>{
    setError("");setNotice("");
    if(!projectId||!memberId){setError("Выберите проект и сотрудника");return;}
    setBusy(true);
    try{
      const percent=row?.allocation_percent??Number(allocation);
      if(!Number.isInteger(percent)||percent<1||percent>100)
        throw new Error("Загрузка должна быть от 1 до 100%");
      const data={
        roleCode:row?.role_code??role,
        allocationPercent:percent,
        costRateMinor:row?row.cost_rate_minor??"0":minor(costRate),
        billableRateMinor:row?row.billable_rate_minor??"0":minor(billableRate),
        status
      };
      await apiRequest("/projects/"+projectId+"/team/"+memberId,{
        method:"PUT",body:JSON.stringify(data)
      });
      await refresh(projectId);
      setStaff(await apiRequest<Staff[]>("/projects/agency/staff"));
      setNotice(status==="ARCHIVED"?"Назначение завершено. История не удалена.":"Назначение сохранено.");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось назначить сотрудника");}
    finally{setBusy(false);}
  };

  const currency=projects.find(p=>p.id===projectId)?.currency??"RUB";
  return <main className="app-shell">
    <AppSidebar active="agency"/>
    <section className="workspace workspace-wide agency-premium">
      <header className="agency-hero">
        <div>
          <span className="studio-eyebrow">Управление ресурсами</span>
          <h1>Команда агентства</h1>
          <p>Назначайте сотрудников, распределяйте загрузку и задавайте себестоимость часа.
            Без ставки труд не включается в достоверную прибыль и закрытие месяца блокируется.</p>
        </div>
        <div className="agency-hero-actions"><a href="/app/agency" className="secondary-button">← К клиентскому портфелю</a></div>
      </header>
      <section className="agency-board">
        <div className="studio-section-head"><div><h2>Назначить сотрудника</h2>
          <p>Общая плановая загрузка сотрудника на активных проектах не должна превышать 100%.</p></div></div>
        <div className="agency-hero-actions">
          <select aria-label="Проект" value={projectId} onChange={e=>setProjectId(e.target.value)}>
            <option value="">Выберите проект</option>
            {projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select aria-label="Сотрудник" value={membershipId} onChange={e=>setMembershipId(e.target.value)}>
            <option value="">Выберите сотрудника</option>
            {staff.map(m=><option key={m.membership_id} value={m.membership_id}>
              {m.email} ({m.allocated_percent}% занято)
            </option>)}
          </select>
          <select aria-label="Роль" value={role} onChange={e=>setRole(e.target.value)}>
            {roles.map(([code,label])=><option key={code} value={code}>{label}</option>)}
          </select>
        </div>
        <div className="agency-hero-actions">
          <label>Загрузка, %
            <input type="number" min={1} max={100} value={allocation} onChange={e=>setAllocation(e.target.value)}/>
          </label>
          <label>Себестоимость часа, {currency}
            <input inputMode="decimal" value={costRate} onChange={e=>setCostRate(e.target.value)}/>
          </label>
          <label>Стоимость часа клиенту, {currency}
            <input inputMode="decimal" value={billableRate} onChange={e=>setBillableRate(e.target.value)}/>
          </label>
          <button disabled={busy||!projectId||!membershipId} onClick={()=>void save()}>
            {busy?"Сохранение…":"Сохранить назначение"}
          </button>
        </div>
        {error?<p className="studio-message error" role="alert">{error}</p>:null}
        {notice?<p role="status">{notice}</p>:null}
      </section>
      <section className="agency-board">
        <div className="studio-section-head"><div><h2>Состав команды</h2>
          <p>Списанные часы показывают факт текущего месяца; проценты показывают план.</p></div></div>
        <div className="agency-project-grid">
          {members.map(m=><article key={m.membership_id} className="agency-project-card">
            <header><div><span className="agency-client">{m.role_code}</span><h3>{m.email}</h3></div>
              <span className="agency-health">{m.status}</span></header>
            <div className="agency-progress-row">
              <div><span>Загрузка</span><strong>{m.allocation_percent}%</strong></div>
              <div><span>Часы в месяце</span><strong>{Math.round(m.month_minutes/60*10)/10} ч</strong></div>
              {m.cost_rate_minor!==null?<div><span>Себестоимость часа</span>
                <strong>{rub(m.cost_rate_minor)} {currency}</strong></div>:null}
            </div>
            <footer>
              <button disabled={busy} onClick={()=>fill(m)}>Изменить</button>
              {m.status==="ACTIVE"&&m.cost_rate_minor!==null&&m.billable_rate_minor!==null?
                <button disabled={busy} onClick={()=>void save(m.membership_id,"ARCHIVED",m)}>Убрать с проекта</button>:null}
            </footer>
          </article>)}
        </div>
        {projectId&&members.length===0?<p>Пока никто не назначен на проект.</p>:null}
      </section>
    </section>
  </main>;
}
