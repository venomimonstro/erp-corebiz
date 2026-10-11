"use client";

import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../components/dance-workspace-nav";
import {apiRequest} from "../../../lib/api";

type Lesson={
  id:string;group_name:string|null;program_name:string|null;lesson_type:string;
  starts_at:string;ends_at:string;lesson_timezone?:string;capacity:number;
  status:string;trainer_name:string|null;room_name:string|null;
  booked_count:number;attended_count:number;
};
type Group={
  id:string;name:string;capacity:number;break_even_members:number;
  members:number;waitlist:number;
};
type Economics={
  id:string;name:string;lessons:number;revenue_minor:string;
  trainer_cost_minor:string;room_cost_minor:string;other_cost_minor:string;
  margin_minor:string;
};
type MonthEconomics={
  revenue_minor:string;trainer_cost_minor:string;room_cost_minor:string;
  margin_minor:string;payroll_total_minor:string;payroll_extra_minor:string;
  full_team_cost_minor:string;owner_margin_minor:string;
  payroll_statement_count:number;payroll_expected_trainers:number;
  payroll_finalized:boolean;
};
type Dashboard={
  canViewFinancials:boolean;
  setup:{programs:number;groups:number;trainers:number;students:number;plans:number;lessons:number}|null;
  todayLessons:Lesson[];
  debt:{open_count:number;open_minor:string;overdue_count:number}|null;
  groups:Group[];
  economicsByProgram:Economics[];
  economicsByTrainer:Economics[];
  packageAlerts:{expiring:number;low_visits:number};
  retentionAlerts:Array<{student_id:string;student_name:string;
    last_attended_at:string|null;days_since_activity:number}>;
  monthEconomics:MonthEconomics|null;
  attention:{
    unclosed_past_lessons:number;attended_without_payment_source:number;
    completed_without_profitability:number;completed_without_trainer_accrual:number;
    lesson_waitlist:number;over_capacity:number;
  };
};
type Action={id:string;title:string;description:string;count:number;href:string;kind:"urgent"|"attention"};
type OperationsHealth={
  status:"HEALTHY"|"REVIEW"|"ACTION_REQUIRED";checkedAt:string;totalIssues:number;
  risks:Array<{
    code:string;label:string;count:number;severity:"critical"|"warning";
    href:string;explanation:string
  }>;
};

const rub=(minor:string)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB",maximumFractionDigits:0
}).format(Number(minor)/100);
function time(value:string,zone="Europe/Moscow"){
  try{return new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",
    timeZone:zone}).format(new Date(value));}
  catch{return new Intl.DateTimeFormat("ru-RU",{hour:"2-digit",minute:"2-digit",
    timeZone:"Europe/Moscow"}).format(new Date(value));}
}
const lessonStatus:Record<string,string>={
  PLANNED:"Запланировано",OPEN_FOR_BOOKING:"Идёт запись",
  STARTED:"В процессе",COMPLETED:"Проведено",CANCELLED:"Отменено"
};
const sum=(values:number[])=>values.reduce((a,b)=>a+b,0);

export default function DanceDashboardPage(){
  const [data,setData]=useState<Dashboard|null>(null);
  const [loading,setLoading]=useState(true);
  const [refreshing,setRefreshing]=useState(false);
  const [error,setError]=useState("");
  const [health,setHealth]=useState<OperationsHealth|null>(null);
  const [healthError,setHealthError]=useState(false);
  const [showAllActions,setShowAllActions]=useState(false);
  const load=useCallback(async()=>{
    setRefreshing(true);
    try{
      const response=await apiRequest<Dashboard>("/dance/dashboard");
      setData(response);setError("");
      try{
        setHealth(await apiRequest<OperationsHealth>("/dance/operations/health"));
        setHealthError(false);
      }catch{
        setHealth(null);
        setHealthError(true);
      }
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось загрузить данные студии");
    }finally{setLoading(false);setRefreshing(false);}
  },[]);
  useEffect(()=>{void load();},[load]);

  const actions=useMemo<Action[]>(()=>{
    if(!data)return [];
    const a=data.attention;
    const rows:Action[]=[
      {id:"overcapacity",title:"Проверьте переполненные уроки",
        description:"Сверьте запись и вместимость залов.",count:a.over_capacity,
        href:"/app/dance/groups",kind:"urgent"},
      {id:"unclosed",title:"Закройте прошедшие занятия",
        description:"Подтвердите посещения и завершите уроки.",
        count:a.unclosed_past_lessons,href:"/app/dance/groups",kind:"urgent"},
      {id:"payment",title:"Проверьте посещения без оплаты",
        description:"Укажите абонемент или разовое начисление.",
        count:a.attended_without_payment_source,href:"/app/dance/students",kind:"urgent"},
      {id:"profitability",title:"Восстановите экономику занятий",
        description:"Некоторые закрытые уроки остались без расчёта.",
        count:a.completed_without_profitability,href:"/app/dance/team",kind:"attention"},
      {id:"trainer",title:"Проверьте начисления тренерам",
        description:"Есть проведённые занятия без начисления зарплаты.",
        count:a.completed_without_trainer_accrual,href:"/app/dance/team",kind:"urgent"},
      {id:"waitlist",title:"Обработайте лист ожидания",
        description:"Появилось место? Предложите его следующему ученику.",
        count:a.lesson_waitlist,href:"/app/dance/groups",kind:"attention"},
      {id:"packages",title:"Продлите абонементы",
        description:"У клиентов заканчиваются сроки или посещения.",
        count:data.packageAlerts.expiring+data.packageAlerts.low_visits,
        href:"/app/dance/students",kind:"attention"},
      {id:"retention",title:"Свяжитесь с учениками без посещений",
        description:"Верните учеников до того, как они уйдут.",
        count:data.retentionAlerts.length,href:"/app/dance/students",kind:"attention"}
    ];
    if(data.canViewFinancials&&data.debt?.overdue_count){
      rows.push({id:"debt",title:"Разберите просроченные оплаты",
        description:"Проверьте плательщиков и договорённости.",
        count:data.debt.overdue_count,href:"/app/dance/students",kind:"urgent"});
    }
    return rows.filter(r=>r.count>0 &&
      (data.canViewFinancials || !["payment","profitability","trainer"].includes(r.id)))
      .sort((a,b)=>
      Number(b.kind==="urgent")-Number(a.kind==="urgent")||b.count-a.count);
  },[data]);
  const visibleActions=showAllActions?actions:actions.slice(0,4);
  const belowBreakEven=(data?.groups??[]).filter(g=>g.members<g.break_even_members);
  const scheduled=(data?.todayLessons??[]).filter(l=>l.status!=="CANCELLED");
  const attending=sum(scheduled.map(l=>l.booked_count));
  const capacity=sum(scheduled.map(l=>l.capacity));
  const month=data?.monthEconomics;
  const setupSteps=data?.setup?[
    {key:"trainer",ready:data.setup.trainers>0,label:"Добавить тренера",href:"/app/dance/setup"},
    {key:"program",ready:data.setup.programs>0,label:"Настроить направление",href:"/app/dance/groups"},
    {key:"group",ready:data.setup.groups>0,label:"Создать группу",href:"/app/dance/groups"},
    {key:"student",ready:data.setup.students>0,label:"Добавить ученика",href:"/app/dance/students"},
    {key:"plan",ready:data.setup.plans>0,label:"Создать абонемент",href:"/app/dance/students"},
    {key:"lesson",ready:data.setup.lessons>0,label:"Составить расписание",href:"/app/dance/groups"}
  ]:[];
  const doneSteps=setupSteps.filter(step=>step.ready).length;


  return <main className="app-shell">
    <AppSidebar active="dance"/>
    <section className="workspace workspace-wide dance-owner">
      <header className="dance-owner-heading">
        <div>
          <p className="dance-owner-kicker">Управление студией</p>
          <h1>Сегодня в студии</h1>
          <p>Расписание, ученики и важные задачи — без лишней сложности.</p>
        </div>
        <div className="dance-owner-actions">
          <a href="/app/dance/groups" className="dance-owner-primary">Расписание <span aria-hidden="true">↗</span></a>
          <button type="button" className="dance-owner-secondary"
            disabled={refreshing} onClick={()=>void load()}>
            {refreshing?"Обновляем…":"Обновить"}
          </button>
        </div>
      </header>
      <DanceWorkspaceNav active="overview"/>
      {error?<div className="dance-owner-error" role="alert">
        <span>{error}</span>
        <button type="button" onClick={()=>void load()} disabled={refreshing}>Повторить</button>
      </div>:null}
      {loading?<div className="dance-owner-loading" role="status" aria-live="polite">Загружаем расписание и показатели…</div>:null}
      {data?<>
        {setupSteps.length&&doneSteps<setupSteps.length?
          <section className="dance-first-day" aria-label="Первоначальная настройка">
            <div className="dance-first-day-header">
              <div><span>Первый запуск</span><h2>Подготовьте студию к работе</h2>
                <p>Настройка только один раз. После этого останутся расписание и ежедневные задачи.</p></div>
              <strong>{doneSteps} / {setupSteps.length}</strong>
            </div>
            <div className="dance-first-steps">
              {setupSteps.map(step=><a href={step.href} key={step.key} className={step.ready?"done":""}>
                <span aria-hidden="true">{step.ready?"✓":"○"}</span>
                <span>{step.label}</span>
                {!step.ready?<span aria-hidden="true">→</span>:null}
              </a>)}
            </div>
          </section>:null}
        <section className="dance-owner-stats" aria-label="Ключевые показатели">
          <article className="dance-owner-stat"><span>Занятий сегодня</span>
            <strong>{scheduled.length}</strong>
            <small>{scheduled.filter(x=>x.status==="COMPLETED").length} уже проведено</small>
          </article>
          <article className="dance-owner-stat"><span>Записей на сегодня</span>
            <strong>{attending}</strong>
            <small>{capacity?Math.round(attending/capacity*100):0}% от доступных мест</small>
          </article>
          <article className={"dance-owner-stat "+(actions.length?"dance-owner-warning":"")}>
            <span>Нуждаются во внимании</span><strong>{actions.length}</strong>
            <small>{actions.length?"вопросов для решения":"всё под контролем"}</small>
          </article>
          {data.canViewFinancials&&month?
            <article className="dance-owner-stat dance-owner-financial">
              <span>Результат месяца</span>
              <strong>{rub(month.owner_margin_minor)}</strong>
              <small>{month.payroll_finalized?"с учётом закрытых ведомостей":
                "предварительно — зарплата не закрыта"}</small>
            </article>
            :<article className="dance-owner-stat">
              <span>Активных групп</span><strong>{data.groups.length}</strong>
              <small>{belowBreakEven.length} требуют набора</small>
            </article>}
        </section>

        <div className="dance-owner-columns">
          <section className="dance-owner-surface" aria-labelledby="dance-today-title">
            <div className="dance-owner-section-heading">
              <div><span className="dance-owner-eyebrow">Расписание</span>
                <h2 id="dance-today-title">Занятия сегодня</h2></div>
              <a href="/app/dance/groups">Все занятия <span aria-hidden="true">→</span></a>
            </div>
            <div className="dance-owner-lesson-list">
              {data.todayLessons.map(l=>{
                const pct=l.capacity?Math.min(100,Math.round(l.booked_count/l.capacity*100)):0;
                return <article className="dance-owner-lesson" key={l.id}>
                  <div className="dance-owner-time"><strong>{time(l.starts_at,l.lesson_timezone)}</strong>
                    <span>{time(l.ends_at,l.lesson_timezone)}</span></div>
                  <div className="dance-owner-lesson-main">
                    <h3>{l.group_name??l.program_name??"Индивидуальное занятие"}</h3>
                    <p>{l.trainer_name??"Без тренера"} · {l.room_name??"Без зала"}</p>
                  </div>
                  <div className="dance-owner-lesson-end">
                    <span className="dance-owner-lesson-places">{l.booked_count}/{l.capacity} мест</span>
                    <div className="dance-owner-track" aria-hidden="true"><i style={{width:pct+"%"}}/></div>
                    <span className="dance-owner-lesson-status">{lessonStatus[l.status]??l.status}</span>
                  </div>
                </article>;
              })}
              {!data.todayLessons.length?<div className="dance-owner-empty">
                <strong>Сегодня занятий нет</strong>
                <p>Создайте группу или проверьте расписание на ближайшие дни.</p>
                <a href="/app/dance/groups">Открыть расписание →</a>
              </div>:null}
            </div>
          </section>
          <section className="dance-owner-surface" aria-labelledby="dance-action-title">
            <div className="dance-owner-section-heading">
              <div><span className="dance-owner-eyebrow">Задачи</span>
                <h2 id="dance-action-title">Что сделать дальше</h2></div>
              {actions.length>4?<button type="button" className="dance-owner-inline"
                onClick={()=>setShowAllActions(v=>!v)} aria-expanded={showAllActions}>
                {showAllActions?"Свернуть":"Все "+actions.length}
              </button>:null}
            </div>
            <div className="dance-owner-action-list">
              {visibleActions.map(a=><a href={a.href} className="dance-owner-action" key={a.id}>
                <span className={"dance-owner-action-num "+(a.kind==="urgent"?"is-urgent":"")}>{a.count}</span>
                <span className="dance-owner-action-copy"><strong>{a.title}</strong>
                  <small>{a.description}</small></span>
                <span className="dance-owner-action-arrow" aria-hidden="true">→</span>
              </a>)}
              {!actions.length?<div className="dance-owner-empty">
                <strong>Срочных задач нет</strong>
                <p>Расписание и операционные показатели без критических предупреждений.</p>
              </div>:null}
            </div>
          </section>
        </div>

        <section className="dance-owner-quick" aria-label="Основные действия">
          <a href="/app/dance/students"><span>Ученики и оплаты</span><small>Семьи, абонементы, долги</small><b aria-hidden="true">↗</b></a>
          <a href="/app/dance/groups"><span>Группы и уроки</span><small>Запись, посещения, переносы</small><b aria-hidden="true">↗</b></a>
          <a href="/app/dance/team"><span>Тренеры и зарплата</span><small>Смены, ставки, начисления</small><b aria-hidden="true">↗</b></a>
        </section>

        {health?.totalIssues? <details className="dance-owner-details">
          <summary>
            <span><strong>Проверка целостности процессов · {health.totalIssues}</strong>
              <small>Незакрытые ошибки между записью, абонементами, оплатой и зарплатой</small></span>
            <span aria-hidden="true">⌄</span>
          </summary>
          <div className="dance-owner-details-content">
            <div className="dance-owner-action-list">
              {health.risks.map(risk=><a className="dance-owner-action" href={risk.href}
                key={risk.code}>
                <span className={"dance-owner-action-num "+(risk.severity==="critical"?"is-urgent":"")}>
                  {risk.count}
                </span>
                <span className="dance-owner-action-copy">
                  <strong>{risk.label}</strong><small>{risk.explanation}</small>
                </span>
                <span className="dance-owner-action-arrow" aria-hidden="true">→</span>
              </a>)}
            </div>
            <p className="dance-owner-note">
              Диагностика не меняет финансовые данные автоматически: каждую проблему
              необходимо проверить перед исправлением.
            </p>
          </div>
        </details>:null}
        {healthError?<p className="dance-owner-note" role="status">
          Дополнительная проверка процессов недоступна. Основное расписание продолжает работать.
        </p>:null}

        {data.canViewFinancials&&month?<details className="dance-owner-details">
          <summary><span><strong>Финансы и аналитика</strong><small>Выручка, зарплата, направления и рентабельность</small></span>
            <span aria-hidden="true">⌄</span></summary>
          <div className="dance-owner-details-content">
            <div className="dance-owner-detail-stats">
              <div><span>Оказанные услуги</span><strong>{rub(month.revenue_minor)}</strong></div>
              <div><span>Стоимость тренеров</span><strong>{rub(month.full_team_cost_minor)}</strong></div>
              <div><span>Залы</span><strong>{rub(month.room_cost_minor)}</strong></div>
              <div><span>Дебиторка</span><strong>{rub(data.debt?.open_minor??"0")}</strong></div>
            </div>
            <p className="dance-owner-note">{month.payroll_finalized
              ?"Ведомости за месяц сформированы. Сверьте их статус оплаты в разделе команды."
              :"Результат предварительный: зарплатные ведомости ещё не полностью сформированы."}</p>
            <div className="dance-owner-analysis-grid">
              <div><h3>Направления</h3>
                {data.economicsByProgram.length?data.economicsByProgram.map(e=>
                  <div key={e.id}><span>{e.name} <small>· {e.lessons} занятий</small></span>
                    <strong>{rub(e.margin_minor)}</strong></div>):<p>Данные появятся после проведения уроков.</p>}
              </div>
              <div><h3>Тренеры</h3>
                {data.economicsByTrainer.length?data.economicsByTrainer.map(e=>
                  <div key={e.id}><span>{e.name} <small>· {e.lessons} занятий</small></span>
                    <strong>{rub(e.margin_minor)}</strong></div>):<p>Экономика появится после закрытия занятий.</p>}
              </div>
            </div>
            <a href="/app/dance/team">Ведомости и расчёты →</a>
          </div>
        </details>:null}

        <details className="dance-owner-details">
          <summary><span><strong>Состав групп и удержание</strong>
            <small>Заполняемость, лист ожидания, потерянная активность</small></span>
            <span aria-hidden="true">⌄</span></summary>
          <div className="dance-owner-details-content">
            <div className="dance-owner-analysis-grid">
              <div><h3>Группы</h3>
                {data.groups.map(g=><div key={g.id}>
                  <span>{g.name} <small>· ждут {g.waitlist}</small></span>
                  <strong>{g.members}/{g.capacity}</strong>
                </div>)}
                {!data.groups.length?<p>Пока нет активных групп.</p>:null}
              </div>
              <div><h3>Ученики без посещений</h3>
                {data.retentionAlerts.slice(0,12).map(r=><div key={r.student_id}>
                  <span>{r.student_name}</span><strong>{r.days_since_activity} дн.</strong>
                </div>)}
                {!data.retentionAlerts.length?<p>Пока нет тревожных сигналов.</p>:null}
              </div>
            </div>
            <a href="/app/dance/students">Открыть работу с учениками →</a>
          </div>
        </details>
      </>:!loading?<div className="dance-owner-empty"><strong>Нет данных студии</strong>
        <p>Проверьте настройки доступа или обновите страницу.</p></div>:null}
    </section>
  </main>;
}
