"use client";

import {FormEvent,useCallback,useEffect,useMemo,useRef,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";

type Service={id:string;name:string;duration_minutes:number;price_minor:string;currency:string;delivery_format:string};
type Resource={id:string;name:string;type:string;capacity:number;timezone?:string|null};
type Customer={id:string;displayName:string;phone:string|null};
type Rule={id:string;service_id:string;employee_resource_id:string|null;price_minor:string|null;duration_minutes:number|null};
type TechCard={id:string;name:string;lines:Array<{skuId:string;warehouseId:string;quantityMilli:string}>};
type Slot={resourceId:string;resourceName:string;startsAt:string;endsAt:string};
type Visit={
  id:string;business_number:string;status:string;starts_at:string;ends_at:string;
  service_name:string;party_name:string|null;party_id?:string|null;price_minor_snapshot:string;
  currency:string;version:number;settled_minor?:string;billing_status?:string|null;
  resources:Array<{resourceId:string;resourceName:string;type:string}>;
  billing?:{status:string;amountMinor:string;settledMinor:string;invoiceNumber:string|null;obligationStatus:string|null}|null;
  refund?:{status:string;amountMinor:string;settledMinor:string}|null;
};
type Economy={
  totals:{completed:number;revenue_minor:string;material_cost_minor:string;employee_cost_minor:string;resource_cost_minor:string;margin_minor:string};
  employees:Array<{id:string;name:string;completed:number;margin_minor:string}>;
  services:Array<{id:string;name:string;completed:number;margin_minor:string}>;
  retentionAlerts:Array<{party_id:string;party_name:string;service_name:string;overdue_days:number}>;
};
type History={customer:{id:string;name:string};bookings:Array<{id:string;status:string;service_name:string;starts_at:string}>;completedRevenueMinor:string|null};
type Tab="calendar"|"setup"|"clients"|"economics";
const NAV:Array<{id:Tab;title:string}>=[
  {id:"calendar",title:"Журнал"},{id:"setup",title:"Настройка"},
  {id:"clients",title:"Клиенты"},{id:"economics",title:"Экономика"}
];
function localDate(d:Date){const p=(n:number)=>String(n).padStart(2,"0");return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate());}
function weekStart(offset:number){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()-(d.getDay()+6)%7+offset*7);return d;}
function toMoney(value:string|number|undefined|null){
  if(value===null||value===undefined)return "—";
  const numeric=Number(value);
  if(!Number.isFinite(numeric))return "—";
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency:"RUB",maximumFractionDigits:0
  }).format(numeric/100);
}
function fmtTime(value:string,timeZone="Europe/Moscow"){
  try{return new Date(value).toLocaleTimeString("ru-RU",{
    hour:"2-digit",minute:"2-digit",timeZone
  });}catch{return new Date(value).toLocaleTimeString("ru-RU",{
    hour:"2-digit",minute:"2-digit",timeZone:"Europe/Moscow"
  });}
}
function venueDay(value:string,timeZone="Europe/Moscow"){
  let parts:Intl.DateTimeFormatPart[];
  try{parts=new Intl.DateTimeFormat("en-GB",{
    day:"2-digit",month:"2-digit",year:"numeric",timeZone
  }).formatToParts(new Date(value));}
  catch{parts=new Intl.DateTimeFormat("en-GB",{
    day:"2-digit",month:"2-digit",year:"numeric",timeZone:"Europe/Moscow"
  }).formatToParts(new Date(value));}
  const byType=(key:string)=>parts.find(p=>p.type===key)?.value??"";
  return byType("year")+"-"+byType("month")+"-"+byType("day");
}
function fmtDate(value:string){return new Date(value).toLocaleDateString("ru-RU",{day:"numeric",month:"short"});}
function statusName(status:string){return ({DRAFT:"Черновик",CONFIRMED:"Записан",ARRIVED:"Пришёл",IN_SERVICE:"В работе",COMPLETED:"Завершён",NO_SHOW:"Не пришёл",CANCELLED:"Отменён"} as Record<string,string>)[status]??status;}
function readableError(error:unknown){return error instanceof Error?error.message:"Операция не выполнена";}
function isStaff(resource:Resource){return resource.type==="EMPLOYEE";}
function nextStages(status:string):Array<{status:"ARRIVED"|"IN_SERVICE"|"COMPLETED"|"CANCELLED"|"NO_SHOW";title:string}>{
  if(status==="DRAFT"||status==="CONFIRMED")return [{status:"ARRIVED",title:"Клиент пришёл"},{status:"NO_SHOW",title:"Неявка"},{status:"CANCELLED",title:"Отменить"}];
  if(status==="ARRIVED")return [{status:"IN_SERVICE",title:"Начать услугу"},{status:"NO_SHOW",title:"Неявка"},{status:"CANCELLED",title:"Отменить"}];
  if(status==="IN_SERVICE")return [{status:"COMPLETED",title:"Завершить визит"},{status:"CANCELLED",title:"Отменить"}];
  return [];
}

export default function ServiceDeskPage(){
  const [tab,setTab]=useState<Tab>("calendar");
  const [services,setServices]=useState<Service[]>([]);
  const [resources,setResources]=useState<Resource[]>([]);
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [visits,setVisits]=useState<Visit[]>([]);
  const [rules,setRules]=useState<Rule[]>([]);
  const [technologyCards,setTechnologyCards]=useState<TechCard[]>([]);
  const [economics,setEconomics]=useState<Economy|null>(null);
  const [customerAccess,setCustomerAccess]=useState(true);
  const [economicsAccess,setEconomicsAccess]=useState(true);
  const [schedules,setSchedules]=useState<Record<string,number>>({});
  const [weekOffset,setWeekOffset]=useState(0);
  const [staffFilter,setStaffFilter]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [selectedVisit,setSelectedVisit]=useState<Visit|null>(null);
  const [visitMaterials,setVisitMaterials]=useState<unknown[]|null>(null);
  const [selectedHistory,setSelectedHistory]=useState<History|null>(null);
  const [historyLoading,setHistoryLoading]=useState(false);
  const [createOpen,setCreateOpen]=useState(false);
  const [pendingTransition,setPendingTransition]=useState<"CANCELLED"|"COMPLETED"|"NO_SHOW"|null>(null);
  const [rescheduleAt,setRescheduleAt]=useState("");
  const [day,setDay]=useState(localDate(new Date()));
  const [slots,setSlots]=useState<Slot[]>([]);
  const [slotsBusy,setSlotsBusy]=useState(false);
  const [bookService,setBookService]=useState("");
  const [bookStaff,setBookStaff]=useState("");
  const [bookCustomer,setBookCustomer]=useState("");
  const [bookSlot,setBookSlot]=useState("");
  const [newService,setNewService]=useState({name:"",duration:"60",price:"1500"});
  const [priceService,setPriceService]=useState("");
  const [priceStaff,setPriceStaff]=useState("");
  const [personalPrice,setPersonalPrice]=useState("");
  const [personalDuration,setPersonalDuration]=useState("");
  const [personalTechCard,setPersonalTechCard]=useState("");
  const [newResource,setNewResource]=useState("");
  const [scheduleResource,setScheduleResource]=useState("");
  const [newCustomer,setNewCustomer]=useState({name:"",phone:"",email:""});
  // An uncertain network response may mean the booking was committed.
  // Replays must use the same key only for the exact same payload.
  const bookingKey=useRef<{key:string;fingerprint:string}|null>(null);
  const refreshGeneration=useRef(0);
  const from=useMemo(()=>weekStart(weekOffset),[weekOffset]);
  const end=useMemo(()=>{const d=new Date(from);d.setDate(d.getDate()+7);return d;},[from]);
  const staff=useMemo(()=>resources.filter(isStaff),[resources]);
  const zoneForVisit=(visit:Visit)=>{
    const resourceId=visit.resources.find(x=>x.type==="EMPLOYEE")?.resourceId
      ??visit.resources[0]?.resourceId;
    return resources.find(x=>x.id===resourceId)?.timezone||"Europe/Moscow";
  };
  const filtered=useMemo(()=>visits.filter(v=>{
    const resourceId=v.resources.find(x=>x.type==="EMPLOYEE")?.resourceId
      ??v.resources[0]?.resourceId;
    const zone=resources.find(x=>x.id===resourceId)?.timezone||"Europe/Moscow";
    const scheduled=venueDay(v.starts_at,zone);
    return scheduled>=localDate(from)&&scheduled<localDate(end)&&
      (!staffFilter||v.resources.some(r=>r.resourceId===staffFilter));
  }),[visits,resources,staffFilter,from,end]);

  const refresh=useCallback(async()=>{
    const generation=++refreshGeneration.current;
    setLoading(true);
    const start=weekStart(weekOffset);
    const finish=new Date(start);finish.setDate(finish.getDate()+7);
    // Some companies use a different timezone than the owner's browser.
    // Widen the SQL range; client week grouping uses the resource timezone.
    const fetchFrom=new Date(start);fetchFrom.setDate(fetchFrom.getDate()-1);
    const fetchUntil=new Date(finish);fetchUntil.setDate(fetchUntil.getDate()+1);
    const results=await Promise.allSettled([
      apiRequest<Service[]>("/service/catalog"),
      apiRequest<Resource[]>("/service/resources"),
      apiRequest<Visit[]>("/service/bookings?from="+encodeURIComponent(fetchFrom.toISOString())+"&to="+encodeURIComponent(fetchUntil.toISOString())),
      apiRequest<Customer[]>("/crm/customers"),
      apiRequest<Rule[]>("/service/delivery-rules"),
      apiRequest<Economy>("/service/economics"),
      apiRequest<TechCard[]>("/service/technology-cards")
    ]);
    // Reject stale responses when the operator changes week or another
    // save starts a newer refresh while the old one is still running.
    if(generation!==refreshGeneration.current)return;
    const read=<T,>(index:number):T|null=>{
      const result=results[index];return result.status==="fulfilled"?result.value as T:null;
    };
    const missing=[0,1,2].filter(i=>results[i].status==="rejected");
    if(missing.length){
      setError("Не удалось загрузить основные данные: "+missing.map(i=>readableError((results[i] as PromiseRejectedResult).reason)).join("; "));
    }else setError("");
    const rs=read<Resource[]>(1);
    if(read<Service[]>(0))setServices(read<Service[]>(0)!);
    if(rs)setResources(rs);
    if(read<Visit[]>(2))setVisits(read<Visit[]>(2)!);
    const people=read<Customer[]>(3);
    setCustomerAccess(people!==null);
    setCustomers(people??[]);
    setRules(read<Rule[]>(4)??[]);
    setTechnologyCards(read<TechCard[]>(6)??[]);
    const financial=read<Economy>(5);
    setEconomicsAccess(financial!==null);
    setEconomics(financial);
    if(rs){
      const employees=rs.filter(isStaff);
      const scheduleChecks=await Promise.allSettled(employees.slice(0,30).map(r=>
        apiRequest<Array<{id:string}>>("/service/resources/"+encodeURIComponent(r.id)+"/schedule")
      ));
      const coverage:Record<string,number>={};
      scheduleChecks.forEach((result,i)=>{
        if(result.status==="fulfilled")coverage[employees[i]!.id]=result.value.length;
      });
      if(generation!==refreshGeneration.current)return;
      setSchedules(coverage);
    }
    if(generation===refreshGeneration.current)setLoading(false);
  },[weekOffset]);

  useEffect(()=>{void refresh();},[refresh]);

  useEffect(()=>{
    let active=true;
    setSlots([]);
    setBookSlot("");
    if(!bookService||!bookStaff||!day){setSlotsBusy(false);return;}
    // Encompass every IANA-local day, including DST/UTC+14/UTC-12.
    // Backend filters by resourceId BEFORE the 500-slot response cap.
    const start=new Date(day+"T00:00:00Z");
    if(Number.isNaN(start.getTime())){setSlotsBusy(false);return;}
    start.setUTCDate(start.getUTCDate()-1);
    const finish=new Date(start);finish.setUTCDate(finish.getUTCDate()+3);
    const resourceZone=staff.find(x=>x.id===bookStaff)?.timezone||"Europe/Moscow";
    setSlotsBusy(true);
    void apiRequest<Slot[]>("/service/availability?serviceId="+encodeURIComponent(bookService)+
      "&resourceId="+encodeURIComponent(bookStaff)+
      "&from="+encodeURIComponent(start.toISOString())+"&to="+encodeURIComponent(finish.toISOString()))
      .then(value=>{if(active)setSlots(value.filter(slot=>
        slot.resourceId===bookStaff&&venueDay(slot.startsAt,resourceZone)===day&&
        new Date(slot.startsAt).getTime()>Date.now()
      ));})
      .catch(cause=>{if(active)setError(readableError(cause));})
      .finally(()=>{if(active)setSlotsBusy(false);});
    return ()=>{active=false;};
  },[bookService,bookStaff,day,staff]);

  async function mutate(action:()=>Promise<void>,message:string){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{await action();setNotice(message);await refresh();}
    catch(cause){setError(readableError(cause));}
    finally{setBusy(false);}
  }

  async function createService(e:FormEvent){
    e.preventDefault();
    const amount=Number(newService.price.replace(",","."));
    const duration=Number(newService.duration);
    if(!newService.name.trim()||!Number.isInteger(duration)||duration<5||duration>1440||
      !Number.isFinite(amount)||amount<0||amount>100000000){
      setError("Укажите услугу, длительность 5–1440 минут и допустимую цену.");return;
    }
    await mutate(async()=>{
      await apiRequest("/service/catalog",{method:"POST",body:JSON.stringify({
        name:newService.name.trim(),durationMinutes:duration,
        priceMinor:String(Math.round(amount*100)),deliveryFormat:"INDIVIDUAL"
      })});
      setNewService({name:"",duration:"60",price:"1500"});
    },"Услуга сохранена. Теперь добавьте специалиста и его график.");
  }
  async function savePersonalPrice(e:FormEvent){
    e.preventDefault();
    const service=services.find(x=>x.id===priceService);
    const employee=staff.find(x=>x.id===priceStaff);
    const normalized=personalPrice.trim().replace(",",".");
    if(!service||!employee||!/^\d{1,9}(?:\.\d{1,2})?$/.test(normalized)||
      (personalDuration.trim()!==""&&
        (!/^\d{1,4}$/.test(personalDuration)||Number(personalDuration)<5||
         Number(personalDuration)>1440))){
      setError("Укажите корректную цену и длительность (5–1440 минут).");return;
    }
    if(personalTechCard&&!technologyCards.some(c=>c.id===personalTechCard)){
      setError("Выбранная технологическая карта больше недоступна. Обновите список.");return;
    }
    if(rules.some(rule=>rule.service_id===service.id&&
      rule.employee_resource_id===employee.id)){
      setError("Правило для этой услуги и специалиста уже существует. Измените его в расширенных настройках.");return;
    }
    const [integer,fraction=""]=normalized.split(".");
    const minor=(BigInt(integer)*100n+BigInt(fraction.padEnd(2,"0"))).toString();
    await mutate(async()=>{
      await apiRequest("/service/delivery-rules",{
        method:"POST",
        body:JSON.stringify({
          serviceId:service.id,employeeResourceId:employee.id,
          deliveryFormat:"INDIVIDUAL",priceMinor:minor,
          durationMinutes:personalDuration?Number(personalDuration):undefined,
          technologyCardId:personalTechCard||undefined
        })
      });
      setPersonalPrice("");setPriceService("");setPriceStaff("");
      setPersonalDuration("");setPersonalTechCard("");
    },"Правило мастера сохранено. Индивидуальная длительность и расходники применяются при новых записях.");
  }
  async function createResource(e:FormEvent){
    e.preventDefault();
    if(newResource.trim().length<2){setError("Укажите имя специалиста.");return;}
    await mutate(async()=>{
      await apiRequest("/service/resources",{method:"POST",body:JSON.stringify({
        name:newResource.trim(),type:"EMPLOYEE",capacity:1,timezone:"Europe/Moscow"
      })});
      setNewResource("");
    },"Специалист добавлен. Следующий шаг — назначить рабочие часы.");
  }
  async function setWeekdays(){
    if(!scheduleResource){setError("Выберите специалиста.");return;}
    await mutate(async()=>{
      const existing=await apiRequest<Array<{id:string}>>("/service/resources/"+encodeURIComponent(scheduleResource)+"/schedule");
      if(existing.length)throw new Error("У специалиста уже есть график. Измените его в разделе «Сотрудники и ресурсы», чтобы не удалить смены.");
      await apiRequest("/service/resources/"+encodeURIComponent(scheduleResource)+"/schedule",{
        method:"PUT",body:JSON.stringify({windows:[1,2,3,4,5].map(weekday=>({weekday,startMinute:600,endMinute:1140}))})
      });
    },"Установлен график: понедельник–пятница, 10:00–19:00.");
  }
  async function createCustomer(e:FormEvent){
    e.preventDefault();
    if(newCustomer.name.trim().length<2){setError("Укажите имя клиента.");return;}
    await mutate(async()=>{
      const value=await apiRequest<Customer>("/crm/customers",{method:"POST",body:JSON.stringify({
        type:"PERSON",displayName:newCustomer.name.trim(),
        phone:newCustomer.phone.trim()||undefined,email:newCustomer.email.trim()||undefined,
        deduplicateContacts:Boolean(newCustomer.phone.trim()||newCustomer.email.trim()),
        idempotencyKey:crypto.randomUUID()
      })});
      setNewCustomer({name:"",phone:"",email:""});
      setBookCustomer(value.id);
    },"Клиент добавлен в CRM и доступен для записи.");
  }
  async function createBooking(e:FormEvent){
    e.preventDefault();
    const slot=slots.find(s=>s.startsAt===bookSlot&&s.resourceId===bookStaff);
    if(!slot||!bookService){setError("Выберите доступное время и специалиста.");return;}
    const payload={
      serviceId:bookService,resourceIds:[bookStaff],partyId:bookCustomer||undefined,
      startsAt:slot.startsAt,source:"MANUAL"
    };
    const fingerprint=JSON.stringify(payload);
    if(bookingKey.current && bookingKey.current.fingerprint!==fingerprint){
      setError("Предыдущая запись могла сохраниться, несмотря на ошибку сети. Обновите журнал перед изменением данных или повторите прежнюю запись.");
      return;
    }
    if(!bookingKey.current)
      bookingKey.current={key:crypto.randomUUID(),fingerprint};
    await mutate(async()=>{
      await apiRequest<{id:string}>("/service/bookings",{
        method:"POST",body:JSON.stringify({...payload,idempotencyKey:bookingKey.current!.key})
      });
      bookingKey.current=null;
      // After booking, show the week containing the actual local date of
      // the selected salon resource, not the browser owner's timezone.
      const bookedDay=venueDay(slot.startsAt,
        staff.find(r=>r.id===bookStaff)?.timezone||"Europe/Moscow");
      const [y,m,d]=bookedDay.split("-").map(Number);
      const monday=weekStart(0);
      const originMonday=Date.UTC(monday.getFullYear(),monday.getMonth(),monday.getDate());
      const targetDay=Date.UTC(y,m-1,d);
      setWeekOffset(Math.floor((targetDay-originMonday)/(7*86400000)));
      setCreateOpen(false);setBookSlot("");setBookStaff("");setBookService("");
    },"Запись сохранена. Сервер проверил расписание и доступность специалиста.");
  }

  async function viewVisit(id:string){
    setError("");setVisitMaterials(null);setRescheduleAt("");
    try{
      const [v,m]=await Promise.allSettled([
        apiRequest<Visit>("/service/bookings/"+encodeURIComponent(id)),
        apiRequest<unknown[]>("/service/workspace/bookings/"+encodeURIComponent(id)+"/materials")
      ]);
      if(v.status==="rejected")throw v.reason;
      setSelectedVisit(v.value);
      if(m.status==="fulfilled")setVisitMaterials(m.value);
    }catch(cause){setError(readableError(cause));}
  }
  async function status(visit:Visit,to:"ARRIVED"|"IN_SERVICE"|"COMPLETED"|"CANCELLED"|"NO_SHOW"){
    if(["CANCELLED","COMPLETED","NO_SHOW"].includes(to)){
      setPendingTransition(to as "CANCELLED"|"COMPLETED"|"NO_SHOW");
      return;
    }
    await commitStatus(visit,to);
  }
  async function commitStatus(visit:Visit,to:"ARRIVED"|"IN_SERVICE"|"COMPLETED"|"CANCELLED"|"NO_SHOW"){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/bookings/"+encodeURIComponent(visit.id)+"/status",{
        method:"PATCH",body:JSON.stringify({status:to,version:visit.version})
      });
      setSelectedVisit(null);setPendingTransition(null);
      setNotice("Статус подтверждён сервером. Начисления и остатки пересчитаны по правилам.");
    }catch(cause){
      setError(readableError(cause)+". Проверьте текущий статус перед повторным действием.");
      try{
        setSelectedVisit(await apiRequest<Visit>("/service/bookings/"+encodeURIComponent(visit.id)));
      }catch{setSelectedVisit(null);}
      setPendingTransition(null);
    }finally{
      setBusy(false);
      await refresh();
    }
  }
  async function reschedule(e:FormEvent){
    e.preventDefault();
    if(!selectedVisit||!rescheduleAt)return;
    const proposed=new Date(rescheduleAt);
    if(Number.isNaN(proposed.getTime())){setError("Укажите корректное время переноса.");return;}
    await mutate(async()=>{
      await apiRequest("/service/bookings/"+encodeURIComponent(selectedVisit.id)+"/reschedule",{
        method:"PATCH",body:JSON.stringify({startsAt:proposed.toISOString(),version:selectedVisit.version})
      });
      setSelectedVisit(null);
    },"Визит перенесён после проверки занятости ресурсов.");
  }
  async function viewHistory(customerId:string){
    setHistoryLoading(true);setError("");
    try{setSelectedHistory(await apiRequest<History>("/service/workspace/customers/"+encodeURIComponent(customerId)+"/history"));}
    catch(cause){setError(readableError(cause));}
    finally{setHistoryLoading(false);}
  }

  const readiness=[
    {ok:services.length>0,title:"Услуга и стоимость",href:"/app/service/setup"},
    {ok:staff.length>0,title:"Специалист",href:"/app/service/resources"},
    {ok:staff.some(s=>(schedules[s.id]??0)>0),title:"Рабочее расписание",href:"/app/service/resources"},
    {ok:customers.length>0,title:"Первый клиент",href:"/app/crm/customers"}
  ];
  const weekDays=Array.from({length:7},(_,i)=>{const d=new Date(from);d.setDate(d.getDate()+i);return d;});
  const visibleSlots=slots.filter(s=>s.resourceId===bookStaff);

  return (
    <main className="app-shell">
      <AppSidebar active="service-desk"/>
      <section className="workspace workspace-wide studio-premium unified-service">
        <header className="studio-hero compact">
          <div>
            <span className="studio-eyebrow">CoreBiz · сервисный бизнес</span>
            <h1>Рабочее место</h1>
            <p>Записи, клиенты, сотрудники и деньги в одном интерфейсе. Начисления, остатки и права доступа контролируются сервером.</p>
          </div>
          <button type="button" onClick={()=>{setTab("calendar");setCreateOpen(true);}}
            disabled={!services.length||!staff.length}>+ Новая запись</button>
        </header>

        <nav className="service-desk-tabs" aria-label="Разделы сервисного бизнеса">
          {NAV.map(x=><button key={x.id} type="button" onClick={()=>setTab(x.id)}
            aria-current={tab===x.id?"page":undefined} className={tab===x.id?"active":""}>{x.title}</button>)}
        </nav>
        {loading?<p className="muted" role="status">Обновляем рабочее место…</p>:null}
        {error?<p className="inline-error" role="alert">{error} <button type="button" className="secondary-button" onClick={()=>void refresh()}>Повторить</button></p>:null}
        {notice?<p className="inline-success" role="status">{notice}</p>:null}
        {!loading&&!readiness.every(x=>x.ok)?(
          <aside className="service-desk-onboarding">
            <div><strong>Подготовьте бизнес к первой записи</strong><p>Данные сохраняются в существующих разделах CoreBiz, без повторного ввода.</p></div>
            <div className="service-desk-steps">{readiness.map(x=><span key={x.title} className={x.ok?"done":""}>{x.ok?"✓":"○"} {x.title}</span>)}</div>
            <button type="button" className="secondary-button" onClick={()=>setTab("setup")}>Настроить</button>
          </aside>
        ):null}

        {tab==="calendar"?<>
          <div className="service-desk-bar">
            <div><h2>Журнал записи</h2><p className="muted">{fmtDate(from.toISOString())} — {fmtDate(weekDays[6]!.toISOString())} · {filtered.length} визитов</p></div>
            <div className="service-desk-actions">
              <button type="button" className="secondary-button" onClick={()=>setWeekOffset(v=>v-1)} aria-label="Предыдущая неделя">←</button>
              <button type="button" className="secondary-button" onClick={()=>setWeekOffset(0)}>Сегодня</button>
              <button type="button" className="secondary-button" onClick={()=>setWeekOffset(v=>v+1)} aria-label="Следующая неделя">→</button>
              <select aria-label="Фильтр по специалисту" value={staffFilter} onChange={e=>setStaffFilter(e.target.value)}>
                <option value="">Все специалисты</option>
                {staff.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
          </div>
          <div className="service-desk-week">
            {weekDays.map(d=>{
              const items=filtered.filter(v=>venueDay(v.starts_at,zoneForVisit(v))===localDate(d));
              return <section className="service-desk-day" key={localDate(d)}>
                <h3>{d.toLocaleDateString("ru-RU",{weekday:"short",day:"numeric",month:"short"})}</h3>
                {items.map(v=><button type="button" className="service-desk-visit" key={v.id} onClick={()=>void viewVisit(v.id)}>
                  <strong>{fmtTime(v.starts_at,zoneForVisit(v))}</strong>
                  <span><b>{v.service_name}</b><small>{v.party_name??"Без клиента"} · {v.resources.map(x=>x.resourceName).join(", ")}</small></span>
                  <em>{statusName(v.status)}</em>
                </button>)}
                {!items.length?<p className="muted">Свободно</p>:null}
              </section>;
            })}
          </div>
          <p className="muted">Цены и статусы здесь информационные. Оплата подтверждается финансовым контуром, а не отметкой «Завершён». Для аренды залов и самостоятельной практики используйте <a href="/app/service/bookings">полный календарь ресурсов →</a></p>
        </>:null}

        {tab==="setup"?<>
          <div className="service-desk-bar"><div><h2>Настройка за один экран</h2><p className="muted">Услуга → специалист → смены → клиент → первая запись.</p></div></div>
          <div className="service-desk-setup-grid">
            <form className="service-desk-panel" onSubmit={e=>void createService(e)}>
              <span className="service-desk-index">01</span><h3>Услуги и цены</h3>
              <p className="muted">Создайте основную услугу. Индивидуальные цены и техкарты доступны в расширенных настройках.</p>
              <label>Название<input required maxLength={160} value={newService.name} onChange={e=>setNewService(v=>({...v,name:e.target.value}))} placeholder="Например, стрижка"/></label>
              <div className="service-desk-two"><label>Минут<input type="number" min={5} max={1440} value={newService.duration} onChange={e=>setNewService(v=>({...v,duration:e.target.value}))}/></label>
                <label>Цена, ₽<input type="text" inputMode="decimal" value={newService.price} onChange={e=>setNewService(v=>({...v,price:e.target.value}))}/></label></div>
              <button disabled={busy}>Добавить услугу</button>
              <p className="muted">В каталоге: {services.length}</p>
            </form>
            <form className="service-desk-panel" onSubmit={e=>void createResource(e)}>
              <span className="service-desk-index">02</span><h3>Специалисты</h3>
              <p className="muted">Создание рабочего ресурса не предоставляет человеку доступ к аккаунту. Доступы выдаются отдельно.</p>
              <label>Имя специалиста<input required minLength={2} maxLength={160} value={newResource} onChange={e=>setNewResource(e.target.value)} placeholder="Например, Анна"/></label>
              <button disabled={busy}>Добавить специалиста</button>
              <p className="muted">Специалистов: {staff.length} · <a href="/app/settings/team">Выдать доступ сотруднику →</a></p>
            </form>
            <section className="service-desk-panel">
              <span className="service-desk-index">03</span><h3>Рабочие смены</h3>
              <p className="muted">Быстрый шаблон для нового специалиста: пн–пт 10:00–19:00, по московскому времени.</p>
              <label>Специалист<select value={scheduleResource} onChange={e=>setScheduleResource(e.target.value)}>
                <option value="">Выберите специалиста</option>{staff.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select></label>
              <button type="button" disabled={busy||!scheduleResource||Boolean(schedules[scheduleResource])} onClick={()=>void setWeekdays()}>Установить шаблон смен</button>
              <p className="muted">Для выходных, перерывов и отпусков используйте <a href="/app/service/resources">полное расписание →</a></p>
            </section>
            <form className="service-desk-panel" onSubmit={e=>void createCustomer(e)}>
              <span className="service-desk-index">04</span><h3>Первый клиент</h3>
              <p className="muted">Клиент появится в общей CRM. Система проверит совпадения телефона и email.</p>
              <label>Имя<input required value={newCustomer.name} onChange={e=>setNewCustomer(v=>({...v,name:e.target.value}))} placeholder="Имя клиента"/></label>
              <label>Телефон<input type="tel" value={newCustomer.phone} onChange={e=>setNewCustomer(v=>({...v,phone:e.target.value}))} placeholder="+7"/></label>
              <label>Email<input type="email" value={newCustomer.email} onChange={e=>setNewCustomer(v=>({...v,email:e.target.value}))}/></label>
              <button disabled={busy}>Создать клиента</button>
              {!customerAccess?<p role="status" className="muted">У вашей роли нет доступа к списку клиентов.</p>:null}
            </form>
          </div>
          <form className="service-desk-panel" onSubmit={e=>void savePersonalPrice(e)}>
            <span className="service-desk-index">05</span>
            <h3>Правила услуги конкретного мастера</h3>
            <p className="muted">Задайте персональную цену, длительность и расходные материалы.
              После оказания услуги складские списания выполняет сервер по техкарте.
              Уже оформленные визиты сохраняют зафиксированные параметры.</p>
            <div className="service-desk-two">
              <label>Услуга<select required value={priceService} onChange={e=>setPriceService(e.target.value)}>
                <option value="">Выберите услугу</option>
                {services.filter(x=>x.delivery_format==="INDIVIDUAL").map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
              </select></label>
              <label>Специалист<select required value={priceStaff} onChange={e=>setPriceStaff(e.target.value)}>
                <option value="">Выберите мастера</option>
                {staff.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
              </select></label>
            </div>
            <label>Цена, ₽<input required inputMode="decimal" value={personalPrice}
              onChange={e=>setPersonalPrice(e.target.value)} placeholder="2000"/></label>
            <label>Длительность для мастера, минуты (необязательно)
              <input type="number" min={5} max={1440} value={personalDuration}
                onChange={e=>setPersonalDuration(e.target.value)}
                placeholder="Как в общей карточке услуги"/>
            </label>
            <label>Технологическая карта расходников (необязательно)
              <select value={personalTechCard}
                onChange={e=>setPersonalTechCard(e.target.value)}>
                <option value="">Без индивидуальной техкарты</option>
                {technologyCards.map(card=>
                  <option key={card.id} value={card.id}>
                    {card.name} · {card.lines.length} поз.
                  </option>)}
              </select>
            </label>
            {technologyCards.length===0?<p className="muted">
              Нет действующих техкарт. Сначала создайте карту на странице
              <a href="/app/service/setup"> расширенной настройки услуг →</a>
            </p>:null}
            <button disabled={busy||!priceService||!priceStaff||!personalPrice.trim()}>
              Сохранить правило мастера
            </button>
            <p className="muted">Правил сохранено: {rules.length}. Для редактирования существующих правил, периодов и приоритетов используйте расширенные настройки.</p>
          </form>

          <section className="service-desk-panel">
            <h3>Дальнейшая настройка</h3>
            <div className="service-desk-links">
              <a href="/app/service/setup">Персональные цены, техкарты и кабинеты →</a>
              <a href="/app/service/team">Зарплаты и начисления →</a>
              <a href="/app/sites">Форма онлайн-записи на сайте →</a>
              <a href="/app/service/packages">Абонементы →</a>
            </div>
            <p className="muted">Персональных правил оказания услуг: {rules.length}. Отсутствие такого правила не означает нулевую стоимость: применяется основная цена услуги.</p>
          </section>
        </>:null}

        {tab==="clients"?<>
          <div className="service-desk-bar"><div><h2>Клиенты и история визитов</h2><p className="muted">Работаем с CRM, а не с отдельной базой контактов.</p></div><button className="secondary-button" type="button" onClick={()=>setTab("setup")}>+ Клиент</button></div>
          {!customerAccess?<p className="muted" role="alert">У вашей роли нет доступа к CRM. Для просмотра клиента необходимы права crm.read.</p>:null}
          {customerAccess?<div className="service-desk-customer-list">{customers.slice(0,100).map(c=><button key={c.id} type="button" onClick={()=>void viewHistory(c.id)}>
            <strong>{c.displayName}</strong><span>{c.phone??"Контакт не указан"}</span><span>История →</span>
          </button>)}{!customers.length?<p className="muted">Пока клиентов нет. Создайте первого во вкладке «Настройка».</p>:null}</div>:null}
          {historyLoading?<p role="status">Загружаем историю клиента…</p>:null}
          {selectedHistory?<section className="service-desk-panel">
            <div className="service-desk-bar"><h3>{selectedHistory.customer.name}</h3><button className="secondary-button" type="button" onClick={()=>setSelectedHistory(null)}>Закрыть</button></div>
            {selectedHistory.completedRevenueMinor!==null?<p>Стоимость завершённых визитов: {toMoney(selectedHistory.completedRevenueMinor)}. Это не подтверждённая сумма поступивших денег.</p>:null}
            {selectedHistory.bookings.map(v=><div className="service-desk-history" key={v.id}><span>{fmtDate(v.starts_at)}</span><b>{v.service_name}</b><span>{statusName(v.status)}</span></div>)}
            {!selectedHistory.bookings.length?<p className="muted">История посещений пуста.</p>:null}
          </section>:null}
        </>:null}

        {tab==="economics"?<>
          <div className="service-desk-bar"><div><h2>Экономика услуг</h2><p className="muted">Начисления по завершённым визитам, не банковский остаток.</p></div><a className="secondary-button" href="/app/service/team">Зарплаты →</a></div>
          {economics?<><div className="service-desk-metrics">
            <article><small>Начисленная выручка</small><strong>{toMoney(economics.totals.revenue_minor)}</strong></article>
            <article><small>Расходники</small><strong>{toMoney(economics.totals.material_cost_minor)}</strong></article>
            <article><small>Затраты на сотрудников</small><strong>{toMoney(economics.totals.employee_cost_minor)}</strong></article>
            <article><small>Маржа по услугам</small><strong>{toMoney(economics.totals.margin_minor)}</strong></article>
          </div>
          <div className="service-desk-setup-grid">
            <section className="service-desk-panel"><h3>Услуги по марже</h3>{economics.services.slice(0,8).map(s=><div key={s.id} className="service-desk-history"><b>{s.name}</b><span>{s.completed} визитов</span><strong>{toMoney(s.margin_minor)}</strong></div>)}</section>
            <section className="service-desk-panel"><h3>Повторные визиты</h3>{economics.retentionAlerts.slice(0,8).map(x=><div key={x.party_id+"-"+x.service_name} className="service-desk-history"><b>{x.party_name}</b><span>{x.service_name}</span><small>{x.overdue_days} дн.</small></div>)}{!economics.retentionAlerts.length?<p className="muted">Просроченных повторных визитов не найдено.</p>:null}</section>
          </div></>:<p className="muted">{economicsAccess?"Финансовые показатели пока недоступны.":"Финансовые показатели недоступны. Проверьте права finance.read и подключение к API."}</p>}
          <p className="muted">Затраты на аренду, налоги и маркетинг учитываются отдельно в общих финансовых разделах ERP.</p>
        </>:null}

        {createOpen?<div className="service-desk-backdrop" role="presentation" onMouseDown={()=>{if(!busy)setCreateOpen(false);}}>
          <section className="service-desk-drawer" role="dialog" aria-modal="true" aria-label="Новая запись" onMouseDown={e=>e.stopPropagation()}>
            <div className="service-desk-bar"><div><small>Новая запись</small><h2>Записать клиента</h2></div><button type="button" className="secondary-button" onClick={()=>setCreateOpen(false)} disabled={busy}>Закрыть</button></div>
            <form onSubmit={e=>void createBooking(e)} className="service-desk-form">
              <label>Услуга<select required value={bookService} onChange={e=>{setBookService(e.target.value);setBookStaff("");}}>
                <option value="">Выберите услугу</option>{services.filter(s=>["INDIVIDUAL","GROUP"].includes(s.delivery_format)).map(s=>
                  <option key={s.id} value={s.id}>{s.name} · {toMoney(s.price_minor)}</option>)}
              </select></label>
              <label>Дата<input type="date" required value={day} onChange={e=>setDay(e.target.value)}/></label>
              <label>Специалист<select required value={bookStaff} onChange={e=>{setBookStaff(e.target.value);setBookSlot("");}}>
                <option value="">Выберите специалиста</option>{staff.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}
              </select></label>
              <label>Свободное время<select required value={bookSlot} onChange={e=>setBookSlot(e.target.value)} disabled={!bookStaff||slotsBusy}>
                <option value="">{slotsBusy?"Ищем доступные интервалы…":"Выберите интервал"}</option>
                {visibleSlots.map(s=><option key={s.resourceId+"-"+s.startsAt} value={s.startsAt}>
                  {fmtTime(s.startsAt,staff.find(r=>r.id===s.resourceId)?.timezone||"Europe/Moscow")}
                  –{fmtTime(s.endsAt,staff.find(r=>r.id===s.resourceId)?.timezone||"Europe/Moscow")}
                </option>)}
              </select></label>
              {bookStaff&&!slotsBusy&&!visibleSlots.length?<p className="muted" role="status">У этого специалиста на выбранную дату нет доступных интервалов. Проверьте его график, часовой пояс и блокировки.</p>:null}
              <label>Клиент (необязательно)<select value={bookCustomer} onChange={e=>setBookCustomer(e.target.value)}>
                <option value="">Без привязанного клиента</option>{customers.map(c=><option key={c.id} value={c.id}>{c.displayName}</option>)}
              </select></label>
              <p className="muted">В момент сохранения сервер снова проверит график и конкурирующие бронирования.</p>
              <button disabled={busy||!bookSlot||!bookStaff}>Сохранить запись</button>
              <button className="secondary-button" type="button" onClick={()=>{setCreateOpen(false);setTab("setup");}}>Добавить услугу или клиента</button>
            </form>
          </section>
        </div>:null}

        {selectedVisit?<div className="service-desk-backdrop" role="presentation" onMouseDown={()=>{if(!busy)setSelectedVisit(null);}}>
          <section className="service-desk-drawer" role="dialog" aria-modal="true" aria-label="Карточка визита" onMouseDown={e=>e.stopPropagation()}>
            <div className="service-desk-bar"><div><small>Визит №{selectedVisit.business_number}</small><h2>{selectedVisit.service_name}</h2></div><button className="secondary-button" type="button" onClick={()=>{setSelectedVisit(null);setPendingTransition(null);}} disabled={busy}>Закрыть</button></div>
            <div className="service-desk-visit-info">
              <p><b>Клиент:</b> {selectedVisit.party_name??"Не указан"}</p>
              <p><b>Время:</b> {venueDay(selectedVisit.starts_at,zoneForVisit(selectedVisit))},
                {" "}{fmtTime(selectedVisit.starts_at,zoneForVisit(selectedVisit))}
                –{fmtTime(selectedVisit.ends_at,zoneForVisit(selectedVisit))}
                {" "}({zoneForVisit(selectedVisit)})</p>
              <p><b>Специалисты:</b> {selectedVisit.resources.map(x=>x.resourceName).join(", ")}</p>
              <p><b>Статус:</b> {statusName(selectedVisit.status)}</p>
              <p><b>Стоимость услуги:</b> {toMoney(selectedVisit.price_minor_snapshot)}</p>
              <p><b>Финансовый документ:</b> {selectedVisit.billing?.status??selectedVisit.billing_status??"Нет"}</p>
              {selectedVisit.billing?<p><b>Зачтено в оплату:</b> {toMoney(selectedVisit.billing.settledMinor)}. Статус обязательства: {selectedVisit.billing.obligationStatus??"—"}</p>:null}
              {selectedVisit.refund?<p><b>Возврат:</b> {selectedVisit.refund.status} · {toMoney(selectedVisit.refund.amountMinor)}</p>:null}
              <p><b>Материалы:</b> {visitMaterials?visitMaterials.length+" позиций":"Данные недоступны или ещё не загружены"}</p>
            </div>
            <div className="service-desk-actions">
              {nextStages(selectedVisit.status).map(x=><button type="button" key={x.status} disabled={busy}
                className={x.status==="CANCELLED"?"secondary-button":""} onClick={()=>void status(selectedVisit,x.status)}>{x.title}</button>)}
            </div>
            {pendingTransition?<div className="service-desk-panel" role="alertdialog" aria-label="Подтверждение изменения визита">
              <strong>{pendingTransition==="CANCELLED"?"Отменить визит?":pendingTransition==="COMPLETED"?"Подтвердить выполнение услуги?":"Отметить неявку?"}</strong>
              <p className="muted">{pendingTransition==="COMPLETED"
                ?"Завершение запускает расчёт расходников и начислений сотруднику. Поступление оплаты подтверждается отдельно."
                :pendingTransition==="CANCELLED"
                  ?"Система обработает обязательства, возвраты и абонементы по действующим правилам."
                  :"Неявка изменит статус записи и расчёт использования абонемента."}</p>
              <button type="button" disabled={busy}
                onClick={()=>void commitStatus(selectedVisit,pendingTransition)}>Подтвердить действие</button>{" "}
              <button type="button" className="secondary-button" onClick={()=>setPendingTransition(null)}>Назад</button>
            </div>:null}
            {["DRAFT","CONFIRMED"].includes(selectedVisit.status)?<form className="service-desk-form" onSubmit={e=>void reschedule(e)}>
              <label>Перенести визит<input type="datetime-local" required value={rescheduleAt} onChange={e=>setRescheduleAt(e.target.value)}/></label>
              <button type="submit" className="secondary-button" disabled={busy||!rescheduleAt}>Перенести</button>
            </form>:null}
            {selectedVisit.party_id?<button type="button" className="secondary-button" onClick={()=>{void viewHistory(selectedVisit.party_id!);setSelectedVisit(null);setTab("clients");}}>История клиента →</button>:null}
            <p className="muted">Смена статуса не означает получение денег. Техкарты и зарплаты рассчитываются сервером при завершении визита. Если сумма скрыта, финансовых прав у вашей роли нет.</p>
          </section>
        </div>:null}
      </section>
    </main>
  );
}
