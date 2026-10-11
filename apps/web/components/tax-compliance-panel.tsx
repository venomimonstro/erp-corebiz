"use client";

import { useCallback,useEffect,useState } from "react";
import { apiRequest } from "../lib/api";

type Profile={
  id:string;
  entity_kind:"ORGANIZATION"|"IP";
  tax_regime:string;
  vat_mode:string;
  has_employees:boolean;
  usn_rate_bps:number|null;
};

type Obligation={
  id:string;
  authority:string;
  obligation_type:string;
  code:string;
  title:string;
  period_key:string;
  due_at:string;
  amount_minor:string|null;
  calculation_status:string;
  workflow_status:string;
  form_code:string|null;
  packet_id:string|null;
  validation_status:string|null;
  signature_status:string|null;
};

type Calculation={
  id:string;
  tax_code:string;
  period_key:string;
  taxable_income_minor:string;
  deductible_expense_minor:string;
  tax_due_minor:string;
  status:string;
};

type TaxOperation={
  id:string;
  payment_id:string;
  business_number:string;
  posted_at:string;
  direction:"IN"|"OUT";
  kind:string;
  amount_minor:string;
  currency:string;
  category_name:string|null;
  treatment:string;
  source:string;
  confidence:number;
  reason:string|null;
};

type Dashboard={
  profile:Profile|null;
  counts:{
    overdue:number;
    next_14_days:number;
    review_required:number;
    rejected:number;
  };
  obligations:Obligation[];
  calculations:Calculation[];
  ens:null|{
    snapshot_at:string;
    balance_minor:string;
    upcoming_minor:string;
    overdue_minor:string;
    source:string;
  };
  connectors:Array<{id:string;provider:string;status:string}>;
  ytdTaxableIncomeMinor:string;
  alerts:Array<{
    code:string;
    severity:"INFO"|"WARNING"|"CRITICAL";
    title:string;
    detail:string;
  }>;
};

function rub(value:string|null|undefined){
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",
    currency:"RUB",
    maximumFractionDigits:0
  }).format(Number(value??"0")/100);
}

export function TaxCompliancePanel({
  legalEntityId
}:{legalEntityId:string}){
  const [data,setData]=useState<Dashboard|null>(null);
  const [operations,setOperations]=useState<TaxOperation[]>([]);
  const [regime,setRegime]=useState("USN_INCOME");
  const [vat,setVat]=useState("NO_VAT");
  const [kind,setKind]=useState<"ORGANIZATION"|"IP">("ORGANIZATION");
  const [employees,setEmployees]=useState(false);
  const [usnRate,setUsnRate]=useState("6");
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");

  const load=useCallback(async()=>{
    if(!legalEntityId)return;
    setBusy(true);
    setError("");
    try{
      const [result,operationRows]=await Promise.all([
        apiRequest<Dashboard>(
          "/accounting/tax/dashboard?legalEntityId="+encodeURIComponent(legalEntityId)
        ),
        apiRequest<TaxOperation[]>(
          "/accounting/tax/payments/classifications?legalEntityId="+
          encodeURIComponent(legalEntityId)
        )
      ]);
      setData(result);
      setOperations(operationRows);
      if(result.profile){
        setRegime(result.profile.tax_regime);
        setVat(result.profile.vat_mode);
        setKind(result.profile.entity_kind);
        setEmployees(result.profile.has_employees);
        if(result.profile.usn_rate_bps!==null){
          setUsnRate(String(result.profile.usn_rate_bps/100));
        }
      }
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить налоги");
    }finally{
      setBusy(false);
    }
  },[legalEntityId]);

  useEffect(()=>{void load();},[load]);

  async function saveProfile(){
    setMessage("");
    try{
      await apiRequest("/accounting/tax/profile",{
        method:"POST",
        body:JSON.stringify({
          legalEntityId,
          entityKind:kind,
          taxRegime:regime,
          vatMode:vat,
          hasEmployees:employees,
          usnRateBps:regime.startsWith("USN")
            ?Math.round(Number(usnRate.replace(",","."))*100)
            :undefined,
          reportingMode:"SEMI_AUTOMATIC"
        })
      });
      setMessage("Налоговый профиль сохранён");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось сохранить профиль");
    }
  }

  async function calendar(){
    try{
      const result=await apiRequest<{created:number}>(
        "/accounting/tax/calendar/generate",
        {
          method:"POST",
          body:JSON.stringify({
            legalEntityId,
            year:new Date().getUTCFullYear()
          })
        }
      );
      setMessage("Календарь обновлён · добавлено "+result.created);
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось обновить календарь");
    }
  }

  async function classify(){
    try{
      const result=await apiRequest<{
        classified:number;
        reviewRequired:number;
      }>("/accounting/tax/payments/auto-classify",{
        method:"POST",
        body:JSON.stringify({legalEntityId})
      });
      setMessage(
        "Проверено операций: "+result.classified+
        " · требуют решения: "+result.reviewRequired
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось проверить операции");
    }
  }

  async function prepareObligation(obligationId:string){
    try{
      await apiRequest(
        "/accounting/compliance/obligations/"+
        encodeURIComponent(obligationId)+"/packet",
        {method:"POST"}
      );
      setMessage("Пакет подготовлен и поставлен на проверку");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось подготовить пакет"
      );
    }
  }

  async function decideOperation(
    paymentId:string,
    treatment:"TAXABLE_INCOME"|"DEDUCTIBLE_EXPENSE"|"NON_DEDUCTIBLE_EXPENSE"|"EXCLUDED"
  ){
    try{
      await apiRequest(
        "/accounting/tax/payments/"+encodeURIComponent(paymentId)+"/classification",
        {
          method:"PATCH",
          body:JSON.stringify({
            legalEntityId,
            treatment,
            reason:"Подтверждено владельцем в налоговом помощнике CoreBiz"
          })
        }
      );
      setMessage("Операция классифицирована");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось сохранить решение"
      );
    }
  }

  async function calculate(){
    const year=new Date().getUTCFullYear();
    try{
      const result=await apiRequest<Calculation>(
        "/accounting/tax/calculations/usn",
        {
          method:"POST",
          body:JSON.stringify({
            legalEntityId,
            periodKey:year+"-YTD",
            dateFrom:year+"-01-01",
            dateTo:new Date().toISOString().slice(0,10),
            advancesMinor:"0"
          })
        }
      );
      setMessage("Предварительно к уплате: "+rub(result.tax_due_minor));
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось рассчитать УСН");
    }
  }

  return <div className="tax-workspace">
    <section className="tax-command-center">
      <div>
        <span className="tax-eyebrow">Налоговый помощник</span>
        <h2>Сдать вовремя. Заплатить правильно. Ничего не забыть.</h2>
        <p>
          CoreBiz собирает факты из денег, НДС и зарплаты. Спорные операции
          не принимаются в расходы автоматически и остаются на проверку.
        </p>
      </div>
      <div className="tax-command-actions">
        <button disabled={busy} onClick={()=>void calendar()}>Обновить календарь</button>
        <button className="secondary-button" disabled={busy} onClick={()=>void classify()}>
          Проверить операции
        </button>
        {data?.profile?.tax_regime.startsWith("USN")
          ?<button className="secondary-button" disabled={busy} onClick={()=>void calculate()}>
             Пересчитать УСН
           </button>
          :null}
      </div>
    </section>

    {error?<div className="inline-error"><strong>Налоги</strong><span>{error}</span></div>:null}
    {message?<div className="tax-success">{message}</div>:null}

    {(data?.alerts??[]).length?<div className="tax-alert-stack">
      {(data?.alerts??[]).map(alert=>
        <article
          className={"tax-alert "+alert.severity.toLowerCase()}
          key={alert.code}
        >
          <span>{alert.severity==="CRITICAL"?"!":"i"}</span>
          <div>
            <strong>{alert.title}</strong>
            <small>{alert.detail}</small>
          </div>
        </article>
      )}
    </div>:null}

    <div className="owner-kpi-grid tax-kpi-grid">
      <article className={"owner-kpi tax-kpi "+((data?.counts.overdue??0)>0?"danger":"")}>
        <span>Просрочено</span>
        <strong>{data?.counts.overdue??0}</strong>
        <small>нужно сделать сейчас</small>
      </article>
      <article className="owner-kpi tax-kpi">
        <span>Доход в налоговой книге</span>
        <strong>{rub(data?.ytdTaxableIncomeMinor)}</strong>
        <small>с начала года · после классификации</small>
      </article>
      <article className="owner-kpi tax-kpi">
        <span>Нужно проверить</span>
        <strong>{data?.counts.review_required??0}</strong>
        <small>система не решает спорное сама</small>
      </article>
      <article className="owner-kpi tax-kpi">
        <span>ЕНС</span>
        <strong>{data?.ens?rub(data.ens.balance_minor):"—"}</strong>
        <small>{data?.ens?"последняя сверка "+new Date(data.ens.snapshot_at).toLocaleDateString("ru-RU"):"сверка не загружена"}</small>
      </article>
    </div>

    <section className="section-block tax-profile-card">
      <div className="section-heading">
        <div><p className="muted">Настройка один раз</p><h2>Как компания платит налоги</h2></div>
        <span className="tax-safety-chip">Полуавтоматически</span>
      </div>
      <div className="tax-profile-grid">
        <label><span>Тип</span><select value={kind} onChange={e=>setKind(e.target.value as "ORGANIZATION"|"IP")}>
          <option value="ORGANIZATION">Организация</option><option value="IP">ИП</option>
        </select></label>
        <label><span>Режим</span><select value={regime} onChange={e=>setRegime(e.target.value)}>
          <option value="USN_INCOME">УСН · Доходы</option>
          <option value="USN_INCOME_EXPENSE">УСН · Доходы минус расходы</option>
          <option value="OSNO">ОСНО</option><option value="AUSN">АУСН</option>
          <option value="OTHER">Другой</option>
        </select></label>
        <label><span>НДС</span><select value={vat} onChange={e=>setVat(e.target.value)}>
          <option value="NO_VAT">Освобождение / без НДС</option>
          <option value="VAT_5">5%</option><option value="VAT_7">7%</option>
          <option value="VAT_22">22%</option><option value="VAT_MIXED">Смешанный</option>
        </select></label>
        {regime.startsWith("USN")?<label>
          <span>Ставка УСН, %</span>
          <input
            inputMode="decimal"
            value={usnRate}
            onChange={e=>setUsnRate(e.target.value)}
            placeholder={regime==="USN_INCOME"?"6":"15"}
          />
        </label>:null}
        <label className="tax-check">
          <input type="checkbox" checked={employees} onChange={e=>setEmployees(e.target.checked)}/>
          <span>Есть сотрудники</span>
        </label>
      </div>
      <div className="tax-profile-footer">
        <span>{data?.profile?"Профиль действует и версионируется по дате.":"Без профиля расчёты не выполняются."}</span>
        <button onClick={()=>void saveProfile()}>
          {data?.profile?"Сохранить изменения":"Настроить бухгалтерию"}
        </button>
      </div>
    </section>

    <section className="section-block">
      <div className="section-heading">
        <div><p className="muted">Налоговый календарь</p><h2>Что и когда сделать</h2></div>
        <span className="tax-safety-chip">
          {data?.connectors.some(x=>x.status==="VERIFIED")?"Оператор подключён":"Отправка после подключения оператора"}
        </span>
      </div>
      <div className="tax-obligation-list">
        {(data?.obligations??[]).slice(0,20).map(item=>{
          const late=new Date(item.due_at).getTime()<Date.now()&&
            !["ACCEPTED","PAID","CANCELLED"].includes(item.workflow_status);
          return <article className={"tax-obligation "+(late?"late":"")} key={item.id}>
            <div className="tax-date">
              <strong>{new Date(item.due_at).toLocaleDateString("ru-RU",{day:"2-digit",month:"short"})}</strong>
              <span>{item.period_key}</span>
            </div>
            <div className="tax-obligation-main">
              <small>{item.authority} · {item.obligation_type}</small>
              <strong>{item.title}</strong>
              <span>{item.form_code??item.code}</span>
            </div>
            <div className="tax-obligation-status">
              <span className="status-pill">
                {late?"Просрочено":item.workflow_status}
              </span>
              {item.amount_minor?<strong>{rub(item.amount_minor)}</strong>:null}
              {item.packet_id?
                <small>
                  Пакет · {item.validation_status??"черновик"} · {
                    item.signature_status??"без подписи"
                  }
                </small>:
                ["PLANNED","REJECTED"].includes(item.workflow_status)?
                  <button
                    className="secondary-button"
                    onClick={()=>void prepareObligation(item.id)}
                  >
                    Подготовить пакет
                  </button>
                  :null}
            </div>
          </article>;
        })}
        {!data?.obligations.length?<div className="table-empty">
          <strong>Календарь ещё не создан</strong>
          <span>Настройте профиль и нажмите «Обновить календарь».</span>
        </div>:null}
      </div>
    </section>

    <section className="section-block">
      <div className="section-heading">
        <div>
          <p className="muted">Контроль налоговой базы</p>
          <h2>Операции, которые нужно разобрать</h2>
        </div>
        <span className="tax-safety-chip">
          {(operations.filter(x=>x.treatment==="REVIEW_REQUIRED").length)} требуют решения
        </span>
      </div>
      <div className="tax-review-list">
        {operations.filter(x=>x.treatment==="REVIEW_REQUIRED").slice(0,12).map(op=>
          <article className="tax-review-row" key={op.id}>
            <div className="tax-review-money">
              <strong>{rub(op.amount_minor)}</strong>
              <span>{new Date(op.posted_at).toLocaleDateString("ru-RU")}</span>
            </div>
            <div className="tax-review-copy">
              <small>{op.business_number} · {op.category_name??"Без категории"}</small>
              <strong>
                {op.direction==="IN"?"Поступление":"Списание"} требует проверки
              </strong>
              <span>{op.reason??"Система не нашла безопасного налогового правила."}</span>
            </div>
            <div className="tax-review-actions">
              {op.direction==="IN"?
                <button onClick={()=>void decideOperation(op.payment_id,"TAXABLE_INCOME")}>
                  Доход
                </button>:
                <>
                  <button onClick={()=>void decideOperation(op.payment_id,"DEDUCTIBLE_EXPENSE")}>
                    Принять расход
                  </button>
                  <button
                    className="secondary-button"
                    onClick={()=>void decideOperation(op.payment_id,"NON_DEDUCTIBLE_EXPENSE")}
                  >
                    Не принимать
                  </button>
                </>
              }
              <button
                className="secondary-button"
                onClick={()=>void decideOperation(op.payment_id,"EXCLUDED")}
              >
                Не учитывать
              </button>
            </div>
          </article>
        )}
        {!operations.some(x=>x.treatment==="REVIEW_REQUIRED")?
          <div className="tax-review-clear">
            <span>✓</span>
            <div>
              <strong>Спорных операций сейчас нет</strong>
              <small>Налоговая база собрана только из классифицированных операций.</small>
            </div>
          </div>:null}
      </div>
    </section>

    <section className="section-block">
      <div className="section-heading">
        <div><p className="muted">Предварительный расчёт</p><h2>Сколько налогов получается</h2></div>
      </div>
      <div className="tax-calculation-grid">
        {(data?.calculations??[]).map(calc=><article className="tax-calc-card" key={calc.id}>
          <div><small>{calc.tax_code} · {calc.period_key}</small><strong>{rub(calc.tax_due_minor)}</strong></div>
          <span className="status-pill">{calc.status}</span>
          <dl>
            <div><dt>Доход</dt><dd>{rub(calc.taxable_income_minor)}</dd></div>
            <div><dt>Расход принят</dt><dd>{rub(calc.deductible_expense_minor)}</dd></div>
          </dl>
        </article>)}
        {!data?.calculations.length?<div className="tax-empty-card">
          <strong>Расчётов пока нет</strong>
          <span>Проверьте операции и запустите предварительный расчёт.</span>
        </div>:null}
      </div>
    </section>
  </div>;
}
