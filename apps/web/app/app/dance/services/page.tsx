"use client";
import {type FormEvent,useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Service={id:string;name:string;category:string|null;
  duration_minutes:number;price_minor:string;delivery_format:string};
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
      setPermissions({write:has("service.write"),admin:has("users.manage")});
    }catch(e){setError(e instanceof Error?e.message:"Не удалось открыть каталог услуг");}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  const chosen=items.find(x=>x.id===selected);
  const filtered=useMemo(()=>items.filter(x=>
    (x.name+" "+(x.category??"")).toLocaleLowerCase("ru")
      .includes(search.trim().toLocaleLowerCase("ru"))),[items,search]);
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
          name,category:category||null,durationMinutes:minutes,priceMinor
        })
      });
      setNotice("Изменения сохранены. Уже оформленные занятия остаются по старой цене.");
      await reload();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось изменить услугу");}
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
        <h2>Каталог · {items.length} услуг</h2>
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
        <form className="dance-budget-fields" onSubmit={e=>void save(e)}>
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
        </form>
        {permissions.admin?<div className="dance-staff-actions">
          <label><input type="checkbox" checked={archiveConfirm}
            onChange={e=>setArchiveConfirm(e.target.checked)}/>
            Сначала проверил(а), что услуга не используется в действующих
            направлениях или будущих записях.</label>
          <button type="button" disabled={busy||!archiveConfirm}
            onClick={()=>void archive()}>Архивировать услугу</button>
        </div>:null}
      </section>:null}
    </section>
  </main>;
}
