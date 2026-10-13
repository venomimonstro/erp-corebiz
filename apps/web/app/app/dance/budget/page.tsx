"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {DanceWorkspaceNav} from "../../../../components/dance-workspace-nav";
import {apiRequest} from "../../../../lib/api";

type Month={revenue_minor:string;trainer_cost_minor:string;
  room_cost_minor:string;other_cost_minor:string;owner_margin_minor:string};
type Dashboard={canViewFinancials:boolean;monthEconomics:Month|null};
const defaultFields={
  monthlyRevenue:"3000000",
  rentA:"700000",rentB:"",
  managerSalaries:"100000",trainerSalaries:"",
  taxes:"",otherExpenses:"",subleaseRevenue:""
};
const money=(n:bigint)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB",maximumFractionDigits:0
}).format(Number(n)/100);
const rubles=(input:string):bigint|null=>{
  const value=input.trim().replace(",",".");
  if(!value)return null;
  if(!/^\d{1,12}(?:\.\d{1,2})?$/.test(value))return null;
  const [whole,fract=""]=value.split(".");
  return BigInt(whole)*100n+BigInt(fract.padEnd(2,"0"));
};
export default function DanceBudgetPage(){
  const [inputs,setInputs]=useState(defaultFields);
  const [dashboard,setDashboard]=useState<Dashboard|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{
    setBusy(true);setError("");
    try{
      const data=await apiRequest<Dashboard>("/dance/dashboard");
      if(!data.canViewFinancials)throw new Error("Для финансов студии нужны права владельца");
      setDashboard(data);
    }catch(e){setDashboard(null);setError(e instanceof Error?e.message:"Недоступно");}
    finally{setBusy(false);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  const calculated=useMemo(()=>{
    const amounts=Object.fromEntries(
      Object.entries(inputs).map(([k,v])=>[k,rubles(v)])
    ) as Record<keyof typeof inputs,bigint|null>;
    const known=(amounts.rentA??0n)+(amounts.managerSalaries??0n);
    const full=[
      "monthlyRevenue","rentA","rentB","managerSalaries",
      "trainerSalaries","taxes","otherExpenses","subleaseRevenue"
    ] as const;
    const missing=full.filter(k=>amounts[k]===null);
    const profit=missing.length===0
      ?(amounts.monthlyRevenue!+amounts.subleaseRevenue!)-
       (amounts.rentA!+amounts.rentB!+amounts.managerSalaries!+
        amounts.trainerSalaries!+amounts.taxes!+amounts.otherExpenses!)
      :null;
    const expected=amounts.monthlyRevenue;
    const cases=expected===null?[]:[
      {label:"Спад, −30%",value:expected*70n/100n},
      {label:"Базовый месяц",value:expected},
      {label:"Высокий сезон, +20%",value:expected*120n/100n}
    ];
    return {known,missing,profit,cases,amounts};
  },[inputs]);
  const labels:Record<keyof typeof defaultFields,string>={
    monthlyRevenue:"Плановый месячный доход, ₽",
    rentA:"Аренда трёх залов филиала А, ₽",
    rentB:"Аренда филиала Б, ₽",
    managerSalaries:"Два менеджера (без начислений), ₽",
    trainerSalaries:"Фонд оплаты труда тренеров, ₽",
    taxes:"Налоги и обязательные взносы, ₽",
    otherExpenses:"Коммунальные, реклама, эквайринг, прочие, ₽",
    subleaseRevenue:"Выручка от сдачи малых залов, ₽"
  };
  return <main className="app-shell">
    <AppSidebar active="dance"/>
    <section className="workspace workspace-wide">
      <header className="dance-owner-heading">
        <div><p className="dance-owner-kicker">Экономика студии</p>
          <h1>План и сезонность</h1>
          <p>Контроль двух филиалов. Плановые предположения отдельно от
            реально проведённых денег и расходов бухгалтерии.</p>
        </div>
        <button onClick={()=>void refresh()} disabled={busy}>
          {busy?"Загружаем…":"Обновить факт"}
        </button>
      </header>
      <DanceWorkspaceNav active="budget"/>
      {error?<p role="alert" className="dance-owner-error">{error}</p>:null}
      <section className="dance-customer-panel">
        <h2>Факт из CoreBiz</h2>
        {!dashboard?.monthEconomics?<p>Закрытые финансовые результаты
          пока отсутствуют или недоступны. Нельзя считать прогноз фактом.</p>:
          <div className="dance-customer-metrics">
            <div><small>Реализация услуг</small>
              <strong>{money(BigInt(dashboard.monthEconomics.revenue_minor))}</strong></div>
            <div><small>Начисления тренерам</small>
              <strong>{money(BigInt(dashboard.monthEconomics.trainer_cost_minor))}</strong></div>
            <div><small>Затраты залов, учтённые в уроках</small>
              <strong>{money(BigInt(dashboard.monthEconomics.room_cost_minor))}</strong></div>
          </div>}
        <p>Фактические суммы включают только проводки, отражённые в системе.
          Не добавляйте аренду второй раз к уже учтённым затратам уроков.</p>
      </section>
      <section className="dance-customer-panel">
        <h2>Плановые предположения владельца</h2>
        <p>Из ваших исходных данных известны аренда филиала А и оклады менеджеров.
          Расходы второго филиала, фонд тренеров и налоги оставлены пустыми
          намеренно: без них чистая прибыль не подтверждена.</p>
        <div className="dance-budget-fields">
          {(Object.keys(inputs) as Array<keyof typeof inputs>).map(k=>
            <label key={k}>{labels[k]}
              <input inputMode="decimal" value={inputs[k]}
                placeholder="Неизвестно — укажите факт/план"
                onChange={e=>setInputs(prev=>({...prev,[k]:e.target.value}))}/>
            </label>)}
        </div>
        <p><strong>Известные постоянные расходы:</strong>{" "}
          {money(calculated.known)} — только аренда первого филиала и оклады
          менеджеров, без страховых взносов и прочих расходов.</p>
        <p><strong>Расчётная прибыль:</strong>{" "}
          {calculated.profit===null?"Не определена — заполните все расходы":
            money(calculated.profit)}</p>
        {calculated.missing.length>0?<p className="muted">
          Не заполнено: {calculated.missing.map(k=>labels[k]).join("; ")}.</p>:null}
      </section>
      <section className="dance-customer-panel">
        <h2>Сезонность: чувствительность выручки</h2>
        <p>Это примеры сценариев, не прогноз спроса. Реальные коэффициенты
          требуется определить по прошлым периодам студии.</p>
        <div className="dance-customer-metrics">{calculated.cases.map(item=>
          <div key={item.label}><small>{item.label}</small>
            <strong>{money(item.value)}</strong></div>)}</div>
      </section>
      <section className="dance-customer-panel">
        <h2>Стоимость одного посещения</h2>
        <p>Разовое групповое занятие: 2 400 ₽. Абонемент на 10 занятий:
          7 000 ₽, или <strong>700 ₽ за посещение</strong> при полном использовании.
          Индивидуальное занятие: 3 500 ₽.</p>
        <p>Продажа абонемента за 7 000 ₽ увеличивает денежные поступления,
          но не означает немедленную реализацию десяти посещений.
          Остаток занятий — обязательство перед клиентом.</p>
      </section>
    </section>
  </main>;
}
