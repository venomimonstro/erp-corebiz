"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {apiRequest} from "../../../lib/api";
type Lesson={
  id:string;lesson_type:string;status:string;starts_at:string;ends_at:string;
  trainer_resource_id:string;branch_name:string|null;
  group_name:string|null;direction_name:string|null;room_name:string|null;
  booked_count:number;attended_count:number;
};
type TrainerCalendar={
  trainer:{id:string;name:string;timezone:string};
  resources:Array<{id:string;name:string;timezone:string;branch_name:string|null}>;
  from:string;to:string;lessons:Lesson[]
};
const dateInMoscow=(date:Date)=>new Intl.DateTimeFormat("sv-SE",{
  timeZone:"Europe/Moscow",year:"numeric",month:"2-digit",day:"2-digit"
}).format(date);
const moscowTime=(x:string,zone:string)=>new Intl.DateTimeFormat("ru-RU",{
  timeZone:zone,day:"2-digit",month:"long",hour:"2-digit",minute:"2-digit"
}).format(new Date(x));
export default function DanceTrainerPage(){
  const [month,setMonth]=useState(()=>dateInMoscow(new Date()).slice(0,7));
  const [data,setData]=useState<TrainerCalendar|null>(null);
  const [busy,setBusy]=useState(false);
  const [signingOut,setSigningOut]=useState(false);
  const [error,setError]=useState("");
  const reload=useCallback(async()=>{
    setBusy(true);setData(null);setError("");
    try{
      const [year,m]=month.split("-").map(Number);
      if(!year||!m||m<1||m>12)throw new Error("Некорректный месяц");
      const start=year+"-"+String(m).padStart(2,"0")+"-01";
      const end=new Date(Date.UTC(year,m,1)).toISOString().slice(0,10);
      const result=await apiRequest<TrainerCalendar>(
        "/dance/trainer/me?from="+encodeURIComponent(start)+
        "&to="+encodeURIComponent(end)
      );
      setData(result);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось открыть календарь");}
    finally{setBusy(false);}
  },[month]);
  useEffect(()=>{void reload();},[reload]);
  async function signOut(){
    if(signingOut)return;
    setSigningOut(true);setError("");
    try{
      await apiRequest("/auth/logout",{
        method:"POST",body:JSON.stringify({})
      });
      setData(null);
      window.location.assign("/login?next=%2Fportal%2Ftrainer");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Выход не подтверждён сервером");
      setSigningOut(false);
    }
  }
  const resourceById=useMemo(()=>new Map((data?.resources??[]).map(r=>[r.id,r])),
    [data?.resources]);
  const branchLoads=useMemo(()=>{
    const rows=data?.lessons.filter(x=>!x.status.startsWith("CANCELLED"))??[];
    return (data?.resources??[]).map(r=>{
      const own=rows.filter(x=>x.trainer_resource_id===r.id);
      return {
        id:r.id,
        branch:r.branch_name??"Филиал не указан",
        lessons:own.length,
        hours:own.reduce((sum,x)=>sum+Math.max(0,
          (Date.parse(x.ends_at)-Date.parse(x.starts_at))/3600000),0)
      };
    });
  },[data]);

  const metrics=useMemo(()=>{
    const rows=data?.lessons.filter(x=>!x.status.startsWith("CANCELLED"))??[];
    return {
      count:rows.length,
      hours:rows.reduce((sum,x)=>sum+Math.max(0,
        (Date.parse(x.ends_at)-Date.parse(x.starts_at))/3600000),0),
      attendees:rows.reduce((sum,x)=>sum+Number(x.booked_count??0),0)
    };
  },[data]);
  return <main className="dance-customer-portal">
    <header className="dance-customer-head">
      <div><p>COREBIZ · СТУДИЯ ТАНЦЕВ</p>
        <h1>Моё расписание</h1>
        <span>Личный календарь тренера. Без чужих данных и финансов студии.</span>
      </div>
      <nav aria-label="Аккаунт тренера">
        <button type="button" disabled={signingOut} onClick={()=>void signOut()}>
          {signingOut?"Выходим…":"Выйти"}
        </button>
      </nav>
    </header>
    <section className="dance-customer-intro">
      <div className="dance-customer-selection">
        <label htmlFor="trainer-month">Месяц</label>
        <input id="trainer-month" type="month" value={month}
          onChange={e=>setMonth(e.target.value)}/>
        <button onClick={()=>void reload()} disabled={busy}>
          {busy?"Загружаем…":"Обновить календарь"}</button>
      </div>
      {error?<div role="alert" className="dance-customer-alert">
        <strong>Доступ к расписанию отсутствует</strong>
        <p>{error}. Попросите владельца пригласить вас с ролью «Тренер студии»
          и привязать логин к вашей карточке тренера.</p>
      </div>:null}
    </section>
    {data?<div className="dance-customer-main">
      <section className="dance-customer-metrics">
        <div><small>Тренер</small><strong className="dance-trainer-title">
          {data.trainer.name}</strong></div>
        <div><small>Занятий в месяце</small><strong>{metrics.count}</strong></div>
        <div><small>Часов нагрузки</small>
          <strong>{new Intl.NumberFormat("ru-RU",{
            maximumFractionDigits:1
          }).format(metrics.hours)} ч</strong></div>
      </section>
      <section className="dance-customer-panel">
        <h2>Нагрузка по филиалам</h2>
        <div className="dance-customer-list">
          {branchLoads.map(item=><article key={item.id}>
            <strong>{item.branch}</strong>
            <span>{item.lessons} занятий · {new Intl.NumberFormat("ru-RU",{
              maximumFractionDigits:1
            }).format(item.hours)} часа(ов)</span>
          </article>)}
        </div>
      </section>
      <section className="dance-customer-panel dance-trainer-list">
        <h2>Мои занятия и залы</h2>
        {data.lessons.length===0?<p>Запланированных занятий нет.</p>:
          <div className="dance-customer-list">{data.lessons.map(l=>
            <article key={l.id}>
              <strong>{moscowTime(l.starts_at,
                resourceById.get(l.trainer_resource_id)?.timezone
                  ??data.trainer.timezone)} · {l.branch_name??"Филиал не указан"}</strong>
              <span>{l.group_name??l.direction_name??"Индивидуальная тренировка"}
                {" · "}{l.room_name??"Зал уточняется"}</span>
              <small>{l.status} · Записано: {l.booked_count} ·
                Посетило: {l.attended_count}</small>
            </article>)}</div>}
      </section>
      <section className="dance-customer-panel">
        <h2>Как работать с расписанием</h2>
        <p>Время отображается в часовом поясе вашей студии.
          Если нужно перенести занятие, сменить зал или назначить замену,
          обратитесь к менеджеру. Изменение расписания сохраняет
          уже оформленные посещения и обязательства клиентов.</p>
        <p>Расчёт и утверждение зарплаты — отдельный процесс,
          здесь отображаются только занятия и загруженность.</p>
      </section>
    </div>:null}
    <footer className="dance-customer-footer">
      Данные загружаются из текущего расписания CoreBiz.
      Другие тренеры, личные данные учеников и финансы компании скрыты.
    </footer>
  </main>;
}
