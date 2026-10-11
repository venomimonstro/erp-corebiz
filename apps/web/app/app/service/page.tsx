"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { StudioModal } from "../../../components/studio-modal";
import { apiRequest } from "../../../lib/api";

type Booking={
  id:string;
  business_number:string;
  status:string;
  starts_at:string;
  ends_at:string;
  price_minor_snapshot:string;
  currency:string;
  version:number;
  party_name:string|null;
  service_name:string;
  resources:Array<{
    resourceId:string;
    resourceName:string;
    type:string;
  }>;
};

type TodayData={
  bookings:Booking[];
  metrics:{
    total:number;
    completed:number;
    noShow:number;
    revenueMinor:string;
  };
};

type Analytics={
  services:Array<{
    id:string;
    name:string;
    bookings:number;
    completed:number;
    no_show:number;
    revenue_minor:string;
  }>;
  resources:Array<{
    id:string;
    name:string;
    type:string;
    bookings:number;
    booked_minutes:string;
    completed:number;
  }>;
};

type Economics={
  totals:{
    completed:number;
    revenue_minor:string;
    material_cost_minor:string;
    employee_cost_minor:string;
    resource_cost_minor:string;
    margin_minor:string;
  };
  employees:Array<{
    id:string;
    name:string;
    completed:number;
    revenue_minor:string;
    employee_cost_minor:string;
    margin_minor:string;
  }>;
  services:Array<{
    id:string;
    name:string;
    completed:number;
    revenue_minor:string;
    material_cost_minor:string;
    employee_cost_minor:string;
    margin_minor:string;
  }>;
  retentionAlerts:Array<{
    party_id:string;
    party_name:string;
    service_id:string;
    service_name:string;
    last_completed_at:string;
    target_at:string;
    overdue_days:number;
  }>;
};

type Balance={
  warehouseId:string;
  warehouseName:string;
  skuId:string;
  sku:string;
  productName:string;
  availableMilli:string;
};

function money(value:string|number|undefined){
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",
    currency:"RUB",
    maximumFractionDigits:0
  }).format(Number(value??0)/100);
}

export default function ServiceHomePage(){
  const [today,setToday]=useState<TodayData|null>(null);
  const [analytics,setAnalytics]=useState<Analytics|null>(null);
  const [economics,setEconomics]=useState<Economics|null>(null);
  const [balances,setBalances]=useState<Balance[]>([]);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pending,setPending]=useState(false);

  const [materialBooking,setMaterialBooking]=useState<Booking|null>(null);
  const [materialKey,setMaterialKey]=useState("");
  const [materialQuantity,setMaterialQuantity]=useState("1");

  const load=useCallback(async()=>{
    setError("");
    try{
      const [todayData,analyticsData,balanceData,economicsData]=await Promise.all([
        apiRequest<TodayData>("/service/workspace/today"),
        apiRequest<Analytics>("/service/workspace/analytics"),
        apiRequest<Balance[]>("/inventory/balances"),
        apiRequest<Economics>("/service/economics")
      ]);
      setToday(todayData);
      setAnalytics(analyticsData);
      setBalances(balanceData);
      setEconomics(economicsData);
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось загрузить рабочее место"
      );
    }
  },[]);

  useEffect(()=>{void load();},[load]);

  const conversion=useMemo(()=>{
    if(!today?.metrics.total) return 0;
    return Math.round(today.metrics.completed/today.metrics.total*100);
  },[today]);

  const availableMaterials=useMemo(
    ()=>balances.filter(item=>BigInt(item.availableMilli)>0n),
    [balances]
  );

  function openMaterial(booking:Booking){
    setMaterialBooking(booking);
    const first=availableMaterials[0];
    setMaterialKey(first?first.warehouseId+"|"+first.skuId:"");
    setMaterialQuantity("1");
  }

  async function consumeMaterial(){
    if(!materialBooking) return;
    const [warehouseId,skuId]=materialKey.split("|");
    const item=availableMaterials.find(
      row=>row.warehouseId===warehouseId&&row.skuId===skuId
    );
    if(!item){
      setError("Выберите расходник");
      return;
    }
    const units=Number(materialQuantity.replace(",","."));
    const max=Number(item.availableMilli)/1000;
    if(!Number.isFinite(units)||units<=0||units>max){
      setError("Проверьте количество расхода");
      return;
    }
    const quantityMilli=String(Math.round(units*1000));
    setPending(true);
    setError("");
    try{
      const line=await apiRequest<{id:string}>(
        "/service/workspace/bookings/"+materialBooking.id+"/materials",
        {
          method:"POST",
          body:JSON.stringify({warehouseId,skuId,quantityMilli})
        }
      );
      await apiRequest(
        "/service/workspace/materials/"+line.id+"/consume",
        {
          method:"POST",
          body:JSON.stringify({
            quantityMilli,
            idempotencyKey:crypto.randomUUID()
          })
        }
      );
      setMaterialBooking(null);
      setNotice(
        "Фактический расход сохранён. Для регулярных материалов лучше использовать техкарту."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось списать материал"
      );
    }finally{
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="service-home" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero">
          <div>
            <span className="studio-eyebrow">Операционный центр</span>
            <h1>Сегодня в бизнесе</h1>
            <p>
              Записи, загрузка, выручка и реальная маржа после материалов,
              мастеров и ресурсов — на одном экране.
            </p>
          </div>
          <div className="studio-hero-actions">
            <a className="secondary-button" href="/app/service/setup">
              Настроить услуги
            </a>
            <a className="secondary-button" href="/app/service/team">
              Команда и зарплата
            </a>
            <a className="button-link" href="/app/service/bookings">
              Открыть календарь
            </a>
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
            <span>Записей сегодня</span>
            <strong>{today?.metrics.total??0}</strong>
            <p>{today?.metrics.completed??0} завершено · no-show {today?.metrics.noShow??0}</p>
          </article>
          <article>
            <span>Выполнено сегодня</span>
            <strong>{conversion}%</strong>
            <p>Доля завершённых записей текущего дня.</p>
          </article>
          <article>
            <span>Маржа месяца</span>
            <strong>{money(economics?.totals.margin_minor)}</strong>
            <p>После материалов, мастеров и стоимости ресурсов.</p>
          </article>
          <article>
            <span>Команде</span>
            <strong>{money(economics?.totals.employee_cost_minor)}</strong>
            <p>Автоматические начисления по завершённым визитам.</p>
          </article>
        </div>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Сегодня</span>
              <h2>Расписание без шума</h2>
              <p>
                Основные действия рядом с записью. Материалы по техкартам
                списываются автоматически при завершении.
              </p>
            </div>
            <a className="secondary-button" href="/app/service/bookings">
              Полный календарь
            </a>
          </div>

          <div className="service-today-list">
            {(today?.bookings??[]).map(booking=>(
              <article className="service-today-row" key={booking.id}>
                <div className="booking-time">
                  <strong>
                    {new Date(booking.starts_at).toLocaleTimeString(
                      "ru-RU",{hour:"2-digit",minute:"2-digit"}
                    )}
                  </strong>
                  <span>
                    {new Date(booking.ends_at).toLocaleTimeString(
                      "ru-RU",{hour:"2-digit",minute:"2-digit"}
                    )}
                  </span>
                </div>
                <div>
                  <strong>{booking.service_name}</strong>
                  <span>
                    {booking.party_name??"Без клиента"} ·{" "}
                    {booking.resources.map(item=>item.resourceName).join(", ")||"ресурс не назначен"}
                  </span>
                </div>
                <span className="status-pill">{booking.status}</span>
                <button
                  className="secondary-button"
                  disabled={
                    ["CANCELLED","NO_SHOW","COMPLETED"].includes(booking.status)||
                    !availableMaterials.length
                  }
                  type="button"
                  onClick={()=>openMaterial(booking)}
                >
                  + Факт. расход
                </button>
              </article>
            ))}
            {!(today?.bookings.length??0)?(
              <div className="studio-empty">
                <span>01</span>
                <strong>Сегодня записей нет</strong>
                <p>Откройте календарь или проверьте онлайн-запись.</p>
              </div>
            ):null}
          </div>
        </section>

        <section className="studio-economics-grid">
          <article className="studio-economics-panel">
            <header>
              <div>
                <span>Услуги</span>
                <h2>Что приносит маржу</h2>
              </div>
              <small>текущий месяц</small>
            </header>
            <div className="studio-economics-list">
              {(economics?.services??[]).slice(0,8).map(item=>(
                <div key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>{item.completed} завершено</span>
                  </div>
                  <div>
                    <strong>{money(item.margin_minor)}</strong>
                    <span>
                      выручка {money(item.revenue_minor)} · материалы{" "}
                      {money(item.material_cost_minor)}
                    </span>
                  </div>
                </div>
              ))}
              {!(economics?.services.length??0)?(
                <p>Экономика появится после завершения первых визитов.</p>
              ):null}
            </div>
          </article>

          <article className="studio-economics-panel">
            <header>
              <div>
                <span>Команда</span>
                <h2>Экономика по сотрудникам</h2>
              </div>
              <a href="/app/service/team">Открыть зарплату →</a>
            </header>
            <div className="studio-economics-list">
              {(economics?.employees??[]).slice(0,8).map(item=>(
                <div key={item.id}>
                  <div>
                    <strong>{item.name}</strong>
                    <span>{item.completed} завершено</span>
                  </div>
                  <div>
                    <strong>{money(item.margin_minor)}</strong>
                    <span>
                      выручка {money(item.revenue_minor)} · мастеру{" "}
                      {money(item.employee_cost_minor)}
                    </span>
                  </div>
                </div>
              ))}
              {!(economics?.employees.length??0)?(
                <p>Настройте правила оплаты и завершите первые визиты.</p>
              ):null}
            </div>
          </article>
        </section>

        {(economics?.retentionAlerts.length??0)>0?(
          <section className="studio-section">
            <div className="studio-section-head">
              <div>
                <span>Возврат клиентов</span>
                <h2>Кому уже пора вернуться</h2>
                <p>
                  Только клиенты без будущей записи на ту же услугу.
                  Срок считается от последнего завершённого визита.
                </p>
              </div>
              <a className="secondary-button" href="/app/crm">
                Клиенты
              </a>
            </div>
            <div className="studio-rule-grid">
              {(economics?.retentionAlerts??[]).slice(0,12).map(item=>(
                <article
                  className="studio-rule-card"
                  key={item.party_id+"|"+item.service_id}
                >
                  <header>
                    <div>
                      <span className="studio-chip">
                        {item.overdue_days>0
                          ?"просрочено "+item.overdue_days+" дн."
                          :"пора записать"}
                      </span>
                      <h3>{item.party_name}</h3>
                      <p>{item.service_name}</p>
                    </div>
                    <strong>
                      {new Date(item.target_at).toLocaleDateString("ru-RU",{
                        day:"2-digit",month:"short"
                      })}
                    </strong>
                  </header>
                  <footer>
                    <span>
                      Был{" "}
                      {new Date(item.last_completed_at).toLocaleDateString(
                        "ru-RU",{day:"2-digit",month:"short"}
                      )}
                    </span>
                    <a href="/app/service/bookings?create=1">
                      Записать →
                    </a>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        ):null}

        {analytics?(
          <section className="studio-section">
            <div className="studio-section-head">
              <div>
                <span>Загрузка</span>
                <h2>Где есть свободная мощность</h2>
                <p>
                  Смотрите не только выручку, но и сколько времени реально заняты
                  сотрудники, кабинеты и рабочие места.
                </p>
              </div>
            </div>
            <div className="studio-rule-grid">
              {analytics.resources.slice(0,8).map(resource=>(
                <article className="studio-rule-card" key={resource.id}>
                  <header>
                    <div>
                      <span className="studio-chip">{resource.type}</span>
                      <h3>{resource.name}</h3>
                      <p>{resource.bookings} записей</p>
                    </div>
                    <strong>
                      {Math.round(Number(resource.booked_minutes)/60)}
                      <small> ч</small>
                    </strong>
                  </header>
                  <footer>
                    <span>завершено {resource.completed}</span>
                    <b>за 30 дней</b>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        ):null}

        {materialBooking?(
          <StudioModal
            eyebrow="Корректировка материалов"
            title={"Фактический расход · "+materialBooking.service_name}
            description="Основной расход берётся из техкарты автоматически. Здесь можно добавить разовый фактический материал."
            onClose={()=>setMaterialBooking(null)}
          >
            <div className="studio-modal-form">
              <label>
                <span>Материал</span>
                <select
                  value={materialKey}
                  onChange={event=>setMaterialKey(event.target.value)}
                >
                  {availableMaterials.map(item=>(
                    <option
                      key={item.warehouseId+"|"+item.skuId}
                      value={item.warehouseId+"|"+item.skuId}
                    >
                      {item.productName} · {item.sku} · {item.warehouseName}
                      {" · "}доступно {Number(item.availableMilli)/1000}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Количество</span>
                <input
                  inputMode="decimal"
                  value={materialQuantity}
                  onChange={event=>setMaterialQuantity(event.target.value)}
                />
              </label>
              <div className="studio-drawer-actions">
                <button className="secondary-button" type="button" onClick={()=>setMaterialBooking(null)}>
                  Отмена
                </button>
                <button disabled={pending} type="button" onClick={()=>void consumeMaterial()}>
                  {pending?"Списываем…":"Добавить расход"}
                </button>
              </div>
            </div>
          </StudioModal>
        ):null}
      </section>
    </main>
  );
}
