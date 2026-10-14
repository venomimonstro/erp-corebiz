"use client";
import {type FormEvent,useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Service={id:string;name:string;category:string|null;
  duration_minutes:number;price_minor:string;delivery_format:string;revision:string};
type Context={permissions:Array<{code:string;scope:string}>};
const rub=(minor:string)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB",maximumFractionDigits:0
}).format(Number(minor)/100);
const minor=(rubles:string)=>{
  const raw=rubles.trim().replace(",",".");
  if(!/^\d{1,10}(?:\.\d{1,2})?$/.test(raw))return null;
  const [a,b=""]=raw.split(".");
  return String(BigInt(a)*100n+BigInt(b.padEnd(2,"0")));
};
export default function DanceServiceCatalogPage(){
  const [items,setItems]=useState<Service[]>([]);
  const [archivedItems,setArchivedItems]=useState<Service[]>([]);
  const [showArchived,setShowArchived]=useState(false);
  const [permissions,setPermissions]=useState({write:false,admin:false});
  const [selected,setSelected]=useState("");
  const [name,setName]=useState("");
  const [category,setCategory]=useState("");
  const [price,setPrice]=useState("");
  const [duration,setDuration]=useState("60");
  const [archiveConfirm,setArchiveConfirm]=useState(false);
  const [search,setSearch]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const reload=useCallback(async()=>{
    setBusy(true);setError("");
    try{
      const [all,ctx]=await Promise.all([
        apiRequest<Service[]>("/service/catalog"),
        apiRequest<Context>("/workspace/context")
      ]);
      setItems(all);
      const has=(code:string)=>ctx.permissions.some(p=>
        (p.code===code||p.code==="*")&&p.scope==="all");
      const isAdmin=has("users.manage");
      setPermissions({write:has("service.write"),admin:isAdmin});
      setArchivedItems(isAdmin?await apiRequest<Service[]>("/service/catalog/archived"):[]);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось открыть каталог услуг");}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  const source=showArchived?archivedItems:items;
  const chosen=source.find(x=>x.id===selected);
  const filtered=useMemo(()=>source.filter(x=>
    (x.name+" "+(x.category??"")).toLocaleLowerCase("ru")
      .includes(search.trim().toLocaleLowerCase("ru"))),[source,search]);
  const categories=[...new Set(items.map(x=>x.category).filter(
    (x):x is string=>Boolean(x)))].sort();
  const pick=(item:Service)=>{
    setSelected(item.id);setName(item.name);
    setCategory(item.category??"");
    setPrice((Number(item.price_minor)/100).toFixed(2));
    setDuration(String(item.duration_minutes));
    setArchiveConfirm(false);setError("");setNotice("");
  };
  async function save(e:FormEvent){
    e.preventDefault();
    if(!chosen||!permissions.write)return;
    const priceMinor=minor(price),minutes=Number(duration);
    if(priceMinor===null||!Number.isInteger(minutes)||minutes<5||minutes>1440){
      setError("Проверьте цену и длительность услуги");return;
    }
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/catalog/"+chosen.id,{
        method:"PATCH",body:JSON.stringify({
          name,category:category||null,durationMinutes:minutes,priceMinor,
          expectedRevision:chosen.revision
        })
      });
      setNotice("Изменения сохранены. Уже оформленные занятия остаются по старой цене.");
      await reload();
    }catch(e){
      setError((e instanceof Error?e.message:"Не удалось изменить услугу")+
        ". Если администратор уже изменил цену, обновите данные перед повтором.");
    }
    finally{setBusy(false);}
  }
  async function restore(){
    if(!chosen||!permissions.admin||!archiveConfirm)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/catalog/"+chosen.id+"/restore",{method:"POST"});
      setSelected("");setArchiveConfirm(false);
      await reload();
      setNotice("Услуга восстановлена. Перед записью клиентов проверьте цену, назначенных тренеров и длительность.");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось восстановить услугу");}
    finally{setBusy(false);}
  }
  async function archive(){
    if(!chosen||!archiveConfirm||!permissions.admin)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/service/catalog/"+chosen.id+"/archive",{method:"POST"});
      setNotice("Услуга скрыта для новых продаж. История сохранена.");
      setSelected("");await reload();
    }catch(e){setError(e instanceof Error?e.message:"Сначала архивируйте активные направления");}
    finally{setBusy(false);}
  }
  return <main className="app-shell">
    <AppSidebar active="dance-setup"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div><p className="dance-owner-kicker">Управление ассортиментом</p>
          <h1>Услуги и направления</h1>
          <p>Групповые занятия, индивидуальные тренировки и аренда.
            Редактирование не переписывает историю оплат и посещений.</p></div>
        <button disabled={busy} onClick={()=>void reload()}>Обновить</button>
      </header>
      <DanceWorkspaceNav active="services"/>
      {error?<p role="alert" className="dance-owner-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      <section className="dance-customer-panel">
        <h2>{showArchived?"Архив услуг":"Каталог услуг"} · {source.length}</h2>
        {permissions.admin?<label className="dance-catalog-archive-toggle">
          <input type="checkbox" checked={showArchived} onChange={e=>{
            setShowArchived(e.target.checked);setSelected("");setArchiveConfirm(false);
          }}/>
          Показать архивные услуги
        </label>:null}
        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Поиск по названию или направлению" aria-label="Поиск услуг"/>
        <div className="dance-staff-list">{filtered.map(x=>
          <button key={x.id} type="button" className={selected===x.id?"active":""}
            onClick={()=>pick(x)}>
            <strong>{x.name}</strong><span>{x.category??"Без категории"}
              {" · "}{x.delivery_format}</span>
            <small>{rub(x.price_minor)} · {x.duration_minutes} мин</small>
          </button>)}</div>
        <p><a href="/app/dance/setup">Создать новую услугу или назначить её тренеру →</a></p>
      </section>
      {chosen?<section className="dance-customer-panel">
        <h2>Изменение услуги</h2>
        {!showArchived?<form className="dance-budget-fields" onSubmit={e=>void save(e)}>
          <label>Название<input value={name} required minLength={2}
            onChange={e=>setName(e.target.value)}/></label>
          <label>Категория / направление
            <input value={category} list="dance-service-categories"
              onChange={e=>setCategory(e.target.value)}/>
            <datalist id="dance-service-categories">
              {categories.map(x=><option key={x} value={x}/>)}
            </datalist>
          </label>
          <label>Цена, ₽<input inputMode="decimal" value={price}
            onChange={e=>setPrice(e.target.value)} required/></label>
          <label>Длительность, минут<input type="number" min={5} max={1440}
            value={duration} onChange={e=>setDuration(e.target.value)} required/></label>
          <button disabled={!permissions.write||busy||!name.trim()} type="submit">
            Сохранить изменения
          </button>
        </form>:<p>Архивная услуга доступна только для просмотра. После восстановления проверьте актуальность цены и назначений.</p>}
        {permissions.admin?<div className="dance-staff-actions">
          <label><input type="checkbox" checked={archiveConfirm}
            onChange={e=>setArchiveConfirm(e.target.checked)}/>
            {showArchived?"Подтверждаю возвращение услуги в активный каталог и проверку её цены и расписания.":
             "Подтверждаю проверку направлений и будущих записей перед архивированием."}</label>
          <button type="button" disabled={busy||!archiveConfirm}
            onClick={()=>void (showArchived?restore():archive())}>
              {showArchived?"Восстановить услугу":"Архивировать услугу"}
          </button>
        </div>:null}
      </section>:null}
    </section>
  </main>;
}
