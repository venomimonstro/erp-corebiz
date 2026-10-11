"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { DanceWorkspaceNav } from "../../../../components/dance-workspace-nav";
import { apiRequest } from "../../../../lib/api";

type Service = {
  id:string;
  name:string;
  category:string|null;
  duration_minutes:number;
  price_minor:string;
  currency:string;
  delivery_format:"INDIVIDUAL"|"GROUP"|"SELF_PRACTICE"|"RENTAL";
  group_capacity:number;
};

type Resource = {
  id:string;
  name:string;
  type:string;
  capacity:number;
  timezone:string;
  branch_name:string|null;
};

type DeliveryRule = {
  id:string;
  service_id:string;
  service_name:string;
  employee_resource_id:string|null;
  employee_name:string|null;
  branch_name:string|null;
  delivery_format:"INDIVIDUAL"|"GROUP"|"SELF_PRACTICE"|"RENTAL";
  price_minor:string|null;
  price_max_minor:string|null;
  duration_minutes:number|null;
  capacity_units:number;
  technology_card_id:string|null;
  technology_card_name:string|null;
  weekdays:number[];
  start_minute:number;
  end_minute:number;
  priority:number;
};

type Zone = {
  id:string;
  resource_id:string;
  name:string;
  code:string|null;
  capacity_units:number;
};

type TechnologyCard = {
  id:string;
  name:string;
  code:string|null;
  description:string|null;
  lines:Array<unknown>;
};

type Warehouse = {
  id:string;
  name:string;
  code:string;
};

type Product = {
  productId:string;
  productName:string;
  kind:"STOCKABLE"|"NON_STOCK";
  skuId:string;
  sku:string;
  trackInventory:boolean;
};

type CardLineDraft = {
  warehouseId:string;
  skuId:string;
  quantity:string;
  wastePercent:string;
};

const DAY_LABELS = [
  ["1","Пн"],["2","Вт"],["3","Ср"],["4","Чт"],
  ["5","Пт"],["6","Сб"],["7","Вс"]
] as const;

function money(value:string|null|undefined,currency="RUB"){
  if(value==null) return "по базовой цене";
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency,maximumFractionDigits:0
  }).format(Number(value)/100);
}

function minutesLabel(value:number){
  const h=Math.floor(value/60);
  const m=value%60;
  return h ? h+" ч"+(m?" "+m+" мин":"") : m+" мин";
}

function timeLabel(value:number){
  const h=String(Math.floor(value/60)).padStart(2,"0");
  const m=String(value%60).padStart(2,"0");
  return h+":"+m;
}

function rubToMinor(value:string){
  const parsed=Number(value.replace(",","."));
  return Number.isFinite(parsed)&&parsed>=0 ? String(Math.round(parsed*100)) : null;
}

export default function DanceSetupPage(){
  const [services,setServices]=useState<Service[]>([]);
  const [resources,setResources]=useState<Resource[]>([]);
  const [rules,setRules]=useState<DeliveryRule[]>([]);
  const [cards,setCards]=useState<TechnologyCard[]>([]);
  const [warehouses,setWarehouses]=useState<Warehouse[]>([]);
  const [products,setProducts]=useState<Product[]>([]);
  const [zones,setZones]=useState<Record<string,Zone[]>>({});
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pending,setPending]=useState(false);
  const [showRule,setShowRule]=useState(false);
  const [showZone,setShowZone]=useState(false);
  const [showCard,setShowCard]=useState(false);

  const [ruleService,setRuleService]=useState("");
  const [ruleEmployee,setRuleEmployee]=useState("");
  const [ruleFormat,setRuleFormat]=useState<DeliveryRule["delivery_format"]>("GROUP");
  const [rulePrice,setRulePrice]=useState("");
  const [ruleDuration,setRuleDuration]=useState("60");
  const [ruleCapacity,setRuleCapacity]=useState("1");
  const [ruleStart,setRuleStart]=useState("09:00");
  const [ruleEnd,setRuleEnd]=useState("22:00");
  const [ruleDays,setRuleDays]=useState<number[]>([1,2,3,4,5,6,7]);
  const [ruleCard,setRuleCard]=useState("");

  const [zoneResource,setZoneResource]=useState("");
  const [zoneName,setZoneName]=useState("");
  const [zoneCapacity,setZoneCapacity]=useState("1");

  const [cardName,setCardName]=useState("");
  const [cardCode,setCardCode]=useState("");
  const [cardDescription,setCardDescription]=useState("");
  const [cardLines,setCardLines]=useState<CardLineDraft[]>([]);

  const load=useCallback(async()=>{
    setError("");
    try{
      const [
        serviceRows,resourceRows,ruleRows,cardRows,warehouseRows,productRows
      ]=await Promise.all([
        apiRequest<Service[]>("/service/catalog"),
        apiRequest<Resource[]>("/service/resources"),
        apiRequest<DeliveryRule[]>("/service/delivery-rules"),
        apiRequest<TechnologyCard[]>("/service/technology-cards"),
        apiRequest<Warehouse[]>("/inventory/warehouses"),
        apiRequest<Product[]>("/catalog/products")
      ]);
      setServices(serviceRows);
      setResources(resourceRows);
      setRules(ruleRows);
      setCards(cardRows);
      setWarehouses(warehouseRows);
      setProducts(
        productRows.filter(
          (item)=>item.kind==="STOCKABLE"&&item.trackInventory
        )
      );

      const rooms=resourceRows.filter(item=>
        ["ROOM","HALL","WORKPLACE","EQUIPMENT","OTHER"].includes(item.type)
      );
      const zoneRows=await Promise.all(
        rooms.map(async room=>[
          room.id,
          await apiRequest<Zone[]>("/service/resources/"+room.id+"/zones")
        ] as const)
      );
      setZones(Object.fromEntries(zoneRows));
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить настройки студии");
    }
  },[]);

  useEffect(()=>{void load();},[load]);

  const trainers=useMemo(
    ()=>resources.filter(item=>item.type==="EMPLOYEE"),
    [resources]
  );
  const rooms=useMemo(
    ()=>resources.filter(item=>["ROOM","HALL","WORKPLACE"].includes(item.type)),
    [resources]
  );

  const linkedServices=useMemo(
    ()=>new Set(rules.map(rule=>rule.service_id)).size,
    [rules]
  );
  const configuredTrainers=useMemo(
    ()=>new Set(
      rules.map(rule=>rule.employee_resource_id).filter(Boolean)
    ).size,
    [rules]
  );
  const zoneCount=useMemo(
    ()=>Object.values(zones).reduce((sum,list)=>sum+list.length,0),
    [zones]
  );

  function toggleDay(day:number){
    setRuleDays(current=>
      current.includes(day)
        ? current.filter(item=>item!==day)
        : [...current,day].sort((a,b)=>a-b)
    );
  }

  async function createRule(event:FormEvent){
    event.preventDefault();
    setError("");
    setNotice("");
    if(!ruleService){
      setError("Выберите услугу");
      return;
    }
    if(!["SELF_PRACTICE","RENTAL"].includes(ruleFormat)&&!ruleEmployee){
      setError("Для этого формата выберите сотрудника");
      return;
    }
    if(!ruleDays.length){
      setError("Выберите хотя бы один день недели");
      return;
    }
    const priceMinor=rulePrice.trim()?rubToMinor(rulePrice):null;
    if(rulePrice.trim()&&priceMinor===null){
      setError("Проверьте цену");
      return;
    }
    const duration=Number(ruleDuration);
    const capacity=Number(ruleCapacity);
    const [sh,sm]=ruleStart.split(":").map(Number);
    const [eh,em]=ruleEnd.split(":").map(Number);
    const startMinute=sh*60+sm;
    const endMinute=eh*60+em;
    if(
      !Number.isSafeInteger(duration)||duration<5||duration>1440||
      !Number.isSafeInteger(capacity)||capacity<1||
      !Number.isFinite(startMinute)||!Number.isFinite(endMinute)||
      endMinute<=startMinute
    ){
      setError("Проверьте длительность, вместимость и время");
      return;
    }

    setPending(true);
    try{
      await apiRequest("/service/delivery-rules",{
        method:"POST",
        body:JSON.stringify({
          serviceId:ruleService,
          employeeResourceId:ruleEmployee||undefined,
          deliveryFormat:ruleFormat,
          priceMinor:priceMinor??undefined,
          durationMinutes:duration,
          capacityUnits:capacity,
          technologyCardId:ruleCard||undefined,
          weekdays:ruleDays,
          startMinute,endMinute,
          priority:100
        })
      });
      setShowRule(false);
      setNotice("Правило сохранено. Новые записи сразу используют эту цену и длительность.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось сохранить правило");
    }finally{
      setPending(false);
    }
  }

  function openCardDrawer(){
    if(!warehouses.length){
      setError("Сначала создайте склад для расходников");
      return;
    }
    if(!products.length){
      setError("Сначала добавьте хотя бы один складской материал");
      return;
    }
    setCardName("");
    setCardCode("");
    setCardDescription("");
    setCardLines([
      {
        warehouseId:warehouses[0]?.id??"",
        skuId:products[0]?.skuId??"",
        quantity:"1",
        wastePercent:"0"
      }
    ]);
    setShowCard(true);
  }

  function updateCardLine(
    index:number,
    patch:Partial<CardLineDraft>
  ){
    setCardLines(current=>
      current.map((line,lineIndex)=>
        lineIndex===index?{...line,...patch}:line
      )
    );
  }

  function addCardLine(){
    setCardLines(current=>[
      ...current,
      {
        warehouseId:warehouses[0]?.id??"",
        skuId:products[0]?.skuId??"",
        quantity:"1",
        wastePercent:"0"
      }
    ]);
  }

  async function createTechnologyCard(event:FormEvent){
    event.preventDefault();
    setError("");
    setNotice("");
    if(!cardName.trim()){
      setError("Укажите название техкарты");
      return;
    }
    if(!cardLines.length){
      setError("Добавьте хотя бы один расходник");
      return;
    }

    const lines=cardLines.map((line)=>{
      const quantity=Number(line.quantity.replace(",","."));
      const waste=Number(line.wastePercent.replace(",","."));
      if(
        !line.warehouseId||!line.skuId||
        !Number.isFinite(quantity)||quantity<=0||
        !Number.isFinite(waste)||waste<0||waste>100
      ){
        throw new Error("Проверьте материалы, количество и технологические потери");
      }
      return {
        warehouseId:line.warehouseId,
        skuId:line.skuId,
        quantityMilli:String(Math.round(quantity*1000)),
        wasteBps:Math.round(waste*100)
      };
    });

    setPending(true);
    try{
      await apiRequest("/service/technology-cards",{
        method:"POST",
        body:JSON.stringify({
          name:cardName.trim(),
          code:cardCode.trim()||undefined,
          description:cardDescription.trim()||undefined,
          lines
        })
      });
      setShowCard(false);
      setNotice(
        "Техкарта создана. Теперь её можно привязать к услуге или сотруднику."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось создать техкарту"
      );
    }finally{
      setPending(false);
    }
  }

  async function createZone(event:FormEvent){
    event.preventDefault();
    setError("");
    setNotice("");
    const capacity=Number(zoneCapacity);
    if(!zoneResource||!zoneName.trim()){
      setError("Выберите зал и укажите название зоны");
      return;
    }
    if(!Number.isSafeInteger(capacity)||capacity<1){
      setError("Проверьте вместимость зоны");
      return;
    }
    setPending(true);
    try{
      await apiRequest("/service/resources/"+zoneResource+"/zones",{
        method:"POST",
        body:JSON.stringify({
          name:zoneName.trim(),
          capacityUnits:capacity
        })
      });
      setZoneName("");
      setShowZone(false);
      setNotice("Зона добавлена. Теперь её можно бронировать независимо от остальной части зала.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать зону");
    }finally{
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="dance-setup" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero">
          <div>
            <span className="studio-eyebrow">Настройка бизнеса</span>
            <h1>Конструктор студии</h1>
            <p>
              Свяжите услуги, тренеров, цены, расписание и пространство.
              Система сама применит нужное правило при записи клиента.
            </p>
          </div>
          <div className="studio-hero-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={()=>setShowZone(true)}
            >
              + Зона зала
            </button>
            <button type="button" onClick={()=>setShowRule(true)}>
              + Правило услуги
            </button>
          </div>
        </header>

        <DanceWorkspaceNav active="setup" />

        {error?(
          <div className="studio-message error">
            <strong>Нужно проверить настройку</strong><span>{error}</span>
          </div>
        ):null}
        {notice?(
          <div className="studio-message success">
            <strong>Готово</strong><span>{notice}</span>
          </div>
        ):null}

        <div className="studio-score-grid">
          <article>
            <span>Услуги с правилами</span>
            <strong>{linkedServices}<small> / {services.length}</small></strong>
            <p>Персональная цена, длительность и формат.</p>
          </article>
          <article>
            <span>Настроено тренеров</span>
            <strong>{configuredTrainers}<small> / {trainers.length}</small></strong>
            <p>Кто и на каких условиях оказывает услуги.</p>
          </article>
          <article>
            <span>Залы и зоны</span>
            <strong>{rooms.length}<small> + {zoneCount} зон</small></strong>
            <p>Можно делить пространство между несколькими занятиями.</p>
          </article>
          <article>
            <span>Техкарты</span>
            <strong>{cards.length}</strong>
            <p>Расходники списываются при завершении визита.</p>
          </article>
        </div>

        <section className="studio-explainer">
          <div>
            <span>Как это работает</span>
            <h2>Одна услуга — разные условия без дублей</h2>
          </div>
          <ol>
            <li><b>1</b><span><strong>Выберите услугу</strong>Например, «Персональная тренировка».</span></li>
            <li><b>2</b><span><strong>Назначьте тренера и цену</strong>У каждого может быть своя стоимость и длительность.</span></li>
            <li><b>3</b><span><strong>Ограничьте время</strong>Будни, выходные, утро или вечер.</span></li>
            <li><b>4</b><span><strong>Система применит правило сама</strong>При записи, переносе и расчёте экономики.</span></li>
          </ol>
        </section>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Услуги × сотрудники</span>
              <h2>Цены и правила оказания</h2>
              <p>Чем точнее правило, тем выше его приоритет над базовой ценой услуги.</p>
            </div>
            <button className="secondary-button" type="button" onClick={()=>setShowRule(true)}>
              Добавить правило
            </button>
          </div>

          <div className="studio-rule-grid">
            {rules.map(rule=>(
              <article className="studio-rule-card" key={rule.id}>
                <header>
                  <div>
                    <span className="studio-chip">{rule.delivery_format.replace("_"," ")}</span>
                    <h3>{rule.service_name}</h3>
                    <p>{rule.employee_name??(
                      rule.delivery_format==="SELF_PRACTICE"
                        ?"Без тренера"
                        :"Правило для всех сотрудников"
                    )}</p>
                  </div>
                  <strong>{money(rule.price_minor)}</strong>
                </header>
                <div className="studio-rule-meta">
                  <div><span>Длительность</span><b>{rule.duration_minutes?minutesLabel(rule.duration_minutes):"базовая"}</b></div>
                  <div><span>Пространство</span><b>{rule.capacity_units} ед.</b></div>
                  <div><span>Время</span><b>{timeLabel(rule.start_minute)}–{timeLabel(rule.end_minute)}</b></div>
                </div>
                <footer>
                  <span>
                    {DAY_LABELS.filter(([day])=>rule.weekdays.includes(Number(day)))
                      .map(([,label])=>label).join(" · ")}
                  </span>
                  {rule.technology_card_name?<b>Техкарта: {rule.technology_card_name}</b>:null}
                </footer>
              </article>
            ))}
            {!rules.length?(
              <div className="studio-empty">
                <span>01</span>
                <strong>Начните с первого правила</strong>
                <p>Например: «Индивидуальная тренировка · Анна · 3 500 ₽ · 60 минут».</p>
                <button type="button" onClick={()=>setShowRule(true)}>Настроить</button>
              </div>
            ):null}
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Пространство</span>
              <h2>Залы, вместимость и зоны</h2>
              <p>
                Большой зал можно поделить физически или условными единицами.
                Одновременно работают несколько компаний, групп или self-practice.
              </p>
            </div>
            <a className="secondary-button" href="/app/service/resources">Все ресурсы</a>
          </div>

          <div className="studio-space-grid">
            {rooms.map(room=>(
              <article className="studio-space-card" key={room.id}>
                <header>
                  <div>
                    <span>{room.type}</span>
                    <h3>{room.name}</h3>
                  </div>
                  <strong>{room.capacity}<small> ед.</small></strong>
                </header>
                <div className="studio-zone-list">
                  {(zones[room.id]??[]).map(zone=>(
                    <div key={zone.id}>
                      <span>{zone.name}</span>
                      <b>{zone.capacity_units} ед.</b>
                    </div>
                  ))}
                  {!(zones[room.id]??[]).length?(
                    <p>Зон нет — ресурс используется общей вместимостью.</p>
                  ):null}
                </div>
                <button
                  className="studio-text-button"
                  type="button"
                  onClick={()=>{
                    setZoneResource(room.id);
                    setShowZone(true);
                  }}
                >
                  + Добавить зону
                </button>
              </article>
            ))}
            {!rooms.length?(
              <div className="studio-empty">
                <span>02</span>
                <strong>Добавьте первый зал</strong>
                <p>После этого его можно делить на зоны и частично блокировать.</p>
                <a className="secondary-button" href="/app/service/resources">Создать ресурс</a>
              </div>
            ):null}
          </div>
        </section>

        <section className="studio-section studio-next-grid">
          <a href="/app/service/packages">
            <span>Абонементы</span>
            <strong>Собрать тариф →</strong>
            <p>Ограничения по услуге, тренеру, дням недели и времени.</p>
          </a>
          <a href="/app/dance/team">
            <span>Команда</span>
            <strong>Настроить зарплату →</strong>
            <p>Фикс, час, процент, за ученика и составные схемы.</p>
          </a>
          <a href="/app/dance/groups">
            <span>Расписание</span>
            <strong>Создать занятие →</strong>
            <p>Группы, индивидуальные занятия и самостоятельная практика.</p>
          </a>
        </section>

        {showRule?(
          <div className="studio-drawer-backdrop" onMouseDown={()=>setShowRule(false)}>
            <aside className="studio-drawer" onMouseDown={event=>event.stopPropagation()}>
              <header>
                <div><span>Новое правило</span><h2>Кто, что и за сколько</h2></div>
                <button type="button" className="studio-close" onClick={()=>setShowRule(false)}>×</button>
              </header>
              <form onSubmit={createRule}>
                <label>
                  <span>Услуга</span>
                  <select value={ruleService} onChange={event=>setRuleService(event.target.value)} required>
                    <option value="">Выберите услугу</option>
                    {services.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
                  </select>
                </label>

                <div className="studio-form-grid">
                  <label>
                    <span>Формат</span>
                    <select value={ruleFormat} onChange={event=>setRuleFormat(event.target.value as DeliveryRule["delivery_format"])}>
                      <option value="INDIVIDUAL">Индивидуально</option>
                      <option value="GROUP">Группа</option>
                      <option value="SELF_PRACTICE">Самостоятельная практика</option>
                      <option value="RENTAL">Аренда</option>
                    </select>
                  </label>
                  <label>
                    <span>Сотрудник</span>
                    <select value={ruleEmployee} onChange={event=>setRuleEmployee(event.target.value)}>
                      <option value="">Без привязки</option>
                      {trainers.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}
                    </select>
                  </label>
                </div>

                <div className="studio-form-grid">
                  <label>
                    <span>Цена, ₽</span>
                    <input inputMode="decimal" placeholder="Например, 3500" value={rulePrice} onChange={event=>setRulePrice(event.target.value)} />
                    <small>Пусто = базовая цена услуги.</small>
                  </label>
                  <label>
                    <span>Длительность, минут</span>
                    <input type="number" min="5" max="1440" value={ruleDuration} onChange={event=>setRuleDuration(event.target.value)} />
                  </label>
                </div>

                <label>
                  <span>Сколько единиц пространства занимает запись</span>
                  <input type="number" min="1" max="100000" value={ruleCapacity} onChange={event=>setRuleCapacity(event.target.value)} />
                  <small>Например, 50 из 100 единиц большого зала.</small>
                </label>

                <div className="studio-form-grid">
                  <label><span>С</span><input type="time" value={ruleStart} onChange={event=>setRuleStart(event.target.value)} /></label>
                  <label><span>До</span><input type="time" value={ruleEnd} onChange={event=>setRuleEnd(event.target.value)} /></label>
                </div>

                <fieldset className="studio-weekdays">
                  <legend>Дни недели</legend>
                  {DAY_LABELS.map(([day,label])=>(
                    <button
                      key={day}
                      type="button"
                      className={ruleDays.includes(Number(day))?"active":""}
                      onClick={()=>toggleDay(Number(day))}
                    >{label}</button>
                  ))}
                </fieldset>

                {cards.length?(
                  <label>
                    <span>Технологическая карта</span>
                    <select value={ruleCard} onChange={event=>setRuleCard(event.target.value)}>
                      <option value="">Без автоматических расходников</option>
                      {cards.map(card=><option key={card.id} value={card.id}>{card.name}</option>)}
                    </select>
                    <small>Материалы будут списаны при завершении визита.</small>
                  </label>
                ):null}

                <div className="studio-drawer-actions">
                  <button type="button" className="secondary-button" onClick={()=>setShowRule(false)}>Отмена</button>
                  <button disabled={pending} type="submit">{pending?"Сохраняем…":"Сохранить правило"}</button>
                </div>
              </form>
            </aside>
          </div>
        ):null}

        {showZone?(
          <div className="studio-drawer-backdrop" onMouseDown={()=>setShowZone(false)}>
            <aside className="studio-drawer studio-drawer-small" onMouseDown={event=>event.stopPropagation()}>
              <header>
                <div><span>Пространство</span><h2>Новая зона зала</h2></div>
                <button type="button" className="studio-close" onClick={()=>setShowZone(false)}>×</button>
              </header>
              <form onSubmit={createZone}>
                <label>
                  <span>Зал</span>
                  <select value={zoneResource} onChange={event=>setZoneResource(event.target.value)} required>
                    <option value="">Выберите зал</option>
                    {rooms.map(room=><option key={room.id} value={room.id}>{room.name} · {room.capacity} ед.</option>)}
                  </select>
                </label>
                <label>
                  <span>Название зоны</span>
                  <input placeholder="Например, Левая половина" value={zoneName} onChange={event=>setZoneName(event.target.value)} required />
                </label>
                <label>
                  <span>Вместимость зоны</span>
                  <input type="number" min="1" value={zoneCapacity} onChange={event=>setZoneCapacity(event.target.value)} required />
                  <small>Сумма активных зон не может быть больше вместимости зала.</small>
                </label>
                <div className="studio-drawer-actions">
                  <button type="button" className="secondary-button" onClick={()=>setShowZone(false)}>Отмена</button>
                  <button disabled={pending} type="submit">{pending?"Сохраняем…":"Создать зону"}</button>
                </div>
              </form>
            </aside>
          </div>
        ):null}
      </section>
    </main>
  );
}
