"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../../components/app-sidebar";
import { apiRequest } from "../../../../../lib/api";

type DealWorkspace={
  deal:any;
  contacts:any[];
  tags:any[];
  notes:any[];
  activities:any[];
  tasks:any[];
  history:any[];
};

function money(value:string|number,currency="RUB"){
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency,maximumFractionDigits:0
  }).format(Number(value||0)/100);
}
function when(value?:string|null){
  return value?new Date(value).toLocaleString("ru-RU",{
    day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"
  }):"—";
}

export default function DealWorkspacePage({
  params
}:{params:{id:string}}){
  const [data,setData]=useState<DealWorkspace|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [note,setNote]=useState("");
  const [activityType,setActivityType]=useState("CALL");
  const [subject,setSubject]=useState("");
  const [body,setBody]=useState("");
  const [dueAt,setDueAt]=useState("");

  const load=useCallback(async()=>{
    setError("");
    try{
      setData(await apiRequest<DealWorkspace>("/crm/deals/"+params.id));
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить сделку");
    }
  },[params.id]);

  useEffect(()=>{void load();},[load]);

  const openTasks=useMemo(
    ()=>data?.tasks.filter(item=>!["DONE","CANCELLED"].includes(item.state))??[],
    [data]
  );
  const overdue=openTasks.filter(item=>item.due_at&&new Date(item.due_at)<new Date());

  async function saveNote(event:FormEvent){
    event.preventDefault();
    if(!note.trim()) return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/crm/deals/"+params.id+"/notes",{
        method:"POST",body:JSON.stringify({body:note.trim()})
      });
      setNote("");
      setNotice("Заметка добавлена.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось добавить заметку");
    }finally{setBusy(false);}
  }

  async function addActivity(event:FormEvent){
    event.preventDefault();
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/crm/deals/"+params.id+"/activities",{
        method:"POST",
        body:JSON.stringify({
          activityType,
          direction:activityType==="MESSAGE"?"INBOUND":"OUTBOUND",
          subject:subject.trim()||undefined,
          body:body.trim()||undefined,
          dueAt:activityType==="TASK"&&dueAt
            ?new Date(dueAt).toISOString()
            :undefined
        })
      });
      setSubject("");setBody("");setDueAt("");
      setNotice("Активность сохранена.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось сохранить активность");
    }finally{setBusy(false);}
  }

  async function planNextAction(){
    if(!data) return;
    const title=window.prompt(
      "Следующее действие",
      data.deal.next_action_title??"Связаться с клиентом"
    );
    if(!title?.trim()) return;
    const raw=window.prompt(
      "Когда? YYYY-MM-DD HH:MM",
      new Date(Date.now()+86400000).toISOString().slice(0,16).replace("T"," ")
    );
    if(!raw?.trim()) return;
    const date=new Date(raw.replace(" ","T"));
    if(Number.isNaN(date.getTime())){
      setError("Некорректная дата");
      return;
    }
    setBusy(true);
    try{
      await apiRequest("/crm/deals/"+params.id,{
        method:"PATCH",
        body:JSON.stringify({
          version:data.deal.version,
          nextActionTitle:title.trim(),
          nextActionAt:date.toISOString()
        })
      });
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось запланировать действие");
    }finally{setBusy(false);}
  }

  async function createProject(){
    if(!data) return;
    setBusy(true);
    try{
      const project=await apiRequest<{id:string}>(
        "/projects/from-deal/"+params.id,{method:"POST",body:"{}"}
      );
      window.location.href="/app/projects/"+project.id;
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать проект");
      setBusy(false);
    }
  }

  if(!data){
    return <main className="app-shell">
      <AppSidebar active="deals"/>
      <section className="workspace workspace-wide">
        {error?<div className="inline-error">{error}</div>:<div className="board-loading">Загружаем карточку…</div>}
      </section>
    </main>;
  }

  const d=data.deal;

  return <main className="app-shell">
    <AppSidebar active="deals"/>
    <section className="workspace workspace-wide crm-premium">
      <header className="crm-deal-hero">
        <div>
          <a className="crm-back" href="/app/crm/deals">← Воронка</a>
          <div className="crm-deal-title-row">
            <div>
              <span className="crm-kicker">{d.pipeline_name} · {d.stage_name}</span>
              <h1>{d.title}</h1>
              <p>{d.party_name??"Клиент пока не привязан"}</p>
            </div>
            <strong className="crm-deal-value">{money(d.amount_minor,d.currency)}</strong>
          </div>
        </div>
        <div className="crm-hero-actions">
          <button type="button" onClick={()=>void planNextAction()} disabled={busy}>
            Следующее действие
          </button>
          {d.stage_kind==="WON"?(
            <button className="secondary-button" type="button" onClick={()=>void createProject()} disabled={busy}>
              Создать проект
            </button>
          ):null}
        </div>
      </header>

      {error?<div className="studio-message error"><strong>Нужно проверить</strong><span>{error}</span></div>:null}
      {notice?<div className="studio-message success"><strong>Готово</strong><span>{notice}</span></div>:null}

      <div className="crm-score-grid">
        <article><span>Следующее действие</span><strong>{d.next_action_title??"Не назначено"}</strong><small>{when(d.next_action_at)}</small></article>
        <article><span>Lead score</span><strong>{d.lead_score??0}/100</strong><small>Приоритет: {d.priority??"NORMAL"}</small></article>
        <article><span>Открытые задачи</span><strong>{openTasks.length}</strong><small>{overdue.length?"Просрочено: "+overdue.length:"Просрочек нет"}</small></article>
        <article><span>Последний контакт</span><strong>{when(d.last_activity_at)}</strong><small>{data.activities[0]?.activity_type??"Активностей пока нет"}</small></article>
      </div>

      <div className="crm-workspace-grid">
        <section className="crm-main-column">
          <div className="crm-composer">
            <div className="crm-composer-tabs">
              {["CALL","EMAIL","MEETING","MESSAGE","TASK"].map(type=>(
                <button
                  key={type}
                  type="button"
                  className={activityType===type?"active":""}
                  onClick={()=>setActivityType(type)}
                >
                  {type==="CALL"?"Звонок":type==="EMAIL"?"Письмо":type==="MEETING"?"Встреча":type==="MESSAGE"?"Сообщение":"Задача"}
                </button>
              ))}
            </div>
            <form onSubmit={addActivity}>
              <input value={subject} onChange={e=>setSubject(e.target.value)} placeholder="Коротко: о чём договорились"/>
              <textarea value={body} onChange={e=>setBody(e.target.value)} placeholder="Комментарий, результат разговора, важные детали"/>
              {activityType==="TASK"?(
                <label><span>Срок</span><input type="datetime-local" value={dueAt} onChange={e=>setDueAt(e.target.value)}/></label>
              ):null}
              <div className="crm-composer-actions">
                <span>История сохраняется в карточке сделки</span>
                <button type="submit" disabled={busy}>Сохранить</button>
              </div>
            </form>
          </div>

          <section className="crm-timeline">
            <div className="crm-section-head">
              <div><span>Единая история</span><h2>Таймлайн</h2></div>
            </div>
            {data.activities.map(item=>(
              <article className="crm-timeline-item" key={item.id}>
                <div className="crm-timeline-dot"/>
                <div>
                  <header>
                    <strong>{item.subject||item.activity_type}</strong>
                    <time>{when(item.happened_at)}</time>
                  </header>
                  {item.body?<p>{item.body}</p>:null}
                  {item.due_at?<small>Срок: {when(item.due_at)}</small>:null}
                </div>
              </article>
            ))}
            {!data.activities.length?<div className="studio-empty"><strong>История пока пустая</strong><p>Зафиксируйте звонок, письмо, встречу или следующую задачу.</p></div>:null}
          </section>
        </section>

        <aside className="crm-side-column">
          <section className="crm-side-card">
            <span className="crm-kicker">Контакты</span>
            <h3>{d.party_name??"Без клиента"}</h3>
            {data.contacts.map(contact=>(
              <a key={contact.id} href={contact.type==="EMAIL"?"mailto:"+contact.value:contact.type==="PHONE"?"tel:"+contact.value:"#"}>
                <span>{contact.label||contact.type}</span><strong>{contact.value}</strong>
              </a>
            ))}
            {!data.contacts.length?<p className="muted">Контакты ещё не заполнены.</p>:null}
          </section>

          <section className="crm-side-card">
            <div className="crm-side-card-head"><div><span className="crm-kicker">Задачи</span><h3>Что дальше</h3></div><b>{openTasks.length}</b></div>
            {openTasks.slice(0,8).map(task=>(
              <div className={"crm-task-row "+(task.due_at&&new Date(task.due_at)<new Date()?"is-overdue":"")} key={task.id}>
                <strong>{task.title}</strong><span>{when(task.due_at)}</span>
              </div>
            ))}
            {!openTasks.length?<p className="muted">Открытых задач нет.</p>:null}
          </section>

          <section className="crm-side-card">
            <span className="crm-kicker">Заметки</span>
            <form onSubmit={saveNote}>
              <textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Контекст, который нельзя потерять"/>
              <button type="submit" disabled={busy||!note.trim()}>Добавить заметку</button>
            </form>
            <div className="crm-note-list">
              {data.notes.slice(0,6).map(item=>(
                <div key={item.id}><p>{item.body}</p><small>{when(item.created_at)}</small></div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  </main>;
}
