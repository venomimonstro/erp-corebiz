"use client";
import {type FormEvent,useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";
type Worker={id:string;name:string;type:string;branch_id:string|null;
  branch_name:string|null;membership_id:string|null;
  online_booking_enabled:boolean;online_min_lead_minutes:number};
type Branch={id:string;name:string};
type Group={trainer_resource_id:string;name:string;program_name:string;status:string};
type Lesson={id:string;trainer_resource_id:string|null;starts_at:string;ends_at:string;
  status:string;booked_count:number;attended_count:number};
type Organization={branches:Branch[]};
type Service={id:string;name:string;category:string|null;
  delivery_format:string;price_minor:string;duration_minutes:number};
type DeliveryRule={id:string;service_id:string;service_name:string;
  employee_resource_id:string|null;branch_id:string|null;
  delivery_format:string;price_minor:string|null;duration_minutes:number|null};
type Context={permissions:Array<{code:string;scope:string}>};
type TeamMember={membership_id:string;email:string;status:string;
  is_owner:boolean;roles:Array<{code:string}>};
export default function DanceStaffPage(){
  const [workers,setWorkers]=useState<Worker[]>([]);
  const [branches,setBranches]=useState<Branch[]>([]);
  const [groups,setGroups]=useState<Group[]>([]);
  const [members,setMembers]=useState<TeamMember[]>([]);
  const [services,setServices]=useState<Service[]>([]);
  const [deliveryRules,setDeliveryRules]=useState<DeliveryRule[]>([]);
  const [assignService,setAssignService]=useState("");
  const [assignPrice,setAssignPrice]=useState("");
  const [assignDuration,setAssignDuration]=useState("60");
  const [lessons,setLessons]=useState<Lesson[]|null>(null);
  const [canManage,setCanManage]=useState(false);
  const [query,setQuery]=useState("");
  const [filter,setFilter]=useState("");
  const [newName,setNewName]=useState("");
  const [newBranch,setNewBranch]=useState("");
  const [selected,setSelected]=useState("");
  const [editedName,setEditedName]=useState("");
  const [onlineEnabled,setOnlineEnabled]=useState(true);
  const [onlineLead,setOnlineLead]=useState("0");
  const [archive,setArchive]=useState(false);
  const [confirmAccess,setConfirmAccess]=useState(false);
  const [trainerLogin,setTrainerLogin]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const reload=useCallback(async()=>{
    setBusy(true);setError("");
    try{
      const nowMonth=new Intl.DateTimeFormat("sv-SE",{timeZone:"Europe/Moscow",
        year:"numeric",month:"2-digit"}).format(new Date());
      const [year,mnum]=nowMonth.split("-").map(Number);
      const nextMonth=new Date(Date.UTC(year,mnum,1)).toISOString().slice(0,7);
      const lessonUrl="/dance/lessons?from="+
        encodeURIComponent(nowMonth+"-01T00:00:00+03:00")+"&to="+
        encodeURIComponent(nextMonth+"-01T00:00:00+03:00");
      const [r,o,g,c,team,lessonsInMonth,serviceList,ruleList]=await Promise.all([
        apiRequest<Worker[]>("/service/resources"),
        apiRequest<Organization>("/organization"),
        apiRequest<Group[]>("/dance/groups"),
        apiRequest<Context>("/workspace/context"),
        apiRequest<TeamMember[]>("/tenants/team"),
        apiRequest<Lesson[]>(lessonUrl).catch(()=>null),
        apiRequest<Service[]>("/service/catalog"),
        apiRequest<DeliveryRule[]>("/service/delivery-rules")
      ]);
      setWorkers(r.filter(x=>x.type==="EMPLOYEE"));
      setBranches(o.branches);setGroups(g);setMembers(team);
      setServices(serviceList);setDeliveryRules(ruleList);
      setLessons(lessonsInMonth);
      setCanManage(c.permissions.some(x=>(x.code==="users.manage"||x.code==="*")
        &&x.scope==="all"));
    }catch(e){setError(e instanceof Error?e.message:"Данные сотрудников недоступны");}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  const loadByTrainer=useMemo(()=>{
    const all=new Map<string,{count:number;hours:number;booked:number;attended:number}>();
    for(const lesson of lessons??[]){
      const id=lesson.trainer_resource_id;
      if(!id||lesson.status.startsWith("CANCELLED"))continue;
      const prev=all.get(id)??{count:0,hours:0,booked:0,attended:0};
      const duration=Math.max(0,
        (Date.parse(lesson.ends_at)-Date.parse(lesson.starts_at))/3600000);
      all.set(id,{
        count:prev.count+1,hours:prev.hours+duration,
        booked:prev.booked+Number(lesson.booked_count||0),
        attended:prev.attended+Number(lesson.attended_count||0)
      });
    }
    return all;
  },[lessons]);
  const visible=useMemo(()=>workers.filter(x=>
    (!filter||x.branch_id===filter)&&x.name.toLocaleLowerCase("ru")
      .includes(query.trim().toLocaleLowerCase("ru"))),[workers,filter,query]);
  const current=workers.find(x=>x.id===selected);
  const linked=members.find(x=>x.membership_id===current?.membership_id);
  // One trainer account can be linked to multiple active branch resources.
  // An already-linked login must remain selectable for a second branch.
  const trainerCandidates=members.filter(x=>x.status==="ACTIVE"&&
    x.roles.length===1&&x.roles[0]?.code==="DANCE_TRAINER");
  const ownRules=deliveryRules.filter(x=>
    x.employee_resource_id===current?.id);
  const assignableServices=services.filter(x=>
    !ownRules.some(rule=>rule.service_id===x.id)&&
    ["INDIVIDUAL","GROUP"].includes(x.delivery_format));
  const activeGroups=groups.filter(x=>x.trainer_resource_id===current?.id&&
    ["ACTIVE","PAUSED"].includes(x.status));
  function changeSelectedService(serviceId:string){
    setAssignService(serviceId);
    const chosen=services.find(x=>x.id===serviceId);
    setAssignDuration(String(chosen?.duration_minutes??60));
    setAssignPrice(chosen?.price_minor?
      (Number(chosen.price_minor)/100).toFixed(2):"");
  }
  async function addTrainerService(e:FormEvent){
    e.preventDefault();
    if(!canManage||!current||!assignService||busy)return;
    const chosen=services.find(x=>x.id===assignService);
    const money=assignPrice.trim().replace(",",".");
    const minutes=Number(assignDuration);
    if(!chosen||!/^\d{1,9}(?:\.\d{1,2})?$/.test(money)||
      !Number.isInteger(minutes)||minutes<5||minutes>1440){
      setError("Укажите услугу, цену и допустимую длительность");return;
    }
    const [whole,fraction=""]=money.split(".");
    const priceMinor=(BigInt(whole)*100n+
      BigInt(fraction.padEnd(2,"0"))).toString();
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/delivery-rules",{
        method:"POST",
        body:JSON.stringify({
          serviceId:chosen.id,employeeResourceId:current.id,
          branchId:current.branch_id??undefined,
          deliveryFormat:chosen.delivery_format,
          priceMinor,durationMinutes:minutes
        })
      });
      setNotice("Услуга назначена тренеру. Индивидуальная цена и длительность сохранены.");
      setAssignService("");setAssignPrice("");
      await reload();
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось назначить услугу");
    }finally{setBusy(false);}
  }
  async function removeTrainerService(ruleId:string){
    if(!canManage||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/delivery-rules/"+ruleId+"/archive",{method:"POST"});
      setNotice("Правило удалено из новых записей. История визитов не изменилась.");
      await reload();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось снять услугу");}
    finally{setBusy(false);}
  }
  async function linkTrainer(){
    if(!canManage||!current||current.membership_id||!trainerLogin||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/dance/trainer/link",{
        method:"POST",body:JSON.stringify({
          resourceId:current.id,membershipId:trainerLogin
        })
      });
      setNotice("Логин привязан к ресурсу. В /portal/trainer тренер увидит все свои активные филиалы.");
      setTrainerLogin("");await reload();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось связать логин");}
    finally{setBusy(false);}
  }
  async function create(e:FormEvent){
    e.preventDefault();setError("");setNotice("");
    if(!canManage)return;
    setBusy(true);
    try{
      await apiRequest("/service/resources",{method:"POST",body:JSON.stringify({
        type:"EMPLOYEE",name:newName,branchId:newBranch||undefined,
        timezone:"Europe/Moscow",capacity:1
      })});
      setNotice("Тренер создан. Назначьте ему группы, услуги и ставку оплаты.");
      setNewName("");await reload();
    }catch(err){setError(err instanceof Error?err.message:"Не удалось создать");}
    finally{setBusy(false);}
  }
  async function updateOnline(e:FormEvent){
    e.preventDefault();
    if(!current||!canManage)return;
    const lead=Number(onlineLead);
    if(!Number.isInteger(lead)||lead<0||lead>10080){
      setError("Минимальное время до записи: от 0 до 10080 минут");return;
    }
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/resources/"+current.id+"/online-policy",{
        method:"PUT",
        body:JSON.stringify({enabled:onlineEnabled,minimumNoticeMinutes:lead})
      });
      setNotice("Онлайн-запись обновлена. Ручной журнал сотрудника работает независимо.");
      await reload();
    }catch(e){setError(e instanceof Error?e.message:"Ошибка настройки онлайн-записи");}
    finally{setBusy(false);}
  }
  async function rename(e:FormEvent){
    e.preventDefault();if(!current||!canManage)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/resources/"+current.id,{
        method:"PATCH",body:JSON.stringify({name:editedName})
      });
      setNotice("Имя изменено. История посещений и начислений сохранена.");
      await reload();setSelected("");
    }catch(err){setError(err instanceof Error?err.message:"Не удалось изменить");}
    finally{setBusy(false);}
  }
  async function archiveWorker(){
    if(!current||!canManage||!archive)return;
    setBusy(true);setError("");setNotice("");
    try{
      const outcome=await apiRequest<{archived:true;loginSuspended:boolean;
        linkedUserRemainsActive:boolean}>(
        "/service/resources/"+current.id+"/archive",{method:"POST"}
      );
      setNotice(outcome.loginSuspended
        ?"Тренер архивирован, его личный доступ остановлен. История сохранена."
        :outcome.linkedUserRemainsActive
          ?"Тренер архивирован, но логин остаётся активным: у человека есть "
           +"другие права (например, совладелец). Проверьте его роль в команде."
          :"Тренер архивирован. История сохранена.");
      setSelected("");setArchive(false);await reload();
    }catch(err){
      setError(err instanceof Error?err.message:"Перед увольнением переназначьте занятия");
    }finally{setBusy(false);}
  }
  async function changeStaffAccess(membershipId:string,status:"ACTIVE"|"SUSPENDED"){
    if(!canManage||!confirmAccess)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/tenants/team/"+membershipId+
        (status==="SUSPENDED"?"/suspend":"/reactivate"),{method:"POST"});
      setConfirmAccess(false);
      setNotice(status==="SUSPENDED"
        ?"Вход сотрудника в эту компанию приостановлен. История сохранена."
        :"Рабочий доступ восстановлен.");
      await reload();
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось изменить рабочий доступ");
    }finally{setBusy(false);}
  }

  return <main className="app-shell">
    <AppSidebar active="dance-team"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div><p className="dance-owner-kicker">Управление персоналом</p>
          <h1>Тренеры и их нагрузка</h1>
          <p>Филиалы, направления, назначенные группы и кадровые изменения.
            История уроков и зарплаты не удаляется при увольнении.</p></div>
        <button disabled={busy} onClick={()=>void reload()}>
          {busy?"Обновляем…":"Обновить"}
        </button>
      </header>
      <DanceWorkspaceNav active="staff"/>
      {error?<p role="alert" className="dance-owner-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      <section className="dance-customer-panel">
        <h2>Поиск по {workers.length} сотрудникам</h2>
        {lessons===null?<p role="status">Нагрузка за месяц пока недоступна;
          число групп не равно фактически отработанным часам.</p>:null}
        <div className="dance-customer-selection">
          <label>Найти тренера
            <input placeholder="Имя" value={query}
              onChange={e=>setQuery(e.target.value)}/></label>
          <label>Филиал
            <select value={filter} onChange={e=>setFilter(e.target.value)}>
              <option value="">Все филиалы</option>
              {branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
            </select></label>
        </div>
        <div className="dance-staff-list">
          {visible.map(x=>{
            const assigned=groups.filter(g=>g.trainer_resource_id===x.id&&
              ["ACTIVE","PAUSED"].includes(g.status));
            return <button type="button" key={x.id} onClick={()=>{
              setSelected(x.id);setEditedName(x.name);setArchive(false);setTrainerLogin("");
              setOnlineEnabled(x.online_booking_enabled!==false);
              setOnlineLead(String(x.online_min_lead_minutes??0));
              setConfirmAccess(false);
            }} className={selected===x.id?"active":""}>
              <strong>{x.name}</strong><span>{x.branch_name??"Без филиала"}</span>
              <small>Групп: {assigned.length}
                {lessons!==null?" · уроков: "+(loadByTrainer.get(x.id)?.count??0):""}
                {assigned.length?" · "+assigned.map(g=>g.program_name).slice(0,2).join(", "):""}
              </small>
            </button>;
          })}
        </div>
      </section>
      {current?<section className="dance-customer-panel">
        <h2>{current.name}</h2>
        {lessons!==null?<div className="dance-customer-metrics">
          <div><small>Уроков за месяц</small>
            <strong>{loadByTrainer.get(current.id)?.count??0}</strong></div>
          <div><small>Запланировано часов</small>
            <strong>{(loadByTrainer.get(current.id)?.hours??0).toFixed(1)}</strong></div>
          <div><small>Записей / посещений</small>
            <strong>{loadByTrainer.get(current.id)?.booked??0} /{" "}
              {loadByTrainer.get(current.id)?.attended??0}</strong></div>
        </div>:null}
        <p>Действующих групп: {activeGroups.length}. При назначенных будущих
          группах и уроках увольнение будет заблокировано до передачи другому тренеру.</p>
        <div className="dance-customer-list">{activeGroups.map(g=>
          <article key={g.name+g.program_name}>
            <strong>{g.name}</strong><span>{g.program_name}</span>
          </article>)}</div>
        {canManage?<section className="dance-customer-panel">
          <h3>Онлайн-запись тренера</h3>
          <p>Как в YCLIENTS: мастер может принимать записи в журнале,
            но не отображаться в публичной форме. Укажите время до визита,
            после которого клиент уже не сможет записаться самостоятельно.</p>
          <form className="dance-budget-fields" onSubmit={e=>void updateOnline(e)}>
            <label><input type="checkbox" checked={onlineEnabled}
              onChange={e=>setOnlineEnabled(e.target.checked)}/>
              Доступен клиентам онлайн</label>
            <label>Минимальное время до начала, минут
              <input type="number" min={0} max={10080} step={5}
                value={onlineLead} onChange={e=>setOnlineLead(e.target.value)}/>
            </label>
            <button type="submit" disabled={busy}>Сохранить настройки записи</button>
          </form>
        </section>:null}
        {canManage?<section className="dance-customer-panel">
          <h3>Какие услуги ведёт тренер</h3>
          <p>Для каждого мастера можно задать свои цену и длительность.
            Изменение применяется к новым записям и не пересчитывает старые.</p>
          {ownRules.length>0?<div className="dance-customer-list">
            {ownRules.map(rule=><article key={rule.id}>
              <strong>{rule.service_name}</strong>
              <span>{rule.price_minor===null?"Цена из каталога":
                new Intl.NumberFormat("ru-RU",{style:"currency",currency:"RUB",
                  maximumFractionDigits:0}).format(Number(rule.price_minor)/100)}
                {" · "}{rule.duration_minutes??"Стандартная"} мин</span>
              <button type="button" disabled={busy}
                onClick={()=>void removeTrainerService(rule.id)}>
                Снять назначение для будущих записей
              </button>
            </article>)}
          </div>:<p>Персональных услуг пока нет.</p>}
          {assignableServices.length>0?<form onSubmit={e=>void addTrainerService(e)}
            className="dance-budget-fields">
            <label>Услуга
              <select required value={assignService}
                onChange={e=>changeSelectedService(e.target.value)}>
                <option value="">Выбрать из каталога</option>
                {assignableServices.map(item=><option key={item.id}
                  value={item.id}>{item.category??"Услуги"} · {item.name}</option>)}
              </select>
            </label>
            <label>Цена тренера, ₽
              <input required inputMode="decimal" value={assignPrice}
                onChange={e=>setAssignPrice(e.target.value)}/>
            </label>
            <label>Длительность, мин
              <input required type="number" min={5} max={1440}
                value={assignDuration}
                onChange={e=>setAssignDuration(e.target.value)}/>
            </label>
            <button type="submit" disabled={busy||!assignService||
              !assignPrice.trim()}>Назначить услугу</button>
          </form>:<p>Все доступные услуги уже назначены.</p>}
        </section>:null}
        {canManage?<div className="dance-staff-actions">
          <form onSubmit={e=>void rename(e)}>
            <label>Название сотрудника<input value={editedName}
              onChange={e=>setEditedName(e.target.value)}/></label>
            <button disabled={busy||editedName.trim().length<2}>
              Сохранить имя</button>
          </form>
          <label><input type="checkbox" checked={archive}
              onChange={e=>setArchive(e.target.checked)}/>
            Я проверил(а) будущие занятия и понимаю, что данные не удаляются.
          </label>
          <button type="button" disabled={busy||!archive}
            onClick={()=>void archiveWorker()}>Архивировать тренера</button>
        </div>:null}
        {canManage&&!current.membership_id?<div className="dance-customer-panel">
          <h3>Личный календарь тренера</h3>
          <p>После приглашения тренера с ролью DANCE_TRAINER свяжите
            его учётную запись с рабочим ресурсом. Тренер получит доступ
            только к своему расписанию, без финансов и других клиентов.</p>
          <select aria-label="Логин тренера" value={trainerLogin}
            onChange={e=>setTrainerLogin(e.target.value)}>
            <option value="">Выбрать приглашённый аккаунт</option>
            {trainerCandidates.map(user=>{
              const assigned=workers.filter(resource=>
                resource.membership_id===user.membership_id);
              return <option key={user.membership_id} value={user.membership_id}>
                {user.email}{assigned.length
                  ?" · активных назначений: "+assigned.length:""}
              </option>;
            })}
          </select>
          <button type="button" disabled={busy||!trainerLogin}
            onClick={()=>void linkTrainer()}>Связать аккаунт с тренером</button>
          <p><a href="/app/settings/team">Пригласить тренера в команду →</a></p>
        </div>:null}
        {canManage&&current.membership_id?<div className="dance-customer-panel">
          <h3>Вход сотрудника в CoreBiz</h3>
          <p>{linked?.email??"Логин"} · {linked?.status??"статус неизвестен"}.
            Приостановка доступа действует только в этой компании и не удаляет
            сведения о посещениях или выплатах.</p>
          {linked?.is_owner?<p>Аккаунт владельца нельзя отключать через кадровые операции.</p>:
            linked&&["ACTIVE","SUSPENDED"].includes(linked.status)?<>
              <label><input type="checkbox" checked={confirmAccess}
                onChange={e=>setConfirmAccess(e.target.checked)}/>
                Подтверждаю, что это именно учётная запись сотрудника,
                и изменение доступа согласовано.</label>
              <button disabled={busy||!confirmAccess} type="button"
                onClick={()=>void changeStaffAccess(linked.membership_id,
                  linked.status==="ACTIVE"?"SUSPENDED":"ACTIVE")}>
                {linked.status==="ACTIVE"?"Приостановить вход":"Восстановить вход"}
              </button>
            </>:<p>Статус не позволяет выполнить операцию.</p>}
        </div>:null}
        <p><a href="/app/dance/groups">Переназначить группу →</a>{" "}
          <a href="/app/dance/team">Настроить зарплату →</a>{" "}
          <a href="/app/service/resources">Графики и отпуска →</a></p>
      </section>:null}
      {canManage&&members.some(x=>x.status==="SUSPENDED")?
        <section className="dance-customer-panel">
          <h2>Сотрудники с приостановленным входом</h2>
          {members.filter(x=>x.status==="SUSPENDED").map(x=>
            <article key={x.membership_id}>
              <strong>{x.email}</strong>
              <span>{" · "}{x.roles.map(r=>r.code).join(", ")}</span>
              {confirmAccess?<button disabled={busy} type="button"
                onClick={()=>void changeStaffAccess(x.membership_id,"ACTIVE")}>
                Восстановить доступ</button>:null}
            </article>)}
          <label><input type="checkbox" checked={confirmAccess}
            onChange={e=>setConfirmAccess(e.target.checked)}/>
            Подтверждаю проверку права на восстановление доступа.</label>
        </section>:null}
      {canManage?<section className="dance-customer-panel">
        <h2>Добавить тренера</h2>
        <form className="dance-budget-fields" onSubmit={e=>void create(e)}>
          <label>Имя тренера<input required minLength={2} value={newName}
            onChange={e=>setNewName(e.target.value)}/></label>
          <label>Основной филиал
            <select value={newBranch} onChange={e=>setNewBranch(e.target.value)}>
              <option value="">Пока не назначен</option>
              {branches.map(b=><option key={b.id} value={b.id}>{b.name}</option>)}
            </select></label>
          <button type="submit" disabled={busy||newName.trim().length<2}>
            Добавить тренера</button>
        </form>
        <p>Чтобы тренер входил в свой личный кабинет, сначала
          пригласите его в <a href="/app/settings/team">команду компании</a>
          и свяжите логин с ресурсом. Простое добавление ресурса не создаёт логин.</p>
      </section>:null}
    </section>
  </main>;
}
