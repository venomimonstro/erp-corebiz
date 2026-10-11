"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../components/dance-workspace-nav";
import {apiRequest} from "../../../lib/api";

type Lesson={
  id:string;group_name:string|null;program_name:string|null;lesson_type:string;
  starts_at:string;ends_at:string;lesson_timezone:string;capacity:number;
  status:string;trainer_name:string|null;room_name:string|null;
  booked_count:number;attended_count:number;
};
type Group={
  id:string;name:string;capacity:number;break_even_members:number;
  members:number;waitlist:number;
};
type Economics={
  id:string;name:string;lessons:number;revenue_minor:string;
  trainer_cost_minor:string;room_cost_minor:string;other_cost_minor:string;margin_minor:string;
};
type MonthEconomics={
  revenue_minor:string;trainer_cost_minor:string;room_cost_minor:string;margin_minor:string;
  payroll_total_minor:string;payroll_extra_minor:string;
  full_team_cost_minor:string;owner_margin_minor:string;
  payroll_expected_trainers:number;payroll_statement_count:number;payroll_finalized:boolean;
};
type Attention={
  unclosed_past_lessons:number;attended_without_payment_source:number;
  completed_without_profitability:number;completed_without_trainer_accrual:number;
  lesson_waitlist:number;over_capacity:number;
};
type Dashboard={
  canViewFinancials:boolean;
  todayLessons:Lesson[];groups:Group[];monthEconomics:MonthEconomics|null;
  debt:{open_count:number;open_minor:string;overdue_count:number}|null;
  packageAlerts:{expiring:number;low_visits:number};
  retentionAlerts:Array<{
    student_id:string;student_name:string;last_attended_at:string|null;
    days_since_activity:number;
  }>;
  economicsByProgram:Economics[];economicsByTrainer:Economics[];attention:Attention;
};

function money(minor:string){
  try{return new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",
    maximumFractionDigits:0}).format(Number(minor)/100);}
  catch{return "—";}
}
function clock(iso:string,timezone:string){
  try{return new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",
    timeZone:timezone}).format(new Date(iso));}
  catch{return new Date(iso).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"});}
}
function lessonStatus(status:string){
  return ({
    PLANNED:"Запланировано",OPEN_FOR_BOOKING:"Идёт запись",STARTED:"Идёт занятие",
    COMPLETED:"Завершено",CANCELLED_BY_STUDIO:"Отменено студией",
    CANCELLED_BY_TRAINER:"Отменено тренером"
  } as Record<string,string>)[status]??status;
}
function percent(item:Economics){
  const amount=Number(item.revenue_minor);
  return amount>0?Math.round(Number(item.margin_minor)/amount*100):0;
}

export default function DanceDashboardPage(){
  const [data,setData]=useState<Dashboard|null>(null);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(true);
  const [detail,setDetail]=useState(false);
  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{setData(await apiRequest<Dashboard>("/dance/dashboard"));}
    catch(e){setError(e instanceof Error?e.message:"Не удалось получить данные студии");}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);

  const alerts=useMemo(()=>{
    if(!data)return [];
    const a:Array<{id:string;label:string;count:number;href:string;kind:"danger"|"attention"}>=[];
    const add=(id:string,label:string,count:number,href:string,kind:"danger"|"attention")=>{
      if(count>0)a.push({id,label,count,href,kind});
    };
    add("late","Прошедшие уроки не закрыты",data.attention.unclosed_past_lessons,
      "/app/dance/groups","danger");
    add("capacity","Переполнение занятий",data.attention.over_capacity,
      "/app/dance/groups","danger");
    add("payment","Посещения без источника оплаты",
      data.canViewFinancials?data.attention.attended_without_payment_source:0,
      "/app/dance/students","danger");
    add("profit","Не рассчитана экономика закрытых занятий",
      data.canViewFinancials?data.attention.completed_without_profitability:0,
      "/app/dance/team","attention");
    add("accrual","Не начислена оплата тренеру",
      data.canViewFinancials?data.attention.completed_without_trainer_accrual:0,
      "/app/dance/team","attention");
    add("debts","Просроченные платежи",data.canViewFinancials?(data.debt?.overdue_count??0):0,
      "/app/dance/students","attention");
    add("waitlist","Ожидают свободное место",data.attention.lesson_waitlist,
      "/app/dance/groups","attention");
    add("packages","Абонементы скоро истекут",data.packageAlerts.expiring,
      "/app/dance/students","attention");
    return a;
  },[data]);
  const weakGroups=useMemo(()=>data?.groups.filter(g=>g.members<g.break_even_members)??[],[data]);
  const todayTotal=data?.todayLessons.length??0;
  const scheduledCount=data?.todayLessons.reduce((v,l)=>v+l.booked_count,0)??0;
  const attendedCount=data?.todayLessons.reduce((v,l)=>v+l.attended_count,0)??0;
  const upcoming=data?.todayLessons.filter(l=>!["COMPLETED","CANCELLED_BY_STUDIO",
    "CANCELLED_BY_TRAINER"].includes(l.status))??[];

  return <main className="app-shell">
    <AppSidebar active="dance"/>
    <section className="workspace workspace-wide studio-premium dance-overview">
      <header className="dance-head">
        <div>
          <span className="studio-eyebrow">Рабочее пространство · Студия танцев</span>
          <h1>Студия сегодня</h1>
          <p>Занятия, ученики и задачи, которые требуют решения.</p>
        </div>
        <div className="dance-head-actions">
          <button type="button" className="secondary-button"
            disabled={loading} onClick={()=>void load()}>
            {loading?"Обновление…":"Обновить данные"}
          </button>
          <a href="/app/dance/groups" className="button-link">Открыть расписание →</a>
        </div>
      </header>
      <DanceWorkspaceNav active="overview"/>
      {error?<div className="studio-message error" role="alert">
        <strong>Ошибка загрузки</strong><span>{error}</span>
        <button onClick={()=>void load()} type="button">Повторить</button>
      </div>:null}
      {!data&&loading?<p role="status" className="dance-loading">Загружаем расписание и события студии…</p>:null}
      {!data&&!loading&&!error?<p className="dance-loading">Нет данных для отображения.</p>:null}
      {data?<>
        <div className="dance-pulse">
          <article><span>Занятий сегодня</span><strong>{todayTotal}</strong>
            <small>{upcoming.length} ещё не закрыты</small></article>
          <article><span>Записано учеников</span><strong>{scheduledCount}</strong>
            <small>{attendedCount} уже отметили посещение</small></article>
          <article><span>Нужны решения</span>
            <strong className={alerts.length?"dance-text-attention":""}>{alerts.length}</strong>
            <small>категорий проблем</small></article>
          {data.canViewFinancials&&data.monthEconomics?
            <article><span>Результат месяца</span>
              <strong>{money(data.monthEconomics.owner_margin_minor)}</strong>
              <small>{data.monthEconomics.payroll_finalized?
                "зарплатные ведомости закрыты":"предварительно · ведомости не закрыты"}</small></article>
          :<article><span>Групп в работе</span><strong>{data.groups.length}</strong>
            <small>расписание и посещаемость</small></article>}
        </div>

        <section className="dance-focus">
          <div className="dance-panel-head">
            <div><span className="studio-eyebrow">Приоритеты</span>
              <h2>Что сделать сейчас</h2></div>
            <span className="dance-muted">{alerts.length?alerts.length+" требуют внимания":"Всё под контролем"}</span>
          </div>
          {alerts.length?
            <div className="dance-alert-list">
              {alerts.map(alert=><a key={alert.id} href={alert.href} className="dance-alert-line">
                <span className={"dance-alert-indicator "+alert.kind}/>
                <span className="dance-alert-copy">{alert.label}</span>
                <strong>{alert.count}</strong><span aria-hidden="true">→</span>
              </a>)}
            </div>:
            <div className="dance-positive"><strong>Срочных вопросов нет</strong>
              <span>Занятия, абонементы и исключения можно контролировать здесь ежедневно.</span></div>}
        </section>

        <section className="dance-focus">
          <div className="dance-panel-head"><div>
            <span className="studio-eyebrow">Операционная работа</span>
            <h2>Расписание на сегодня</h2></div>
            <a href="/app/dance/groups">Управлять занятиями →</a>
          </div>
          <div className="dance-lesson-list">
            {data.todayLessons.map(lesson=><article key={lesson.id} className="dance-lesson">
              <div className="dance-lesson-time">
                <strong>{clock(lesson.starts_at,lesson.lesson_timezone||"Europe/Moscow")}</strong>
                <span>{clock(lesson.ends_at,lesson.lesson_timezone||"Europe/Moscow")}</span>
              </div>
              <div className="dance-lesson-main">
                <strong>{lesson.group_name??lesson.program_name??lesson.lesson_type}</strong>
                <span>{lesson.trainer_name??"Тренер не назначен"}
                  {" · "}{lesson.room_name??"Зал не указан"}</span>
              </div>
              <div className="dance-lesson-occupancy">
                <strong>{lesson.booked_count}/{lesson.capacity}</strong>
                <span>записано · {lesson.attended_count} пришли</span>
              </div>
              <span className="dance-status">{lessonStatus(lesson.status)}</span>
              <a href="/app/dance/groups" className="dance-row-link"
                aria-label={"Открыть занятие "+(lesson.group_name??lesson.lesson_type)}>→</a>
            </article>)}
            {!data.todayLessons.length?<div className="dance-empty">
              <strong>Сегодня нет запланированных занятий</strong>
              <p>Проверьте расписание группы или создайте занятие.</p>
              <a href="/app/dance/groups">Перейти к расписанию →</a>
            </div>:null}
          </div>
        </section>

        <div className="dance-two-col">
          <section className="dance-focus">
            <div className="dance-panel-head"><div>
              <span className="studio-eyebrow">Клиенты</span>
              <h2>Кого стоит вернуть</h2></div>
              <a href="/app/dance/students">Ученики →</a>
            </div>
            <div className="dance-compact-list">
              {data.retentionAlerts.slice(0,6).map(student=>
                <a href="/app/dance/students" key={student.student_id}>
                  <strong>{student.student_name}</strong>
                  <span>{student.days_since_activity} дн. без занятий →</span>
                </a>)}
              {!data.retentionAlerts.length?<p>Учеников с критическим перерывом нет.</p>:null}
            </div>
            {data.retentionAlerts.length>6?
              <p className="dance-footnote">Ещё {data.retentionAlerts.length-6} учеников требуют внимания.</p>:null}
          </section>
          <section className="dance-focus">
            <div className="dance-panel-head"><div>
              <span className="studio-eyebrow">Набор в группы</span>
              <h2>Загрузка групп</h2></div>
              <a href="/app/dance/groups">Все группы →</a>
            </div>
            <div className="dance-compact-list">
              {(weakGroups.length?weakGroups:data.groups).slice(0,6).map(group=>
                <a key={group.id} href="/app/dance/groups">
                  <strong>{group.name}</strong>
                  <span>{group.members}/{group.capacity}
                    {weakGroups.length?" · набор до "+group.break_even_members:" · "+group.waitlist+" в ожидании"} →</span>
                </a>)}
              {!data.groups.length?<p>Пока нет групп. Создайте направление и первую группу.</p>:null}
            </div>
          </section>
        </div>

        {data.canViewFinancials&&data.monthEconomics?<>
          <section className="dance-focus">
            <div className="dance-panel-head">
              <div><span className="studio-eyebrow">Для владельца</span><h2>Экономика студии</h2></div>
              <a href="/app/dance/team">Зарплата и аренда →</a>
            </div>
            <div className="dance-finance-grid">
              <div><span>Выручка от оказанных занятий</span>
                <strong>{money(data.monthEconomics.revenue_minor)}</strong></div>
              <div><span>Тренеры и постоянная оплата</span>
                <strong>{money(data.monthEconomics.full_team_cost_minor)}</strong></div>
              <div><span>Залы и аренда</span>
                <strong>{money(data.monthEconomics.room_cost_minor)}</strong></div>
              <div><span>Результат владельца</span>
                <strong>{money(data.monthEconomics.owner_margin_minor)}</strong></div>
            </div>
            {!data.monthEconomics.payroll_finalized?
              <p className="dance-footnote">
                Это предварительный результат. Для окончательного расчёта закройте
                зарплатные ведомости ({data.monthEconomics.payroll_statement_count} из
                {" "}{data.monthEconomics.payroll_expected_trainers}).
              </p>:null}
            <button className="dance-disclosure" type="button"
              aria-expanded={detail} onClick={()=>setDetail(v=>!v)}>
              {detail?"Скрыть детализацию":"Показать рентабельность направлений и тренеров"}
              <span>{detail?"−":"+"}</span>
            </button>
            {detail?<div className="dance-two-col dance-detail-grid">
              {[{title:"Направления",items:data.economicsByProgram},
                {title:"Тренеры",items:data.economicsByTrainer}].map(part=>
                <div key={part.title} className="dance-breakdown">
                  <h3>{part.title}</h3>
                  {part.items.map(item=><div key={item.id}>
                    <div><strong>{item.name}</strong>
                      <small>{item.lessons} занятий · {percent(item)}% маржа</small></div>
                    <strong>{money(item.margin_minor)}</strong>
                  </div>)}
                  {!part.items.length?<p>Данные появятся после закрытия занятий.</p>:null}
                </div>)}
            </div>:null}
          </section>
        </>:null}
        <footer className="dance-workspace-footer">
          <a href="/app/dance/setup">Настройки студии</a>
          <span>Управление группами, учениками, расписанием и оплатами из одного пространства.</span>
        </footer>
      </>:null}
    </section>
  </main>;
}
