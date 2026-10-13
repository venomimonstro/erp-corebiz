"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Month={revenue_minor:string;trainer_cost_minor:string;
  room_cost_minor:string;other_cost_minor:string;owner_margin_minor:string};
type Dashboard={canViewFinancials:boolean;monthEconomics:Month|null};
const keys=["monthlyRevenue","rentA","rentB","managerSalaries",
  "trainerSalaries","taxes","otherExpenses","subleaseRevenue"] as const;
type Key=typeof keys[number];
type Inputs=Record<Key,string>;
type BudgetValues=Record<
  "revenueMinor"|"rentBranchAMinor"|"rentBranchBMinor"|
  "managersMinor"|"trainersMinor"|"taxesMinor"|"otherMinor"|"subleaseMinor",
  string|null
>;
type Plan={month:string;version:number;values:BudgetValues;updatedAt:string|null};
const mapping:Record<Key,keyof BudgetValues>={
  monthlyRevenue:"revenueMinor",rentA:"rentBranchAMinor",
  rentB:"rentBranchBMinor",managerSalaries:"managersMinor",
  trainerSalaries:"trainersMinor",taxes:"taxesMinor",
  otherExpenses:"otherMinor",subleaseRevenue:"subleaseMinor"
};
const empty=():Inputs=>Object.fromEntries(keys.map(k=>[k,""])) as Inputs;
const sample=():Inputs=>({
  ...empty(),monthlyRevenue:"3000000",rentA:"700000",managerSalaries:"100000"
});
const currentMonth=()=>new Intl.DateTimeFormat("sv-SE",{
  year:"numeric",month:"2-digit",timeZone:"Europe/Moscow"
}).format(new Date());
const money=(n:bigint)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB",maximumFractionDigits:0
}).format(Number(n)/100);
const rubles=(raw:string):bigint|null=>{
  const value=raw.trim().replace(",",".");
  if(!value||!/^\d{1,12}(?:\.\d{1,2})?$/.test(value))return null;
  const [whole,fract=""]=value.split(".");
  return BigInt(whole)*100n+BigInt(fract.padEnd(2,"0"));
};
const fromMinor=(n:string|null):string=>{
  if(n===null)return "";
  const num=BigInt(n);
  return (num/100n).toString()+(num%100n===0n?"":"."+
    (num%100n).toString().padStart(2,"0").replace(/0+$/,""));
};

export default function DanceBudgetPage(){
  const [month,setMonth]=useState(currentMonth);
  const [inputs,setInputs]=useState<Inputs>(empty);
  const [version,setVersion]=useState<number|null>(null);
  const [updatedAt,setUpdatedAt]=useState<string|null>(null);
  const [dirty,setDirty]=useState(false);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{
    setBusy(true);setError("");setNotice("");setVersion(null);setDashboard(null);
    try{
      const [data,budget]=await Promise.all([
        apiRequest<Dashboard>("/dance/dashboard"),
        apiRequest<Plan>("/dance/budget?month="+encodeURIComponent(month))
      ]);
      if(!data.canViewFinancials)
        throw new Error("Для бюджета нужны полные финансовые права");
      setDashboard(data);setVersion(budget.version);setUpdatedAt(budget.updatedAt);
      setInputs(Object.fromEntries(keys.map(k=>
        [k,fromMinor(budget.values[mapping[k]])])) as Inputs);
      setDirty(false);
    }catch(e){
      setError(e instanceof Error?e.message:"Бюджет недоступен");
      setInputs(empty());setUpdatedAt(null);setDirty(false);
    }finally{setBusy(false);}
  },[month]);
  useEffect(()=>{void refresh();},[refresh]);
  async function save(){
    if(busy||version===null)return;
    const values={} as BudgetValues;
    for(const key of keys){
      const v=inputs[key].trim();
      if(v&&!rubles(v) && v!=="0"){
        setError("Проверьте сумму: "+labels[key]);return;
      }
      const minorValue=rubles(v);
      if(minorValue!==null&&minorValue>999999999999999n){
        setError("Сумма слишком велика: "+labels[key]);return;
      }
      values[mapping[key]]=minorValue===null?null:minorValue.toString();
    }
    setBusy(true);setError("");setNotice("");
    try{
      const saved=await apiRequest<{saved:true;version:number}>("/dance/budget",{
        method:"PATCH",
        body:JSON.stringify({month,expectedVersion:version,values})
      });
      setVersion(saved.version);setDirty(false);
      setUpdatedAt(new Date().toISOString());
      setNotice("План сохранён для выбранной компании и месяца. Финансовые проводки не созданы.");
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось сохранить план");
      // Do not overwrite edits on a 409 version conflict.
    }finally{setBusy(false);}
  }
  const calculated=useMemo(()=>{
    const amounts=Object.fromEntries(keys.map(k=>[k,rubles(inputs[k])])) as
      Record<Key,bigint|null>;
    const known=(amounts.rentA??0n)+(amounts.rentB??0n)+
      (amounts.managerSalaries??0n)+(amounts.trainerSalaries??0n)+
      (amounts.taxes??0n)+(amounts.otherExpenses??0n);
    const missing=keys.filter(k=>amounts[k]===null);
    const profit=missing.length===0
      ?amounts.monthlyRevenue!+amounts.subleaseRevenue!-known:null;
    const expected=amounts.monthlyRevenue;
    const cases=expected===null?[]:[
      {label:"Спад, −30%",value:expected*70n/100n},
      {label:"Базовый месяц",value:expected},
      {label:"Высокий сезон, +20%",value:expected*120n/100n}
    ];
    return {known,missing,profit,cases};
  },[inputs]);
  const labels:Record<Key,string>={
    monthlyRevenue:"Плановая выручка от занятий, ₽",
    rentA:"Аренда залов филиала А, ₽",rentB:"Аренда залов филиала Б, ₽",
    managerSalaries:"Оклады менеджеров, ₽",trainerSalaries:"Фонд тренеров, ₽",
    taxes:"Налоги и страховые взносы, ₽",
    otherExpenses:"Коммунальные, реклама, эквайринг и прочие, ₽",
    subleaseRevenue:"Поступления от арендаторов малых залов, ₽"
  };
  return <main className="app-shell">
    <AppSidebar active="dance"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div><p className="dance-owner-kicker">Экономика студии</p>
          <h1>Бюджет, план и сезонность</h1>
          <p>Один сохранённый бюджет компании на месяц. Планы не подменяют
            фактическую кассу, прибыль или бухгалтерские проводки.</p></div>
        <button onClick={()=>void refresh()} disabled={busy||dirty}>
          {busy?"Загружаем…":"Перечитать из CoreBiz"}
        </button>
      </header>
      <DanceWorkspaceNav active="budget"/>
      {error?<p role="alert" className="dance-owner-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      <section className="dance-customer-panel">
        <h2>Месяц планирования</h2>
        <label>Плановый месяц{" "}
          <input type="month" min="2020-01" max="2099-12"
            value={month} disabled={busy||dirty}
            onChange={e=>setMonth(e.target.value)}/></label>
        {dirty?<p role="status">Есть несохранённые изменения. Сохраните план
          либо сбросьте изменения перед сменой месяца.</p>:null}
        <div className="dance-owner-actions">
          <button disabled={busy||version===null||!dirty}
            onClick={()=>void save()}>Сохранить план</button>
          <button disabled={busy||version===null||!dirty}
            onClick={()=>void refresh()}>Сбросить несохранённое</button>
          <button disabled={busy||version===null||dirty}
            onClick={()=>{setInputs(sample());setDirty(true);setNotice(
              "Пример московской студии загружен в форму. Другие расходы оставлены неизвестными."
            );}}>Подставить пример: 2 филиала</button>
        </div>
        {version!==null?<p className="muted">Версия плана: {version}.{" "}
          {updatedAt?"Обновлено: "+new Date(updatedAt).toLocaleString("ru-RU",{
            timeZone:"Europe/Moscow"}):"План ещё не сохраняли."}</p>:null}
      </section>
      <section className="dance-customer-panel">
        <h2>Факт из CoreBiz</h2>
        {month!==currentMonth()?
          <p>Показатели оперативной панели относятся к текущему месяцу.
            Для выбранного исторического месяца используйте бухгалтерскую
            отчётность, чтобы не выдавать текущие данные за архивные.</p>:
          !dashboard?.monthEconomics?
            <p>Финансовые результаты пока отсутствуют или недоступны.
              Нельзя считать прогноз фактом.</p>:
          <div className="dance-customer-metrics">
            <div><small>Реализация услуг</small>
              <strong>{money(BigInt(dashboard.monthEconomics.revenue_minor))}</strong></div>
            <div><small>Начисления тренерам</small>
              <strong>{money(BigInt(dashboard.monthEconomics.trainer_cost_minor))}</strong></div>
            <div><small>Затраты залов в уроках</small>
              <strong>{money(BigInt(dashboard.monthEconomics.room_cost_minor))}</strong></div>
          </div>}
        <p>Суммы отражают только зарегистрированные операции.
          Не учитывайте аренду повторно, если она уже включена в себестоимость.</p>
      </section>
      <section className="dance-customer-panel">
        <h2>Плановые значения</h2>
        <p>Пустое поле означает «неизвестно», а 0 — подтверждённое отсутствие
          расходов или поступлений. Известные суммы не равны чистой прибыли.</p>
        <div className="dance-budget-fields">
          {keys.map(k=><label key={k}>{labels[k]}
            <input inputMode="decimal" value={inputs[k]}
              placeholder="Неизвестно"
              disabled={busy||version===null}
              onChange={e=>{setInputs(prev=>({...prev,[k]:e.target.value}));
                setDirty(true);}}/>
          </label>)}
        </div>
        <p><strong>Сумма введённых расходов:</strong> {money(calculated.known)}.
          Неизвестные статьи в итог не включены.</p>
        <p><strong>Предварительная прибыль:</strong>{" "}
          {calculated.profit===null?"Нельзя рассчитать — есть неизвестные суммы":
            money(calculated.profit)}</p>
        {calculated.missing.length>0?<p className="muted">
          Не заполнено: {calculated.missing.map(k=>labels[k]).join("; ")}.</p>:null}
      </section>
      <section className="dance-customer-panel">
        <h2>Сезонность — сценарии, не прогноз</h2>
        <div className="dance-customer-metrics">{calculated.cases.map(c=>
          <div key={c.label}><small>{c.label}</small>
            <strong>{money(c.value)}</strong></div>)}</div>
      </section>
      <section className="dance-customer-panel">
        <h2>Экономика абонемента: пример</h2>
        <p>Разовое групповое — 2 400 ₽, пакет из 10 занятий — 7 000 ₽
          (700 ₽ за одно занятие), индивидуальное — 3 500 ₽.
          Фактическая выручка определяется проведёнными посещениями,
          а не только полученной предоплатой.</p>
      </section>
    </section>
  </main>;
}
