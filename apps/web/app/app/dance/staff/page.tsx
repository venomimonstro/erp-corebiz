"use client";
import {type FormEvent,useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";
type Worker={id:string;name:string;type:string;branch_id:string|null;
  branch_name:string|null;membership_id:string|null};
type Branch={id:string;name:string};
type Group={trainer_resource_id:string;name:string;program_name:string;status:string};
type Organization={branches:Branch[]};
type Context={permissions:Array<{code:string;scope:string}>};
export default function DanceStaffPage(){
  const [workers,setWorkers]=useState<Worker[]>([]);
  const [branches,setBranches]=useState<Branch[]>([]);
  const [groups,setGroups]=useState<Group[]>([]);
  const [canManage,setCanManage]=useState(false);
  const [query,setQuery]=useState("");
  const [filter,setFilter]=useState("");
  const [newName,setNewName]=useState("");
  const [newBranch,setNewBranch]=useState("");
  const [selected,setSelected]=useState("");
  const [editedName,setEditedName]=useState("");
  const [archive,setArchive]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const reload=useCallback(async()=>{
    setBusy(true);setError("");
    try{
      const [r,o,g,c]=await Promise.all([
        apiRequest<Worker[]>("/service/resources"),
        apiRequest<Organization>("/organization"),
        apiRequest<Group[]>("/dance/groups"),
        apiRequest<Context>("/workspace/context")
      ]);
      setWorkers(r.filter(x=>x.type==="EMPLOYEE"));
      setBranches(o.branches);setGroups(g);
      setCanManage(c.permissions.some(x=>(x.code==="users.manage"||x.code==="*")
        &&x.scope==="all"));
    }catch(e){setError(e instanceof Error?e.message:"Данные сотрудников недоступны");}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void reload();},[reload]);
  const visible=useMemo(()=>workers.filter(x=>
    (!filter||x.branch_id===filter)&&x.name.toLocaleLowerCase("ru")
      .includes(query.trim().toLocaleLowerCase("ru"))),[workers,filter,query]);
  const current=workers.find(x=>x.id===selected);
  const activeGroups=groups.filter(x=>x.trainer_resource_id===current?.id&&
    ["ACTIVE","PAUSED"].includes(x.status));
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
      await apiRequest("/service/resources/"+current.id+"/archive",{method:"POST"});
      setNotice("Тренер архивирован. История сохранена.");
      setSelected("");setArchive(false);await reload();
    }catch(err){
      setError(err instanceof Error?err.message:"Перед увольнением переназначьте занятия");
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
              setSelected(x.id);setEditedName(x.name);setArchive(false);
            }} className={selected===x.id?"active":""}>
              <strong>{x.name}</strong><span>{x.branch_name??"Без филиала"}</span>
              <small>Групп: {assigned.length}
                {assigned.length?" · "+assigned.map(g=>g.program_name).slice(0,2).join(", "):""}
              </small>
            </button>;
          })}
        </div>
      </section>
      {current?<section className="dance-customer-panel">
        <h2>{current.name}</h2>
        <p>Действующих групп: {activeGroups.length}. При назначенных будущих
          группах и уроках увольнение будет заблокировано до передачи другому тренеру.</p>
        <div className="dance-customer-list">{activeGroups.map(g=>
          <article key={g.name+g.program_name}>
            <strong>{g.name}</strong><span>{g.program_name}</span>
          </article>)}</div>
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
        <p><a href="/app/dance/groups">Переназначить группу →</a>{" "}
          <a href="/app/dance/team">Настроить зарплату →</a>{" "}
          <a href="/app/service/resources">Графики и отпуска →</a></p>
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
