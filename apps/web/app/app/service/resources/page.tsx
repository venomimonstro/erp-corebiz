"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { StudioModal } from "../../../../components/studio-modal";
import { apiRequest } from "../../../../lib/api";

type Zone={
  id:string;
  resource_id:string;
  name:string;
  code:string|null;
  capacity_units:number;
};

type Resource={
  id:string;
  branch_id:string|null;
  branch_name:string|null;
  membership_id:string|null;
  type:string;
  name:string;
  code:string|null;
  capacity:number;
  cost_per_hour_minor:string;
  currency:string;
  timezone:string;
  skills:Array<{id:string;code:string;name:string;level:number}>;
};

const RESOURCE_TYPES=[
  ["EMPLOYEE","Сотрудник / мастер"],
  ["WORKPLACE","Рабочее место / кресло / стол"],
  ["ROOM","Кабинет"],
  ["HALL","Зал"],
  ["EQUIPMENT","Оборудование"],
  ["VEHICLE","Транспорт"],
  ["MACHINE","Станок"],
  ["OTHER","Другой ресурс"]
] as const;

const WEEKDAYS=[
  [1,"Пн"],[2,"Вт"],[3,"Ср"],[4,"Чт"],[5,"Пт"],[6,"Сб"],[7,"Вс"]
] as const;

function money(value:string,currency:string){
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency,maximumFractionDigits:0
  }).format(Number(value)/100);
}

function resourceLabel(type:string){
  return RESOURCE_TYPES.find(([code])=>code===type)?.[1]??type;
}

export default function ResourcesPage(){
  const [resources,setResources]=useState<Resource[]>([]);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pending,setPending]=useState(false);

  const [zoneResource,setZoneResource]=useState<Resource|null>(null);
  const [zones,setZones]=useState<Zone[]>([]);
  const [zoneName,setZoneName]=useState("");
  const [zoneCapacity,setZoneCapacity]=useState("1");

  const [showCreate,setShowCreate]=useState(false);
  const [resourceName,setResourceName]=useState("");
  const [resourceType,setResourceType]=useState("EMPLOYEE");
  const [resourceCapacity,setResourceCapacity]=useState("1");
  const [resourceCost,setResourceCost]=useState("0");

  const [scheduleResource,setScheduleResource]=useState<Resource|null>(null);
  const [scheduleDays,setScheduleDays]=useState<number[]>([1,2,3,4,5]);
  const [scheduleStart,setScheduleStart]=useState("09:00");
  const [scheduleEnd,setScheduleEnd]=useState("21:00");

  const [blockResource,setBlockResource]=useState<Resource|null>(null);
  const [blockZones,setBlockZones]=useState<Zone[]>([]);
  const [blockZone,setBlockZone]=useState("");
  const [blockCapacity,setBlockCapacity]=useState("");
  const [blockStart,setBlockStart]=useState("");
  const [blockEnd,setBlockEnd]=useState("");
  const [blockReason,setBlockReason]=useState("");

  const load=useCallback(async()=>{
    setError("");
    try{
      setResources(await apiRequest<Resource[]>("/service/resources"));
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось загрузить ресурсы"
      );
    }
  },[]);

  useEffect(()=>{void load();},[load]);

  const employees=useMemo(
    ()=>resources.filter(item=>item.type==="EMPLOYEE"),
    [resources]
  );
  const spaces=useMemo(
    ()=>resources.filter(item=>
      ["ROOM","HALL","WORKPLACE","EQUIPMENT"].includes(item.type)
    ),
    [resources]
  );

  async function openZones(resource:Resource){
    setZoneResource(resource);
    setZoneName("");
    setZoneCapacity("1");
    setError("");
    try{
      setZones(
        await apiRequest<Zone[]>("/service/resources/"+resource.id+"/zones")
      );
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось загрузить зоны"
      );
    }
  }

  async function createZone(){
    if(!zoneResource) return;
    const name=zoneName.trim();
    const capacity=Number(zoneCapacity);
    if(!name){
      setError("Укажите название зоны");
      return;
    }
    if(
      !Number.isSafeInteger(capacity)||
      capacity<1||
      capacity>zoneResource.capacity
    ){
      setError("Проверьте вместимость зоны");
      return;
    }
    setPending(true);
    setError("");
    try{
      await apiRequest("/service/resources/"+zoneResource.id+"/zones",{
        method:"POST",
        body:JSON.stringify({name,capacityUnits:capacity})
      });
      setZones(
        await apiRequest<Zone[]>("/service/resources/"+zoneResource.id+"/zones")
      );
      setZoneName("");
      setZoneCapacity("1");
      setNotice("Зона добавлена. Её можно бронировать и блокировать независимо.");
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось создать зону"
      );
    }finally{
      setPending(false);
    }
  }

  function openCreate(){
    setResourceName("");
    setResourceType("EMPLOYEE");
    setResourceCapacity("1");
    setResourceCost("0");
    setShowCreate(true);
  }

  async function createResource(event:FormEvent){
    event.preventDefault();
    setError("");
    const capacity=Number(resourceCapacity);
    const cost=Number(resourceCost.replace(",","."));
    if(!resourceName.trim()){
      setError("Укажите название");
      return;
    }
    if(
      !Number.isSafeInteger(capacity)||capacity<1||capacity>100000||
      !Number.isFinite(cost)||cost<0
    ){
      setError("Проверьте вместимость и себестоимость часа");
      return;
    }
    setPending(true);
    try{
      await apiRequest("/service/resources",{
        method:"POST",
        body:JSON.stringify({
          name:resourceName.trim(),
          type:resourceType,
          capacity,
          costPerHourMinor:String(Math.round(cost*100))
        })
      });
      setShowCreate(false);
      setNotice("Ресурс создан. Теперь задайте график и услуги.");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось создать ресурс"
      );
    }finally{
      setPending(false);
    }
  }

  function openSchedule(resource:Resource){
    setScheduleResource(resource);
    setScheduleDays([1,2,3,4,5]);
    setScheduleStart("09:00");
    setScheduleEnd("21:00");
  }

  function toggleScheduleDay(day:number){
    setScheduleDays(current=>
      current.includes(day)
        ?current.filter(item=>item!==day)
        :[...current,day].sort((a,b)=>a-b)
    );
  }

  async function saveSchedule(event:FormEvent){
    event.preventDefault();
    if(!scheduleResource) return;
    setError("");
    if(!scheduleDays.length){
      setError("Выберите хотя бы один рабочий день");
      return;
    }
    const [sh,sm]=scheduleStart.split(":").map(Number);
    const [eh,em]=scheduleEnd.split(":").map(Number);
    const startMinute=sh*60+sm;
    const endMinute=eh*60+em;
    if(
      !Number.isFinite(startMinute)||!Number.isFinite(endMinute)||
      endMinute<=startMinute
    ){
      setError("Проверьте рабочее время");
      return;
    }
    setPending(true);
    try{
      await apiRequest(
        "/service/resources/"+scheduleResource.id+"/schedule",
        {
          method:"PUT",
          body:JSON.stringify({
            windows:scheduleDays.map(weekday=>({
              weekday,startMinute,endMinute
            }))
          })
        }
      );
      setScheduleResource(null);
      setNotice("Рабочий график сохранён.");
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось сохранить график"
      );
    }finally{
      setPending(false);
    }
  }

  async function openBlock(resource:Resource){
    setBlockResource(resource);
    setBlockZone("");
    setBlockCapacity("");
    setBlockReason("");
    const now=new Date();
    const later=new Date(now.getTime()+60*60*1000);
    const local=(date:Date)=>{
      const shifted=new Date(date.getTime()-date.getTimezoneOffset()*60000);
      return shifted.toISOString().slice(0,16);
    };
    setBlockStart(local(now));
    setBlockEnd(local(later));
    if(["ROOM","HALL","WORKPLACE","EQUIPMENT"].includes(resource.type)){
      try{
        setBlockZones(
          await apiRequest<Zone[]>("/service/resources/"+resource.id+"/zones")
        );
      }catch{
        setBlockZones([]);
      }
    }else{
      setBlockZones([]);
    }
  }

  async function saveBlock(event:FormEvent){
    event.preventDefault();
    if(!blockResource) return;
    setError("");
    const capacity=blockCapacity.trim()?Number(blockCapacity):null;
    if(
      capacity!==null&&
      (!Number.isSafeInteger(capacity)||capacity<1||capacity>blockResource.capacity)
    ){
      setError("Проверьте блокируемую вместимость");
      return;
    }
    if(!blockStart||!blockEnd||new Date(blockEnd)<=new Date(blockStart)){
      setError("Проверьте период недоступности");
      return;
    }
    setPending(true);
    try{
      await apiRequest("/service/resources/"+blockResource.id+"/blocks",{
        method:"POST",
        body:JSON.stringify({
          startsAt:blockStart,
          endsAt:blockEnd,
          type:"UNAVAILABLE",
          reason:blockReason.trim()||"Ручная блокировка",
          zoneId:blockZone||undefined,
          capacityUnits:capacity??undefined
        })
      });
      setBlockResource(null);
      setNotice(
        capacity===null
          ?"Ресурс полностью закрыт на выбранный период."
          :"Часть вместимости закрыта, остальное пространство доступно для записи."
      );
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось добавить недоступность"
      );
    }finally{
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="resources" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero">
          <div>
            <span className="studio-eyebrow">Команда и мощности</span>
            <h1>Люди и пространство</h1>
            <p>
              Мастера, кресла, столы, кабинеты, залы и оборудование в одном
              расписании. Каждый ресурс знает график, вместимость и себестоимость.
            </p>
          </div>
          <div className="studio-hero-actions">
            <a className="secondary-button" href="/app/service/setup">
              Настроить услуги
            </a>
            <button type="button" onClick={openCreate}>+ Ресурс</button>
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
            <span>Команда</span>
            <strong>{employees.length}</strong>
            <p>Сотрудники, доступные для услуг и записи.</p>
          </article>
          <article>
            <span>Пространство</span>
            <strong>{spaces.length}</strong>
            <p>Кресла, столы, кабинеты, залы и оборудование.</p>
          </article>
          <article>
            <span>Суммарная вместимость</span>
            <strong>
              {spaces.reduce((sum,item)=>sum+Number(item.capacity||0),0)}
            </strong>
            <p>Условные единицы для совместного использования.</p>
          </article>
          <article>
            <span>Экономика</span>
            <strong>Авто</strong>
            <p>Стоимость ресурсов попадёт в маржу завершённых визитов.</p>
          </article>
        </div>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Рабочая карта</span>
              <h2>Ресурсы бизнеса</h2>
              <p>
                Вместимость 1 означает эксклюзивное использование. Большой зал
                можно задать как 100 единиц и делить между несколькими записями.
              </p>
            </div>
            <button className="secondary-button" type="button" onClick={openCreate}>
              Добавить
            </button>
          </div>

          <div className="resource-grid">
            {resources.map(resource=>(
              <article className="resource-card" key={resource.id}>
                <header>
                  <div>
                    <span>{resourceLabel(resource.type)}</span>
                    <h2>{resource.name}</h2>
                  </div>
                  <span className="status-pill">
                    {resource.type==="EMPLOYEE"
                      ?"исполнитель"
                      :"вместимость "+resource.capacity}
                  </span>
                </header>

                <dl>
                  <div>
                    <dt>Филиал</dt>
                    <dd>{resource.branch_name??"Общий"}</dd>
                  </div>
                  <div>
                    <dt>Себестоимость часа</dt>
                    <dd>{money(resource.cost_per_hour_minor,resource.currency)}</dd>
                  </div>
                  <div>
                    <dt>Навыки</dt>
                    <dd>
                      {resource.skills.length
                        ?resource.skills.map(skill=>skill.name).join(", ")
                        :"Настраиваются через услуги"}
                    </dd>
                  </div>
                </dl>

                <div className="header-actions">
                  {["ROOM","HALL","WORKPLACE","EQUIPMENT"].includes(resource.type)?(
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={()=>void openZones(resource)}
                    >
                      Зоны
                    </button>
                  ):null}
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={()=>openSchedule(resource)}
                  >
                    График
                  </button>
                  <button type="button" onClick={()=>void openBlock(resource)}>
                    Недоступность
                  </button>
                </div>
              </article>
            ))}

            {!resources.length?(
              <div className="studio-empty">
                <span>01</span>
                <strong>Добавьте первый ресурс</strong>
                <p>
                  Для салона начните с мастеров и рабочих мест.
                  Для студии — с тренеров и залов.
                </p>
                <button type="button" onClick={openCreate}>Создать ресурс</button>
              </div>
            ):null}
          </div>
        </section>

        {showCreate?(
          <StudioModal
            eyebrow="Новый ресурс"
            title="Что работает в расписании"
            description="Добавьте человека или физический ресурс. Названия можно делать привычными бизнесу: «Кресло 1», «Стол 3», «Кабинет косметологии»."
            onClose={()=>setShowCreate(false)}
          >
            <form className="studio-modal-form" onSubmit={createResource}>
              <label>
                <span>Название</span>
                <input
                  autoFocus
                  value={resourceName}
                  onChange={event=>setResourceName(event.target.value)}
                  placeholder="Например, Анна или Кресло 1"
                  required
                />
              </label>
              <label>
                <span>Тип</span>
                <select
                  value={resourceType}
                  onChange={event=>setResourceType(event.target.value)}
                >
                  {RESOURCE_TYPES.map(([code,label])=>(
                    <option key={code} value={code}>{label}</option>
                  ))}
                </select>
              </label>
              <div className="studio-form-grid">
                <label>
                  <span>Вместимость</span>
                  <input
                    type="number"
                    min="1"
                    max="100000"
                    value={resourceCapacity}
                    onChange={event=>setResourceCapacity(event.target.value)}
                  />
                  <small>
                    Для сотрудника обычно 1. Для большого пространства можно 100.
                  </small>
                </label>
                <label>
                  <span>Себестоимость часа, ₽</span>
                  <input
                    inputMode="decimal"
                    value={resourceCost}
                    onChange={event=>setResourceCost(event.target.value)}
                    placeholder="0"
                  />
                  <small>Аренда или эксплуатационная стоимость.</small>
                </label>
              </div>
              <div className="studio-drawer-actions">
                <button className="secondary-button" type="button" onClick={()=>setShowCreate(false)}>Отмена</button>
                <button disabled={pending} type="submit">{pending?"Создаём…":"Создать"}</button>
              </div>
            </form>
          </StudioModal>
        ):null}

        {scheduleResource?(
          <StudioModal
            eyebrow="Рабочее время"
            title={"График · "+scheduleResource.name}
            description="Выберите рабочие дни и окно доступности для онлайн-записи."
            onClose={()=>setScheduleResource(null)}
          >
            <form className="studio-modal-form" onSubmit={saveSchedule}>
              <fieldset className="studio-weekdays">
                <legend>Рабочие дни</legend>
                {WEEKDAYS.map(([day,label])=>(
                  <button
                    className={scheduleDays.includes(day)?"active":""}
                    key={day}
                    type="button"
                    onClick={()=>toggleScheduleDay(day)}
                  >
                    {label}
                  </button>
                ))}
              </fieldset>
              <div className="studio-form-grid">
                <label>
                  <span>Начало</span>
                  <input type="time" value={scheduleStart} onChange={event=>setScheduleStart(event.target.value)} />
                </label>
                <label>
                  <span>Конец</span>
                  <input type="time" value={scheduleEnd} onChange={event=>setScheduleEnd(event.target.value)} />
                </label>
              </div>
              <div className="studio-drawer-actions">
                <button className="secondary-button" type="button" onClick={()=>setScheduleResource(null)}>Отмена</button>
                <button disabled={pending} type="submit">{pending?"Сохраняем…":"Сохранить график"}</button>
              </div>
            </form>
          </StudioModal>
        ):null}

        {blockResource?(
          <StudioModal
            eyebrow="Недоступность"
            title={"Закрыть время · "+blockResource.name}
            description="Можно закрыть весь ресурс или только часть вместимости / конкретную зону."
            onClose={()=>setBlockResource(null)}
          >
            <form className="studio-modal-form" onSubmit={saveBlock}>
              <div className="studio-form-grid">
                <label>
                  <span>С</span>
                  <input type="datetime-local" value={blockStart} onChange={event=>setBlockStart(event.target.value)} required />
                </label>
                <label>
                  <span>До</span>
                  <input type="datetime-local" value={blockEnd} onChange={event=>setBlockEnd(event.target.value)} required />
                </label>
              </div>
              {blockZones.length?(
                <label>
                  <span>Зона</span>
                  <select value={blockZone} onChange={event=>setBlockZone(event.target.value)}>
                    <option value="">Весь ресурс / без зоны</option>
                    {blockZones.map(zone=>(
                      <option key={zone.id} value={zone.id}>
                        {zone.name} · {zone.capacity_units} ед.
                      </option>
                    ))}
                  </select>
                </label>
              ):null}
              {blockResource.type!=="EMPLOYEE"?(
                <label>
                  <span>Блокировать только часть вместимости</span>
                  <input
                    type="number"
                    min="1"
                    max={
                      blockZone
                        ?blockZones.find(zone=>zone.id===blockZone)?.capacity_units
                        :blockResource.capacity
                    }
                    value={blockCapacity}
                    onChange={event=>setBlockCapacity(event.target.value)}
                    placeholder="Пусто = закрыть полностью"
                  />
                  <small>
                    Например, закрыть 30 из 100 единиц зала, оставив 70 доступными.
                  </small>
                </label>
              ):null}
              <label>
                <span>Причина</span>
                <input
                  value={blockReason}
                  onChange={event=>setBlockReason(event.target.value)}
                  placeholder="Отпуск, ремонт, аренда секции…"
                />
              </label>
              <div className="studio-drawer-actions">
                <button className="secondary-button" type="button" onClick={()=>setBlockResource(null)}>Отмена</button>
                <button disabled={pending} type="submit">{pending?"Сохраняем…":"Закрыть время"}</button>
              </div>
            </form>
          </StudioModal>
        ):null}

        {zoneResource?(
          <StudioModal
            eyebrow="Совместное использование"
            title={"Зоны · "+zoneResource.name}
            description="Разделите пространство на физические зоны или условные доли. Сумма активных зон не превысит общую вместимость."
            onClose={()=>setZoneResource(null)}
          >
            <div className="studio-form-section">
              <header>
                <strong>Текущая структура</strong>
                <span>Вместимость ресурса: {zoneResource.capacity}</span>
              </header>
              <div className="studio-zone-list">
                {zones.map(zone=>(
                  <article key={zone.id}>
                    <div>
                      <strong>{zone.name}</strong>
                      <span>{zone.capacity_units} единиц</span>
                    </div>
                    <b>
                      {Math.round(zone.capacity_units/zoneResource.capacity*100)}%
                    </b>
                  </article>
                ))}
                {!zones.length?(
                  <div className="studio-zone-empty">
                    <strong>Зон пока нет</strong>
                    <span>Например: «Левая часть», «Кресла 1–3», «Секция B».</span>
                  </div>
                ):null}
              </div>
            </div>
            <div className="studio-divider" />
            <div className="studio-form-section">
              <header>
                <strong>Добавить зону</strong>
                <span>После создания она появится в записи и блокировках.</span>
              </header>
              <div className="studio-form-grid">
                <label>
                  <span>Название</span>
                  <input value={zoneName} onChange={event=>setZoneName(event.target.value)} placeholder="Секция A" />
                </label>
                <label>
                  <span>Вместимость</span>
                  <input type="number" min="1" max={zoneResource.capacity} value={zoneCapacity} onChange={event=>setZoneCapacity(event.target.value)} />
                </label>
              </div>
              <button disabled={pending} type="button" onClick={()=>void createZone()}>
                {pending?"Добавляем…":"Добавить зону"}
              </button>
            </div>
          </StudioModal>
        ):null}
      </section>
    </main>
  );
}
