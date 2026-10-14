"use client";
import {type FormEvent,useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Program={
 id:string;name:string;code:string|null;service_id:string|null;service_name:string|null;
 branch_id:string|null;min_age:number|null;max_age:number|null;
 default_duration_minutes:number;status:"ACTIVE"|"ARCHIVED";revision:string
};
type Service={id:string;name:string;status?:string;delivery_format:string};
type Branch={id:string;name:string};
type Organization={branches:Branch[]};
type Context={permissions:Array<{code:string;scope:string}>};
const can=(context:Context,code:string)=>context.permissions.some(
 p=>(p.code===code||p.code==="*")&&p.scope==="all"
);
export default function DanceDirectionsPage(){
 const [programs,setPrograms]=useState<Program[]>([]);
 const [services,setServices]=useState<Service[]>([]);
 const [branches,setBranches]=useState<Branch[]>([]);
 const [editable,setEditable]=useState(false);
 const [selected,setSelected]=useState("");
 const [name,setName]=useState("");
 const [serviceId,setServiceId]=useState("");
 const [branchId,setBranchId]=useState("");
 const [minAge,setMinAge]=useState("");
 const [maxAge,setMaxAge]=useState("");
 const [duration,setDuration]=useState("60");
 const [mode,setMode]=useState<"CREATE"|"EDIT">("CREATE");
 const [includeArchived,setIncludeArchived]=useState(false);
 const [confirm,setConfirm]=useState<"ARCHIVE"|"RESTORE"|null>(null);
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [notice,setNotice]=useState("");
 const load=useCallback(async()=>{
   setBusy(true);setError("");
   try{
     const [p,s,o,c]=await Promise.all([
       apiRequest<Program[]>("/dance/programs?includeArchived=true"),
       apiRequest<Service[]>("/service/catalog"),
       apiRequest<Organization>("/organization"),
       apiRequest<Context>("/workspace/context")
     ]);
     setPrograms(p);setServices(s);setBranches(o.branches);
     setEditable(can(c,"dance.write")&&can(c,"catalog.write"));
   }catch(e){setPrograms([]);setEditable(false);
     setError(e instanceof Error?e.message:"Не удалось загрузить направления");}
   finally{setBusy(false);}
 },[]);
 useEffect(()=>{void load();},[load]);
 const current=programs.find(x=>x.id===selected);
 const visible=useMemo(()=>programs.filter(x=>includeArchived||x.status==="ACTIVE"),
  [programs,includeArchived]);
 function choose(x:Program){
   setMode("EDIT");setSelected(x.id);setName(x.name);
   setServiceId(x.service_id??"");setBranchId(x.branch_id??"");
   setDuration(String(x.default_duration_minutes));
   setMinAge(x.min_age===null?"":String(x.min_age));
   setMaxAge(x.max_age===null?"":String(x.max_age));
   setConfirm(null);setError("");setNotice("");
 }
 function blank(){
   setMode("CREATE");setSelected("");setName("");setBranchId("");
   setServiceId("");setDuration("60");setMinAge("");setMaxAge("");
   setConfirm(null);
 }
 const fields=()=>{
   const n=Number(duration);
   const min=minAge.trim()?Number(minAge):null;
   const max=maxAge.trim()?Number(maxAge):null;
   if(name.trim().length<2||name.trim().length>160||
      !services.some(x=>x.id===serviceId)||
      !Number.isInteger(n)||n<15||n>360||
      (min!==null&&(!Number.isInteger(min)||min<0||min>120))||
      (max!==null&&(!Number.isInteger(max)||max<0||max>120))||
      (min!==null&&max!==null&&min>max))
     throw new Error("Проверьте название, услугу, длительность и возраст.");
   return {name:name.trim(),serviceId,branchId:branchId||null,
     minAge:min,maxAge:max,defaultDurationMinutes:n};
 };
 async function save(event:FormEvent){
   event.preventDefault();if(busy||!editable)return;
   setBusy(true);setError("");setNotice("");
   try{
     const params=fields();
     if(mode==="CREATE"){
       await apiRequest("/dance/programs",{
         method:"POST",body:JSON.stringify(params)
       });
       setNotice("Направление создано. Добавьте группы и назначьте тренера.");
     }else{
       if(!current||current.status!=="ACTIVE")throw new Error(
         "Архивное направление нужно сначала восстановить");
       await apiRequest("/dance/programs/"+encodeURIComponent(current.id),{
         method:"PATCH",body:JSON.stringify({
           ...params,expectedRevision:current.revision
         })
       });
       setNotice("Изменения сохранены. История посещений не переписана.");
     }
     blank();await load();
   }catch(e){setError(e instanceof Error?e.message:"Ошибка сохранения");}
   finally{setBusy(false);}
 }
 async function lifecycle(){
   if(!current||!confirm||busy||!editable)return;
   setBusy(true);setError("");setNotice("");
   try{
     await apiRequest("/dance/programs/"+encodeURIComponent(current.id)+
       (confirm==="ARCHIVE"?"/archive":"/restore"),{
       method:"POST",body:JSON.stringify({expectedRevision:current.revision})
     });
     setNotice(confirm==="ARCHIVE"
       ?"Направление архивировано. Группы и история сохранены."
       :"Направление восстановлено. Проверьте актуальность услуги и расписания.");
     blank();await load();
   }catch(e){setError(e instanceof Error?e.message:"Не удалось изменить статус");
     // Revision may have changed; require an explicit refresh before retry.
     setConfirm(null);await load();
   }finally{setBusy(false);}
 }
 return <main className="app-shell">
  <AppSidebar active="dance-groups"/>
  <section className="workspace workspace-wide">
   <header className="dance-owner-heading">
     <div><p className="dance-owner-kicker">Управление направлениями</p>
     <h1>Направления и их услуги</h1>
     <p>Одно направление связано с услугой из общего каталога CoreBiz.
       Его цена не дублируется в танцевом модуле.</p></div>
     <button type="button" disabled={busy} onClick={()=>void load()}>
       {busy?"Загрузка…":"Обновить"}
     </button>
   </header>
   <DanceWorkspaceNav active="directions"/>
   {error?<p role="alert" className="dance-owner-error">{error}</p>:null}
   {notice?<p role="status">{notice}</p>:null}
   <section className="dance-customer-panel">
     <div className="service-desk-bar">
       <h2>Все направления ({visible.length})</h2>
       <label><input type="checkbox" checked={includeArchived}
         onChange={e=>setIncludeArchived(e.target.checked)}/>
         Показывать архив</label>
     </div>
     <div className="dance-staff-list">
       {visible.map(x=><button type="button" key={x.id}
         className={selected===x.id?"active":""} onClick={()=>choose(x)}>
         <strong>{x.name}</strong>
         <span>{x.service_name??"Услуга не определена"}</span>
         <small>{x.default_duration_minutes} мин · {x.status==="ACTIVE"?"Активно":"Архив"}</small>
       </button>)}
     </div>
     {editable?<button type="button" className="secondary-button"
       onClick={blank}>Создать направление</button>:null}
   </section>
   {editable?<section className="dance-customer-panel">
     <h2>{mode==="CREATE"?"Создать направление":"Изменить направление"}</h2>
     <p>Менеджеры могут записывать клиентов, но не менять ассортимент,
       стоимость и направление без прав каталога.</p>
     <form className="dance-budget-fields" onSubmit={event=>void save(event)}>
       <label>Название направления
         <input required minLength={2} maxLength={160} value={name}
           onChange={e=>setName(e.target.value)}/></label>
       <label>Услуга общего каталога
         <select required value={serviceId} onChange={e=>setServiceId(e.target.value)}>
           <option value="">Выберите услугу</option>
           {services.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
         </select></label>
       <label>Филиал
         <select value={branchId} onChange={e=>setBranchId(e.target.value)}>
           <option value="">Все филиалы</option>
           {branches.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
         </select></label>
       <label>Длительность занятия, минут
         <input type="number" min={15} max={360} value={duration}
           onChange={e=>setDuration(e.target.value)}/></label>
       <label>Возраст от (необязательно)
         <input type="number" min={0} max={120} value={minAge}
           onChange={e=>setMinAge(e.target.value)}/></label>
       <label>Возраст до (необязательно)
         <input type="number" min={0} max={120} value={maxAge}
           onChange={e=>setMaxAge(e.target.value)}/></label>
       <button type="submit" disabled={busy||mode==="EDIT"&&current?.status==="ARCHIVED"}>
         {mode==="CREATE"?"Создать направление":"Сохранить изменения"}
       </button>
     </form>
     {current?<div className="dance-staff-actions">
       <label><input type="checkbox" checked={confirm!==null}
         onChange={e=>setConfirm(e.target.checked?
           current.status==="ACTIVE"?"ARCHIVE":"RESTORE":null)}/>
         {current.status==="ACTIVE"
           ?"Я проверил(а) связанные группы и будущие занятия перед архивированием."
           :"Я проверил(а) действующую услугу перед восстановлением."}
       </label>
       <button type="button" disabled={busy||!confirm} onClick={()=>void lifecycle()}>
         {current.status==="ACTIVE"?"Архивировать":"Восстановить"}
       </button>
     </div>:null}
     <p><a href="/app/dance/groups">Группы и расписание →</a>{" "}
       <a href="/app/dance/services">Цены общего каталога →</a></p>
   </section>:<p className="muted">Редактирование направлений доступно руководителю
     с полномочиями изменения каталога.</p>}
  </section>
 </main>;
}
