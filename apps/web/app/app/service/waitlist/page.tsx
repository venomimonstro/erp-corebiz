"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { StudioModal } from "../../../../components/studio-modal";
import { apiRequest } from "../../../../lib/api";

type Customer={
  id:string;
  displayName:string;
  phone:string|null;
  email:string|null;
};

type Service={
  id:string;
  name:string;
  delivery_format:"INDIVIDUAL"|"GROUP"|"SELF_PRACTICE"|"RENTAL";
};

type Resource={
  id:string;
  name:string;
  type:string;
};

type OfferedResource={
  resourceId:string;
  resourceName:string;
  type:string;
  capacityUnits:number;
  zoneId:string|null;
};

type Waitlist={
  id:string;
  party_id:string;
  party_name:string;
  service_id:string;
  service_name:string;
  preferred_employee_resource_id:string|null;
  preferred_employee_name:string|null;
  branch_name:string|null;
  desired_from:string;
  desired_to:string;
  min_notice_minutes:number;
  status:"WAITING"|"OFFERED"|"BOOKED"|"CANCELLED"|"EXPIRED";
  offered_starts_at:string|null;
  offer_expires_at:string|null;
  notes:string|null;
  offered_resources:OfferedResource[];
};

function dateLabel(value:string){
  return new Date(value).toLocaleString("ru-RU",{
    day:"2-digit",
    month:"short",
    hour:"2-digit",
    minute:"2-digit"
  });
}

export default function ServiceWaitlistPage(){
  const [entries,setEntries]=useState<Waitlist[]>([]);
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [services,setServices]=useState<Service[]>([]);
  const [resources,setResources]=useState<Resource[]>([]);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pending,setPending]=useState(false);
  const [showCreate,setShowCreate]=useState(false);
  const [filter,setFilter]=useState("ACTIVE");

  const [partyId,setPartyId]=useState("");
  const [serviceId,setServiceId]=useState("");
  const [employeeId,setEmployeeId]=useState("");
  const [desiredFrom,setDesiredFrom]=useState("");
  const [desiredTo,setDesiredTo]=useState("");
  const [noticeMinutes,setNoticeMinutes]=useState("60");
  const [notes,setNotes]=useState("");

  const load=useCallback(async()=>{
    setError("");
    try{
      const [waitlistRows,customerRows,serviceRows,resourceRows]=await Promise.all([
        apiRequest<Waitlist[]>("/service/waitlist?status=ALL"),
        apiRequest<Customer[]>("/crm/customers"),
        apiRequest<Service[]>("/service/catalog"),
        apiRequest<Resource[]>("/service/resources")
      ]);
      setEntries(waitlistRows);
      setCustomers(customerRows);
      setServices(serviceRows);
      setResources(resourceRows);
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось загрузить лист ожидания"
      );
    }
  },[]);

  useEffect(()=>{void load();},[load]);

  const employees=useMemo(
    ()=>resources.filter(item=>item.type==="EMPLOYEE"),
    [resources]
  );

  const visible=useMemo(()=>{
    if(filter==="ACTIVE"){
      return entries.filter(item=>["WAITING","OFFERED"].includes(item.status));
    }
    if(filter==="OFFERED"){
      return entries.filter(item=>item.status==="OFFERED");
    }
    return entries;
  },[entries,filter]);

  function openCreate(){
    const now=new Date();
    const next=new Date(now.getTime()+7*86400000);
    const local=(date:Date)=>{
      const shifted=new Date(date.getTime()-date.getTimezoneOffset()*60000);
      return shifted.toISOString().slice(0,16);
    };
    setPartyId("");
    setServiceId("");
    setEmployeeId("");
    setDesiredFrom(local(now));
    setDesiredTo(local(next));
    setNoticeMinutes("60");
    setNotes("");
    setShowCreate(true);
  }

  async function create(event:FormEvent){
    event.preventDefault();
    const minNotice=Number(noticeMinutes);
    if(!partyId||!serviceId){
      setError("Выберите клиента и услугу");
      return;
    }
    if(
      !Number.isSafeInteger(minNotice)||
      minNotice<0||
      minNotice>43200
    ){
      setError("Проверьте минимальное время предупреждения");
      return;
    }
    setPending(true);
    setError("");
    try{
      await apiRequest("/service/waitlist",{
        method:"POST",
        body:JSON.stringify({
          partyId,
          serviceId,
          preferredEmployeeResourceId:employeeId||undefined,
          desiredFrom:new Date(desiredFrom).toISOString(),
          desiredTo:new Date(desiredTo).toISOString(),
          minNoticeMinutes:minNotice,
          notes:notes.trim()||undefined
        })
      });
      setShowCreate(false);
      setNotice(
        "Клиент добавлен. При подходящей отмене CoreBiz автоматически предложит освободившееся окно."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось добавить клиента"
      );
    }finally{
      setPending(false);
    }
  }

  async function cancel(entry:Waitlist){
    setPending(true);
    setError("");
    try{
      await apiRequest("/service/waitlist/"+entry.id+"/cancel",{
        method:"POST",
        body:"{}"
      });
      setNotice("Ожидание отменено.");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось отменить ожидание"
      );
    }finally{
      setPending(false);
    }
  }

  async function bookOffer(entry:Waitlist){
    if(
      entry.status!=="OFFERED"||
      !entry.offered_starts_at||
      !entry.offered_resources.length
    ){
      setError("Предложенный слот уже недоступен");
      return;
    }
    setPending(true);
    setError("");
    try{
      await apiRequest("/service/bookings",{
        method:"POST",
        body:JSON.stringify({
          serviceId:entry.service_id,
          resources:entry.offered_resources.map(item=>({
            resourceId:item.resourceId,
            capacityUnits:item.capacityUnits,
            zoneId:item.zoneId||undefined
          })),
          startsAt:new Date(entry.offered_starts_at).toISOString(),
          partyId:entry.party_id,
          waitlistId:entry.id,
          source:"MANUAL",
          idempotencyKey:"waitlist:"+entry.id
        })
      });
      setNotice(
        "Клиент записан в освободившееся окно. Лист ожидания закрыт автоматически."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось занять предложенный слот"
      );
    }finally{
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="service-waitlist" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero">
          <div>
            <span className="studio-eyebrow">Заполняем отмены</span>
            <h1>Лист ожидания</h1>
            <p>
              Клиент указывает удобное окно и мастера. Если подходящая запись
              отменяется, CoreBiz резервирует предложение для первого кандидата.
            </p>
          </div>
          <div className="studio-hero-actions">
            <a className="secondary-button" href="/app/service/bookings">
              Календарь
            </a>
            <button type="button" onClick={openCreate}>+ Добавить клиента</button>
          </div>
        </header>

        {error?(
          <div className="studio-message error">
            <strong>Нужно проверить</strong><span>{error}</span>
          </div>
        ):null}
        {notice?(
          <div className="studio-message success">
            <strong>Готово</strong><span>{notice}</span>
          </div>
        ):null}

        <div className="studio-score-grid">
          <article>
            <span>Ждут</span>
            <strong>{entries.filter(item=>item.status==="WAITING").length}</strong>
            <p>Клиенты, для которых пока нет подходящего окна.</p>
          </article>
          <article>
            <span>Слот предложен</span>
            <strong>{entries.filter(item=>item.status==="OFFERED").length}</strong>
            <p>Короткий приоритет до истечения предложения.</p>
          </article>
          <article>
            <span>Записаны</span>
            <strong>{entries.filter(item=>item.status==="BOOKED").length}</strong>
            <p>Освободившиеся окна, которые удалось вернуть в выручку.</p>
          </article>
          <article>
            <span>Принцип</span>
            <strong>FIFO</strong>
            <p>Сначала самый ранний подходящий запрос, с приоритетом нужного мастера.</p>
          </article>
        </div>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Очередь</span>
              <h2>Кого можно записать раньше</h2>
              <p>
                Предложение не создаёт запись само: администратор подтверждает
                клиента одним действием, а сервер ещё раз проверяет вместимость.
              </p>
            </div>
            <div className="studio-hero-actions">
              <button
                className={filter==="ACTIVE"?"":"secondary-button"}
                type="button"
                onClick={()=>setFilter("ACTIVE")}
              >
                Активные
              </button>
              <button
                className={filter==="OFFERED"?"":"secondary-button"}
                type="button"
                onClick={()=>setFilter("OFFERED")}
              >
                Предложены
              </button>
              <button
                className={filter==="ALL"?"":"secondary-button"}
                type="button"
                onClick={()=>setFilter("ALL")}
              >
                Все
              </button>
            </div>
          </div>

          <div className="studio-rule-grid">
            {visible.map(entry=>(
              <article className="studio-rule-card" key={entry.id}>
                <header>
                  <div>
                    <span className="studio-chip">{entry.status}</span>
                    <h3>{entry.party_name}</h3>
                    <p>
                      {entry.service_name}
                      {entry.preferred_employee_name
                        ?" · "+entry.preferred_employee_name
                        :""}
                    </p>
                  </div>
                  <strong>
                    {entry.status==="OFFERED"&&entry.offered_starts_at
                      ?new Date(entry.offered_starts_at).toLocaleTimeString(
                        "ru-RU",{hour:"2-digit",minute:"2-digit"}
                      )
                      :"…"}
                  </strong>
                </header>
                <div className="studio-rule-meta">
                  <div>
                    <span>Окно</span>
                    <b>{dateLabel(entry.desired_from)} → {dateLabel(entry.desired_to)}</b>
                  </div>
                  <div>
                    <span>Предупредить</span>
                    <b>за {entry.min_notice_minutes} мин</b>
                  </div>
                  <div>
                    <span>Освободился ресурс</span>
                    <b>
                      {entry.offered_resources.length
                        ?entry.offered_resources.map(item=>item.resourceName).join(", ")
                        :"—"}
                    </b>
                  </div>
                </div>
                {entry.notes?<p>{entry.notes}</p>:null}
                <footer>
                  <span>
                    {entry.offer_expires_at
                      ?"Предложение до "+dateLabel(entry.offer_expires_at)
                      :"Ждём подходящее освобождение"}
                  </span>
                  <div className="studio-hero-actions">
                    {entry.status==="OFFERED"?(
                      <button
                        disabled={pending}
                        type="button"
                        onClick={()=>void bookOffer(entry)}
                      >
                        Записать
                      </button>
                    ):null}
                    {["WAITING","OFFERED"].includes(entry.status)?(
                      <button
                        className="studio-text-button"
                        disabled={pending}
                        type="button"
                        onClick={()=>void cancel(entry)}
                      >
                        Убрать
                      </button>
                    ):null}
                  </div>
                </footer>
              </article>
            ))}
            {!visible.length?(
              <div className="studio-empty">
                <span>01</span>
                <strong>Очередь пуста</strong>
                <p>
                  Добавляйте клиентов, которые готовы прийти раньше при отмене.
                </p>
              </div>
            ):null}
          </div>
        </section>

        {showCreate?(
          <StudioModal
            eyebrow="Новое ожидание"
            title="Когда клиент готов прийти"
            description="Можно выбрать конкретного мастера или оставить любого. Чем шире окно, тем выше шанс заполнить отмену."
            onClose={()=>setShowCreate(false)}
          >
            <form className="studio-modal-form" onSubmit={create}>
              <label>
                <span>Клиент</span>
                <select required value={partyId} onChange={event=>setPartyId(event.target.value)}>
                  <option value="">Выберите клиента</option>
                  {customers.map(item=>(
                    <option key={item.id} value={item.id}>
                      {item.displayName}{item.phone?" · "+item.phone:""}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Услуга</span>
                <select required value={serviceId} onChange={event=>setServiceId(event.target.value)}>
                  <option value="">Выберите услугу</option>
                  {services.map(item=>(
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Предпочитаемый мастер</span>
                <select value={employeeId} onChange={event=>setEmployeeId(event.target.value)}>
                  <option value="">Любой подходящий</option>
                  {employees.map(item=>(
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <div className="studio-form-grid">
                <label>
                  <span>Не раньше</span>
                  <input type="datetime-local" required value={desiredFrom} onChange={event=>setDesiredFrom(event.target.value)} />
                </label>
                <label>
                  <span>Не позже</span>
                  <input type="datetime-local" required value={desiredTo} onChange={event=>setDesiredTo(event.target.value)} />
                </label>
              </div>
              <label>
                <span>Минимум времени на дорогу, мин</span>
                <input type="number" min="0" max="43200" value={noticeMinutes} onChange={event=>setNoticeMinutes(event.target.value)} />
              </label>
              <label>
                <span>Комментарий</span>
                <textarea value={notes} onChange={event=>setNotes(event.target.value)} placeholder="Например, только после 18:00, готов приехать быстро" />
              </label>
              <div className="studio-drawer-actions">
                <button className="secondary-button" type="button" onClick={()=>setShowCreate(false)}>Отмена</button>
                <button disabled={pending} type="submit">{pending?"Добавляем…":"Добавить в ожидание"}</button>
              </div>
            </form>
          </StudioModal>
        ):null}
      </section>
    </main>
  );
}
