"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { StudioModal } from "../../../../components/studio-modal";
import { apiRequest } from "../../../../lib/api";

type Resource={
  id:string;
  name:string;
  type:string;
};

type Service={
  id:string;
  name:string;
};

type Component={
  componentType:"FIXED_VISIT"|"HOURLY"|"PERCENT_REVENUE"|"PERCENT_MARGIN";
  amountMinor:string;
  percentBps:number;
};

type CompensationPlan={
  id:string;
  employee_resource_id:string;
  employee_name:string;
  service_id:string|null;
  service_name:string|null;
  delivery_format:string|null;
  branch_name:string|null;
  components:Component[];
};

type PayrollProfile={
  id:string;
  employee_resource_id:string;
  employee_name:string;
  monthly_base_minor:string;
  daily_base_minor:string;
  minimum_guarantee_minor:string;
};

type Statement={
  id:string;
  employee_resource_id:string;
  employee_name:string;
  variable_minor:string;
  monthly_base_minor:string;
  daily_base_minor:string;
  guarantee_adjustment_minor:string;
  adjustment_minor:string;
  total_minor:string;
  status:string;
};

type EconomicsRow={
  id:string;
  name:string;
  completed:number;
  revenue_minor:string;
  material_cost_minor:string;
  employee_cost_minor:string;
  margin_minor:string;
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
  employees:EconomicsRow[];
  services:EconomicsRow[];
};

function money(value:string|number|undefined){
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",
    currency:"RUB",
    maximumFractionDigits:0
  }).format(Number(value??0)/100);
}

function rubToMinor(value:string){
  const parsed=Number(value.replace(",","."));
  return Number.isFinite(parsed)&&parsed>=0
    ?String(Math.round(parsed*100))
    :null;
}

function percentLabel(value:number){
  return (value/100).toLocaleString("ru-RU")+"%";
}

function componentLabel(component:Component){
  if(component.componentType==="FIXED_VISIT"){
    return money(component.amountMinor)+" за визит";
  }
  if(component.componentType==="HOURLY"){
    return money(component.amountMinor)+" / час";
  }
  if(component.componentType==="PERCENT_REVENUE"){
    return percentLabel(component.percentBps)+" от выручки";
  }
  return percentLabel(component.percentBps)+" от маржи";
}

const currentMonth=()=>new Date().toISOString().slice(0,7);

export default function ServiceTeamPage(){
  const [resources,setResources]=useState<Resource[]>([]);
  const [services,setServices]=useState<Service[]>([]);
  const [plans,setPlans]=useState<CompensationPlan[]>([]);
  const [profiles,setProfiles]=useState<PayrollProfile[]>([]);
  const [statements,setStatements]=useState<Statement[]>([]);
  const [economics,setEconomics]=useState<Economics|null>(null);
  const [month,setMonth]=useState(currentMonth());
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [pending,setPending]=useState(false);
  const [showRule,setShowRule]=useState(false);
  const [showProfile,setShowProfile]=useState(false);

  const [employeeId,setEmployeeId]=useState("");
  const [serviceId,setServiceId]=useState("");
  const [fixedVisit,setFixedVisit]=useState("");
  const [hourly,setHourly]=useState("");
  const [revenuePercent,setRevenuePercent]=useState("");
  const [marginPercent,setMarginPercent]=useState("");

  const [profileEmployee,setProfileEmployee]=useState("");
  const [monthlyBase,setMonthlyBase]=useState("");
  const [dailyBase,setDailyBase]=useState("");
  const [guarantee,setGuarantee]=useState("");

  const load=useCallback(async()=>{
    setError("");
    try{
      const [
        resourceRows,serviceRows,planRows,profileRows,statementRows,economicsRows
      ]=await Promise.all([
        apiRequest<Resource[]>("/service/resources"),
        apiRequest<Service[]>("/service/catalog"),
        apiRequest<CompensationPlan[]>("/service/economics/compensation-plans"),
        apiRequest<PayrollProfile[]>("/service/economics/payroll-profiles"),
        apiRequest<Statement[]>(
          "/service/economics/payroll-statements?month="+encodeURIComponent(month)
        ),
        apiRequest<Economics>("/service/economics")
      ]);
      setResources(resourceRows);
      setServices(serviceRows);
      setPlans(planRows);
      setProfiles(profileRows);
      setStatements(statementRows);
      setEconomics(economicsRows);
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось загрузить экономику команды"
      );
    }
  },[month]);

  useEffect(()=>{void load();},[load]);

  const employees=useMemo(
    ()=>resources.filter(item=>item.type==="EMPLOYEE"),
    [resources]
  );

  const profileByEmployee=useMemo(
    ()=>new Map(profiles.map(item=>[item.employee_resource_id,item])),
    [profiles]
  );

  async function createRule(event:FormEvent){
    event.preventDefault();
    setError("");
    setNotice("");
    if(!employeeId){
      setError("Выберите сотрудника");
      return;
    }

    const components:Array<Record<string,unknown>>=[];
    const fixed=fixedVisit.trim()?rubToMinor(fixedVisit):null;
    const hour=hourly.trim()?rubToMinor(hourly):null;
    const revenue=Number(revenuePercent.replace(",","."));
    const margin=Number(marginPercent.replace(",","."));

    if(fixedVisit.trim()&&fixed===null){
      setError("Проверьте фикс за визит");
      return;
    }
    if(hourly.trim()&&hour===null){
      setError("Проверьте часовую ставку");
      return;
    }
    if(fixed&&BigInt(fixed)>0n){
      components.push({
        componentType:"FIXED_VISIT",
        amountMinor:fixed
      });
    }
    if(hour&&BigInt(hour)>0n){
      components.push({
        componentType:"HOURLY",
        amountMinor:hour
      });
    }
    if(Number.isFinite(revenue)&&revenue>0){
      if(revenue>100){
        setError("Процент от выручки не может быть больше 100%");
        return;
      }
      components.push({
        componentType:"PERCENT_REVENUE",
        percentBps:Math.round(revenue*100)
      });
    }
    if(Number.isFinite(margin)&&margin>0){
      if(margin>100){
        setError("Процент от маржи не может быть больше 100%");
        return;
      }
      components.push({
        componentType:"PERCENT_MARGIN",
        percentBps:Math.round(margin*100)
      });
    }
    if(!components.length){
      setError("Добавьте хотя бы один компонент оплаты");
      return;
    }

    setPending(true);
    try{
      await apiRequest("/service/economics/compensation-plans",{
        method:"POST",
        body:JSON.stringify({
          employeeResourceId:employeeId,
          serviceId:serviceId||undefined,
          components
        })
      });
      setShowRule(false);
      setNotice("Правило оплаты сохранено и будет применяться к новым завершённым визитам.");
      setFixedVisit("");
      setHourly("");
      setRevenuePercent("");
      setMarginPercent("");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось сохранить правило"
      );
    }finally{
      setPending(false);
    }
  }

  async function createProfile(event:FormEvent){
    event.preventDefault();
    setError("");
    setNotice("");
    if(!profileEmployee){
      setError("Выберите сотрудника");
      return;
    }
    const monthly=rubToMinor(monthlyBase||"0");
    const daily=rubToMinor(dailyBase||"0");
    const minimum=rubToMinor(guarantee||"0");
    if(monthly===null||daily===null||minimum===null){
      setError("Проверьте параметры оклада");
      return;
    }
    setPending(true);
    try{
      await apiRequest("/service/economics/payroll-profiles",{
        method:"POST",
        body:JSON.stringify({
          employeeResourceId:profileEmployee,
          monthlyBaseMinor:monthly,
          dailyBaseMinor:daily,
          minimumGuaranteeMinor:minimum
        })
      });
      setShowProfile(false);
      setNotice("Постоянная часть зарплаты сохранена.");
      setMonthlyBase("");
      setDailyBase("");
      setGuarantee("");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось сохранить профиль"
      );
    }finally{
      setPending(false);
    }
  }

  async function finalize(){
    if(!window.confirm(
      "Закрыть ведомость за "+month+"? Переменные начисления, оклад и гарантия будут зафиксированы."
    )) return;
    setPending(true);
    setError("");
    try{
      const result=await apiRequest<{finalized:number}>(
        "/service/economics/payroll-statements/finalize",
        {
          method:"POST",
          body:JSON.stringify({month})
        }
      );
      setNotice(
        "Ведомости закрыты: "+result.finalized+". Повторный запуск не изменит уже закрытые ведомости."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось закрыть ведомости"
      );
    }finally{
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="service-team" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero">
          <div>
            <span className="studio-eyebrow">Команда / экономика</span>
            <h1>Зарплата без таблиц</h1>
            <p>
              Настройте правила один раз. После каждого завершённого визита
              CoreBiz сам считает материалы, оплату мастеру и маржу.
            </p>
          </div>
          <div className="studio-hero-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={()=>setShowProfile(true)}
            >
              + Оклад / гарантия
            </button>
            <button type="button" onClick={()=>setShowRule(true)}>
              + Правило оплаты
            </button>
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
            <span>Выручка</span>
            <strong>{money(economics?.totals.revenue_minor)}</strong>
            <p>{economics?.totals.completed??0} завершённых визитов в периоде.</p>
          </article>
          <article>
            <span>Материалы</span>
            <strong>{money(economics?.totals.material_cost_minor)}</strong>
            <p>Фактическое списание по технологическим картам.</p>
          </article>
          <article>
            <span>Начислено команде</span>
            <strong>{money(economics?.totals.employee_cost_minor)}</strong>
            <p>Переменная часть по правилам завершённых визитов.</p>
          </article>
          <article>
            <span>Маржа</span>
            <strong>{money(economics?.totals.margin_minor)}</strong>
            <p>После материалов, мастеров и ресурсов.</p>
          </article>
        </div>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Мастера</span>
              <h2>Кто приносит результат</h2>
              <p>
                Не рейтинг людей, а прозрачная экономика: выручка, расход,
                начисление и вклад в маржу.
              </p>
            </div>
          </div>
          <div className="studio-rule-grid">
            {(economics?.employees??[]).map(item=>(
              <article className="studio-rule-card" key={item.id}>
                <header>
                  <div>
                    <span className="studio-chip">{item.completed} визитов</span>
                    <h3>{item.name}</h3>
                    <p>Выручка {money(item.revenue_minor)}</p>
                  </div>
                  <strong>{money(item.margin_minor)}</strong>
                </header>
                <footer>
                  <span>Материалы {money(item.material_cost_minor)}</span>
                  <b>Мастеру {money(item.employee_cost_minor)}</b>
                </footer>
              </article>
            ))}
            {!(economics?.employees.length??0)?(
              <div className="studio-empty">
                <span>01</span>
                <strong>Экономика появится после первых визитов</strong>
                <p>Закройте визит, и система автоматически сформирует снимок.</p>
              </div>
            ):null}
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Правила оплаты</span>
              <h2>Как начисляется зарплата</h2>
              <p>
                Можно комбинировать фикс, час, процент от выручки и процент
                от маржи. Правило конкретной услуги приоритетнее общего.
              </p>
            </div>
            <button className="secondary-button" type="button" onClick={()=>setShowRule(true)}>
              Добавить правило
            </button>
          </div>
          <div className="studio-rule-grid">
            {plans.map(plan=>(
              <article className="studio-rule-card" key={plan.id}>
                <header>
                  <div>
                    <span className="studio-chip">
                      {plan.service_name??"Все услуги"}
                    </span>
                    <h3>{plan.employee_name}</h3>
                    <p>
                      {plan.branch_name??"Все филиалы"}
                      {plan.delivery_format?" · "+plan.delivery_format:""}
                    </p>
                  </div>
                  <strong>{plan.components.length}<small> компон.</small></strong>
                </header>
                <footer>
                  <span>
                    {plan.components.map(componentLabel).join(" + ")}
                  </span>
                  <b>
                    {profileByEmployee.has(plan.employee_resource_id)
                      ?"Есть постоянная часть"
                      :"Только переменная часть"}
                  </b>
                </footer>
              </article>
            ))}
            {!plans.length?(
              <div className="studio-empty">
                <span>02</span>
                <strong>Добавьте первое правило</strong>
                <p>Например: 40% от услуги или 500 ₽ + 20% от выручки.</p>
              </div>
            ):null}
          </div>
        </section>

        <section className="studio-section">
          <div className="studio-section-head">
            <div>
              <span>Месячная ведомость</span>
              <h2>Что выплатить команде</h2>
              <p>
                Переменная часть + пропорциональный месячный оклад + дневная
                ставка + доплата до минимальной гарантии.
              </p>
            </div>
            <div className="studio-hero-actions">
              <input
                type="month"
                value={month}
                onChange={event=>setMonth(event.target.value)}
              />
              <button disabled={pending} type="button" onClick={()=>void finalize()}>
                {pending?"Закрываем…":"Закрыть месяц"}
              </button>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Сотрудник</th>
                  <th>Визиты / %</th>
                  <th>Оклад</th>
                  <th>Дни</th>
                  <th>Гарантия</th>
                  <th>Итого</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {statements.map(item=>(
                  <tr key={item.id}>
                    <td><strong>{item.employee_name}</strong></td>
                    <td>{money(item.variable_minor)}</td>
                    <td>{money(item.monthly_base_minor)}</td>
                    <td>{money(item.daily_base_minor)}</td>
                    <td>{money(item.guarantee_adjustment_minor)}</td>
                    <td><strong>{money(item.total_minor)}</strong></td>
                    <td><span className="status-pill">{item.status}</span></td>
                  </tr>
                ))}
                {!statements.length?(
                  <tr>
                    <td colSpan={7}>
                      <div className="table-empty">
                        <strong>Месяц ещё не закрыт</strong>
                        <span>
                          Можно продолжать работу. Нажмите «Закрыть месяц»,
                          когда готовы зафиксировать ведомость.
                        </span>
                      </div>
                    </td>
                  </tr>
                ):null}
              </tbody>
            </table>
          </div>
        </section>

        {showRule?(
          <StudioModal
            eyebrow="Зарплата мастера"
            title="Новое правило оплаты"
            description="Соберите формулу из нескольких компонентов. Пустые поля не используются."
            onClose={()=>setShowRule(false)}
          >
            <form className="studio-modal-form" onSubmit={createRule}>
              <label>
                <span>Сотрудник</span>
                <select value={employeeId} onChange={event=>setEmployeeId(event.target.value)} required>
                  <option value="">Выберите сотрудника</option>
                  {employees.map(item=>(
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>Услуга</span>
                <select value={serviceId} onChange={event=>setServiceId(event.target.value)}>
                  <option value="">Все услуги</option>
                  {services.map(item=>(
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
                <small>Если выбрана услуга, это правило приоритетнее общего.</small>
              </label>
              <div className="studio-form-grid">
                <label>
                  <span>Фикс за визит, ₽</span>
                  <input inputMode="decimal" value={fixedVisit} onChange={event=>setFixedVisit(event.target.value)} placeholder="500" />
                </label>
                <label>
                  <span>За час, ₽</span>
                  <input inputMode="decimal" value={hourly} onChange={event=>setHourly(event.target.value)} placeholder="0" />
                </label>
                <label>
                  <span>% от выручки</span>
                  <input inputMode="decimal" value={revenuePercent} onChange={event=>setRevenuePercent(event.target.value)} placeholder="40" />
                </label>
                <label>
                  <span>% от маржи</span>
                  <input inputMode="decimal" value={marginPercent} onChange={event=>setMarginPercent(event.target.value)} placeholder="0" />
                </label>
              </div>
              <div className="studio-drawer-actions">
                <button className="secondary-button" type="button" onClick={()=>setShowRule(false)}>Отмена</button>
                <button disabled={pending} type="submit">{pending?"Сохраняем…":"Сохранить правило"}</button>
              </div>
            </form>
          </StudioModal>
        ):null}

        {showProfile?(
          <StudioModal
            eyebrow="Постоянная часть"
            title="Оклад и гарантия"
            description="Используйте только нужные поля. Месячный оклад автоматически пропорционируется по активному периоду."
            onClose={()=>setShowProfile(false)}
          >
            <form className="studio-modal-form" onSubmit={createProfile}>
              <label>
                <span>Сотрудник</span>
                <select value={profileEmployee} onChange={event=>setProfileEmployee(event.target.value)} required>
                  <option value="">Выберите сотрудника</option>
                  {employees.map(item=>(
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <div className="studio-form-grid">
                <label>
                  <span>Оклад в месяц, ₽</span>
                  <input inputMode="decimal" value={monthlyBase} onChange={event=>setMonthlyBase(event.target.value)} placeholder="50000" />
                </label>
                <label>
                  <span>За рабочий день, ₽</span>
                  <input inputMode="decimal" value={dailyBase} onChange={event=>setDailyBase(event.target.value)} placeholder="0" />
                </label>
              </div>
              <label>
                <span>Минимальная гарантия за месяц, ₽</span>
                <input inputMode="decimal" value={guarantee} onChange={event=>setGuarantee(event.target.value)} placeholder="0" />
                <small>
                  Если сумма оклада и переменной части ниже гарантии,
                  CoreBiz добавит разницу.
                </small>
              </label>
              <div className="studio-drawer-actions">
                <button className="secondary-button" type="button" onClick={()=>setShowProfile(false)}>Отмена</button>
                <button disabled={pending} type="submit">{pending?"Сохраняем…":"Сохранить"}</button>
              </div>
            </form>
          </StudioModal>
        ):null}
      </section>
    </main>
  );
}
