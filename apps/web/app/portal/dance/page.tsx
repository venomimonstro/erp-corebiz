"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {apiRequest} from "../../../lib/api";

type Student={id:string;party_id:string;display_name:string;status:string;training_level:string|null};
type Group={student_id:string;group_name:string;program_name:string;
  trainer_name:string|null;enrollment_status:string};
type Visit={student_id:string;lesson_id:string;starts_at:string;ends_at:string;
  group_name:string|null;program_name:string|null;trainer_name:string|null;
  room_name:string|null;lesson_status:string;attendance_status:string};
type Package={id:string;party_id:string;beneficiary_party_ids:string[];plan_name:string;status:string;
  expires_at:string;visit_limit_snapshot:number;reserved_visits:number;
  used_visits:number;available_visits:number};
type Charge={id:string;student_id:string;amount_minor:string;
  paid_minor:string|null;remaining_minor:string|null;
  finance_verified:boolean;currency:string;status:string;due_at:string|null};
type Portal={person:{name:string;partyId:string};students:Student[];
  groups:Group[];visits:Visit[];packages:Package[];charges:Charge[]};

const price=(value:string)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB",maximumFractionDigits:0
}).format(Number(value)/100);
const date=(text:string)=>new Intl.DateTimeFormat("ru-RU",{
  timeZone:"Europe/Moscow",day:"2-digit",month:"long",year:"numeric"
}).format(new Date(text));
const clock=(text:string)=>new Intl.DateTimeFormat("ru-RU",{
  timeZone:"Europe/Moscow",hour:"2-digit",minute:"2-digit"
}).format(new Date(text));
export default function DanceCustomerPage(){
  const [data,setData]=useState<Portal|null>(null);
  const [selected,setSelected]=useState("");
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const reload=useCallback(async()=>{
    setPending(true);setError("");setData(null);
    try{
      const payload=await apiRequest<Portal>("/dance/portal/me");
      setData(payload);
      setSelected(prev=>payload.students.some(s=>s.id===prev)?prev:
        payload.students[0]?.id??"");
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось открыть кабинет");
    }finally{setPending(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  const [signingOut,setSigningOut]=useState(false);
  async function signOut(){
    if(signingOut)return;
    setSigningOut(true);setError("");
    try{
      await apiRequest("/auth/logout",{method:"POST",body:JSON.stringify({})});
      setData(null);
      // Navigation only happens AFTER the server revoked the session.
      window.location.assign("/login?next=%2Fportal%2Fdance");
    }catch(cause){
      setError(cause instanceof Error?cause.message:
        "Выход не подтверждён сервером. Повторите действие.");
      setSigningOut(false);
    }
  }

  const student=useMemo(()=>data?.students.find(s=>s.id===selected),[data,selected]);
  const visits=useMemo(()=>(data?.visits??[]).filter(v=>v.student_id===selected)
    .sort((a,b)=>Date.parse(b.starts_at)-Date.parse(a.starts_at)),[data,selected]);
  const upcoming=useMemo(()=>visits.filter(v=>
    Date.parse(v.starts_at)>=Date.now() &&
    !v.lesson_status.startsWith("CANCELLED")
  ).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at)),[visits]);
  const history=useMemo(()=>visits.filter(v=>
    Date.parse(v.starts_at)<Date.now()||
    v.lesson_status.startsWith("CANCELLED")
  ).sort((a,b)=>Date.parse(b.starts_at)-Date.parse(a.starts_at)),[visits]);
  const groups=useMemo(()=>(data?.groups??[]).filter(v=>v.student_id===selected),
    [data,selected]);
  const charges=useMemo(()=>(data?.charges??[]).filter(v=>v.student_id===selected),
    [data,selected]);
  const packages=useMemo(()=>data?.packages.filter(p=>
    p.party_id===student?.party_id ||
    p.beneficiary_party_ids?.includes(student?.party_id??"")
  )??[],[data,student?.party_id]);
  const unassignedFamilyPasses=useMemo(()=>(data?.packages??[]).filter(p=>
    p.party_id===data?.person.partyId &&
    !data?.students.some(student=>student.party_id===p.party_id ||
      p.beneficiary_party_ids?.includes(student.party_id))
  ),[data]);
  const due=charges.reduce((sum,c)=>sum+
    (c.finance_verified&&c.remaining_minor!==null?
      BigInt(c.remaining_minor):0n),0n);
  const unverified=charges.filter(c=>!c.finance_verified).length;
  return <main className="dance-customer-portal">
    <header className="dance-customer-head">
      <div><p>COREBIZ · КАБИНЕТ КЛИЕНТА</p>
        <h1>Мои занятия</h1>
        <span>Расписание и абонементы вашей студии</span>
      </div>
      <nav aria-label="Аккаунт клиента">
        <button type="button" disabled={signingOut}
          onClick={()=>void signOut()}>
          {signingOut?"Выходим…":"Выйти из кабинета"}
        </button>
      </nav>
    </header>
    {pending?<p role="status">Загружаем данные…</p>:null}
    {error?<section role="alert" className="dance-customer-alert">
      <strong>Кабинет пока недоступен</strong>
      <p>{error}. Если вы недавно получили приглашение, администратору
        студии необходимо связать ваш аккаунт с карточкой клиента.</p>
      <button onClick={()=>void reload()}>Повторить проверку</button>
      <p><a href="/login?next=%2Fportal%2Fdance">Войти под своим логином</a></p>
    </section>:null}
    {data?<>
      <section className="dance-customer-intro">
        <h2>{data.person.name}</h2>
        <p>Информация видна только вам и вашим детям, подтверждённым студией.</p>
        <div className="dance-customer-selection">
          <label htmlFor="dance-customer-student">Кому показать занятия</label>
          <select id="dance-customer-student" value={selected}
            onChange={e=>setSelected(e.target.value)}>
            {data.students.map(s=><option key={s.id} value={s.id}>
              {s.display_name}</option>)}
          </select>
          <button onClick={()=>void reload()} disabled={pending}>Обновить</button>
        </div>
      </section>
      {student?<div className="dance-customer-main">
        <section className="dance-customer-metrics" aria-label="Главная информация">
          <div><small>Ближайшие занятия</small>
            <strong>{visits.filter(v=>Date.parse(v.starts_at)>Date.now()
              &&!v.lesson_status.startsWith("CANCELLED")).length}</strong></div>
          <div><small>Группы</small><strong>{groups.length}</strong></div>
          <div><small>Подтверждённая задолженность</small><strong>{price(due.toString())}</strong></div>
        </section>
        <section className="dance-customer-panel">
          <h2>Группы и тренеры</h2>
          {groups.length===0?<p>Запись в группы пока отсутствует.</p>:
            <div className="dance-customer-list">{groups.map((g,i)=>
              <article key={g.group_name+"-"+i}>
                <strong>{g.group_name}</strong>
                <span>{g.program_name} · {g.trainer_name??"Тренер уточняется"}</span>
                <small>Статус: {g.enrollment_status}</small>
              </article>)}</div>}
        </section>
        <section className="dance-customer-panel">
          <h2>Ближайшие занятия</h2>
          {upcoming.length===0?<p>Будущих занятий пока нет.</p>:
            <div className="dance-customer-list">{upcoming.slice(0,50).map(v=>
              <article key={v.lesson_id}>
                <strong>{date(v.starts_at)} · {clock(v.starts_at)}</strong>
                <span>{v.group_name??v.program_name??"Индивидуальное занятие"}
                  {" · "}{v.trainer_name??"Тренер уточняется"}</span>
                <small>{v.room_name??"Зал уточняется"} · {v.attendance_status}</small>
              </article>)}</div>}
        </section>
        <section className="dance-customer-panel">
          <h2>История посещений</h2>
          {history.length===0?<p>Прошедших занятий пока нет.</p>:
            <div className="dance-customer-list">{history.slice(0,100).map(v=>
              <article key={v.lesson_id}>
                <strong>{date(v.starts_at)} · {clock(v.starts_at)}</strong>
                <span>{v.group_name??v.program_name??"Индивидуальное занятие"}
                  {" · "}{v.trainer_name??"Тренер уточняется"}</span>
                <small>{v.room_name??"Зал уточняется"} · {v.attendance_status}</small>
              </article>)}</div>}
        </section>
        <section className="dance-customer-panel">
          <h2>Мои абонементы</h2>
          {packages.length===0?<p>Абонементов для выбранного ученика пока нет.</p>:
            <div className="dance-customer-list">{packages.map(p=>
              <article key={p.id}><strong>{p.plan_name}</strong>
                <span>Действует до {date(p.expires_at)}</span>
                <small>{p.status==="ACTIVE"
                  ?"Доступно занятий: "+p.available_visits
                  :p.status==="PENDING_PAYMENT"
                    ?"Ожидает подтверждения оплаты. Посещения пока недоступны"
                    :"Посещения недоступны · "+p.status}
                </small>
              </article>)}</div>}
        </section>
        {unassignedFamilyPasses.length>0?(
          <section className="dance-customer-panel">
            <h2>Семейные абонементы без назначенного ученика</h2>
            <p>Абонемент оформлен на ваш аккаунт, но пока не назначен ребёнку.
              Для использования попросите администратора добавить получателя.</p>
            <div className="dance-customer-list">{unassignedFamilyPasses.map(p=>
              <article key={p.id}><strong>{p.plan_name}</strong>
                <span>{p.status==="ACTIVE"?"Активен":"Статус: "+p.status}</span>
                <small>Управление получателями выполняет студия</small>
              </article>)}</div>
          </section>
        ):null}
        <section className="dance-customer-panel">
          <h2>Оплаты и задолженность</h2>
          <p>Поступления подтверждаются финансовыми обязательствами.
            Без такой связи суммы не считаются оплаченными или просроченными.</p>
          {unverified>0?<p role="status">Не подтверждена финансовая связь у
            {unverified} начислений. Обратитесь к менеджеру для сверки.</p>:null}
          {charges.length===0?<p>Начислений по выбранному ученику нет.</p>:
            <div className="dance-customer-list">{charges.map(c=>
              <article key={c.id}><strong>Начислено {price(c.amount_minor)}</strong>
                <span>{c.finance_verified&&c.paid_minor!==null&&c.remaining_minor!==null
                  ?"Оплачено "+price(c.paid_minor)+" · к оплате "+
                    price(c.remaining_minor)
                  :"Платёж и задолженность требуют сверки в студии"}</span>
                <small>{c.due_at?"Срок "+date(c.due_at)+" · ":""}{c.status}</small>
              </article>)}</div>}
        </section>
      </div>:<p>В кабинете нет привязанных учеников. Обратитесь к менеджеру студии.</p>}
      <footer className="dance-customer-footer">Данные обновляются из учёта студии.
        Оплата через этот экран пока не подключена. Подтверждение платежей
        выполняется финансовым контуром CoreBiz.</footer>
    </>:null}
  </main>;
}
