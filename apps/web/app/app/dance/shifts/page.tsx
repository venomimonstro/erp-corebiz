"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";
type Resource={id:string;name:string;type:string;branch_id:string|null;membership_id:string|null};
type Member={membership_id:string;email:string;status:string;roles:Array<{code:string}>};
type Branch={id:string;name:string};
type Organization={branches:Branch[]};
type Context={permissions:Array<{code:string;scope:string}>};
const moscowDate=()=>new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Moscow",
  year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
function formattedHour(value:number){
  return String(Math.floor(value/60)).padStart(2,"0")+":"+
    String(value%60).padStart(2,"0");
}
export default function DanceShifts(){
  const [resources,setResources]=useState<Resource[]>([]);
  const [members,setMembers]=useState<Member[]>([]);
  const [branches,setBranches]=useState<Branch[]>([]);
  const [mayManage,setMayManage]=useState(false);
  const [first,setFirst]=useState("");
  const [second,setSecond]=useState("");
  const [start,setStart]=useState(moscowDate);
  const [days,setDays]=useState("60");
  const [opens,setOpens]=useState("09:00");
  const [closes,setCloses]=useState("21:00");
  const [replace,setReplace]=useState(false);
  const [working,setWorking]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const refresh=useCallback(async()=>{
    setBusy(true);setError("");setNotice("");
    try{
      const [people,team,organization,ctx]=await Promise.all([
        apiRequest<Resource[]>("/service/resources"),
        apiRequest<Member[]>("/tenants/team"),
        apiRequest<Organization>("/organization"),
        apiRequest<Context>("/workspace/context")
      ]);
      setResources(people.filter(x=>x.type==="EMPLOYEE"));
      setMembers(team);setBranches(organization.branches);
      setMayManage(ctx.permissions.some(x=>(x.code==="users.manage"||x.code==="*")
        &&x.scope==="all"));
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить сотрудников");}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  const managerIds=useMemo(()=>new Set(members.filter(m=>m.status==="ACTIVE"&&
    m.roles.some(r=>r.code==="DANCE_MANAGER")).map(m=>m.membership_id)),[members]);
  const managers=resources.filter(r=>r.membership_id&&managerIds.has(r.membership_id));
  const names=new Map(resources.map(r=>[r.id,r.name]));
  const branchNames=new Map(branches.map(b=>[b.id,b.name]));
  const preview=useMemo(()=>{
    const value=Date.parse(start+"T00:00:00Z");
    if(!Number.isFinite(value))return [];
    return Array.from({length:Math.min(28,Number(days)||0)},(_,index)=>{
      const date=new Date(value+index*86400000).toISOString().slice(0,10);
      const firstWorking=Math.floor(index/2)%2===0;
      return {date,firstWorking};
    });
  },[start,days]);
  const minute=(x:string)=>{
    const [h,m]=x.split(":").map(Number);
    return Number.isInteger(h)&&Number.isInteger(m)?h*60+m:NaN;
  };
  async function apply(){
    setError("");setNotice("");setWorking(false);
    const size=Number(days),a=minute(opens),b=minute(closes);
    if(!mayManage||!first||!second||first===second||
      !Number.isInteger(size)||size<4||size>90||
      !Number.isInteger(a)||!Number.isInteger(b)||b-a<60||a<0||b>1440){
      setError("Выберите двух разных менеджеров, даты и корректные часы работы.");return;
    }
    setBusy(true);
    const applied:string[]=[];
    try{
      for(const [index,id] of [first,second].entries()){
        await apiRequest("/service/resources/"+id+"/two-by-two",{
          method:"POST",body:JSON.stringify({
            startDate:start,days:size,
            startsWorking:index===0,startMinute:a,endMinute:b,
            replaceWeeklySchedule:replace
          })
        });
        applied.push(id);
      }
      setNotice("График 2/2 сохранён для обоих менеджеров на "+size+
        " дней. Отпуска и другие ручные блокировки остались без изменений.");
    }catch(e){
      const cause=e instanceof Error?e.message:"Не удалось записать график";
      setError(applied.length>0
        ?"График первого менеджера сохранён, второго — нет. "+
        "Повторите сохранение после исправления ошибки: "+cause
        :"Ничего не сохранено. "+cause);
    }finally{setBusy(false);}
  }
  return <main className="app-shell">
    <AppSidebar active="dance-team"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div><p className="dance-owner-kicker">Московская студия · графики</p>
          <h1>Смены менеджеров 2/2</h1>
          <p>Каждые два дня менеджеры меняются. Слоты формируются в
            часовом поясе ресурса, а отсутствие отражается в едином календаре.</p>
        </div>
        <button type="button" disabled={busy} onClick={()=>void refresh()}>
          Обновить сотрудников</button>
      </header>
      <DanceWorkspaceNav active="shifts"/>
      {error?<p role="alert" className="dance-owner-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      <section className="dance-customer-panel">
        <h2>Выберите пару администраторов</h2>
        <p>Менеджеры должны иметь роль «Менеджер студии» и привязанный
          рабочий ресурс. Первый работает два дня, затем второй работает два дня.</p>
        {managers.length<2?<p className="muted">
          Сначала создайте двух пользователей с ролью «Менеджер студии»
          и свяжите их с ресурсами в разделе <a href="/app/dance/staff">
          «Тренеры и команда»</a>.</p>:null}
        <div className="dance-budget-fields">
          <label>Менеджер 1
            <select value={first} onChange={e=>setFirst(e.target.value)}>
              <option value="">Выбрать</option>
              {managers.map(m=><option key={m.id} value={m.id}>
                {m.name} · {branchNames.get(m.branch_id??"")??"Без филиала"}</option>)}
            </select>
          </label>
          <label>Менеджер 2
            <select value={second} onChange={e=>setSecond(e.target.value)}>
              <option value="">Выбрать</option>
              {managers.filter(m=>m.id!==first).map(m=><option key={m.id} value={m.id}>
                {m.name} · {branchNames.get(m.branch_id??"")??"Без филиала"}</option>)}
            </select>
          </label>
          <label>Дата начала
            <input type="date" value={start} onChange={e=>setStart(e.target.value)}/>
          </label>
          <label>Дней вперёд (4–90)
            <input type="number" min={4} max={90} value={days}
              onChange={e=>setDays(e.target.value)}/>
          </label>
          <label>Начало смены
            <input type="time" value={opens} onChange={e=>setOpens(e.target.value)}/>
          </label>
          <label>Окончание смены
            <input type="time" value={closes} onChange={e=>setCloses(e.target.value)}/>
          </label>
        </div>
        <label className="dance-client-revoke">
          <input type="checkbox" checked={replace}
            onChange={e=>setReplace(e.target.checked)}/>
          Подтверждаю замену уже сохранённого недельного шаблона,
          если он отличается от выбранных часов. Ручные блокировки
          и отпуска не удаляются.
        </label>
        {preview.length>0?<div className="dance-shift-preview">
          <h3>Предпросмотр первых {preview.length} дней</h3>
          <div className="dance-shift-calendar">
            {preview.map(x=><div key={x.date}>
              <small>{x.date}</small>
              <strong>{x.firstWorking?names.get(first)??"Первый менеджер":
                names.get(second)??"Второй менеджер"}</strong>
              <span>{formattedHour(minute(opens))}–{formattedHour(minute(closes))}</span>
            </div>)}
          </div>
        </div>:null}
        <button type="button" disabled={!mayManage||busy||!first||!second||
          first===second||!Number.isInteger(Number(days))}
          onClick={()=>void apply()}>Сохранить график 2/2</button>
        <p className="muted">График действует только на указанный период.
          До его окончания необходимо сформировать следующий. Эта операция
          не рассчитывает и не выплачивает зарплату автоматически.</p>
      </section>
    </section>
  </main>;
}
