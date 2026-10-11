"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiRequest } from "../lib/api";

type TaxProfile = {
  id:string;
  entity_kind:"ORGANIZATION"|"IP";
  tax_regime:"USN_INCOME"|"USN_INCOME_EXPENSE"|"OSNO"|"AUSN"|"OTHER";
  vat_mode:"NO_VAT"|"VAT_5"|"VAT_7"|"VAT_22"|"VAT_MIXED";
  has_employees:boolean;
  ens_enabled:boolean;
  reporting_mode:"ASSISTED"|"SEMI_AUTOMATIC"|"EXTERNAL_ACCOUNTANT";
  usn_rate_bps:number|null;
  usn_minimum_tax_bps:number|null;
  oktmo:string|null;
  tax_office_code:string|null;
};

type Obligation = {
  id:string;
  title:string;
  authority:string;
  obligation_type:string;
  due_at:string;
  amount_minor:string|null;
  workflow_status:string;
  calculation_status:string;
  validation_status:string|null;
  signature_status:string|null;
  source_url:string|null;
};

type LedgerItem = {
  id:string;
  recognition_date:string;
  direction:"INCOME"|"EXPENSE";
  amount_minor:string;
  tax_treatment:"INCLUDED"|"EXCLUDED"|"REVIEW_REQUIRED";
  payment_number:string|null;
  party_name:string|null;
  category_code:string|null;
};

type EnsSnapshot = {
  id:string;
  as_of:string;
  balance_minor:string|null;
  source:string;
};

type Props = {
  legalEntityId:string;
  legalEntityName:string;
  inn:string|null;
};

function rub(value:string|number|null|undefined) {
  const numberValue=Number(value??0)/100;
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",
    currency:"RUB",
    maximumFractionDigits:0
  }).format(numberValue);
}

function date(value:string) {
  return new Intl.DateTimeFormat("ru-RU",{
    day:"2-digit",
    month:"short",
    year:"numeric"
  }).format(new Date(value));
}

function daysUntil(value:string) {
  const due=new Date(value).getTime();
  return Math.ceil((due-Date.now())/86400000);
}

function statusLabel(value:string) {
  const labels:Record<string,string>={
    PLANNED:"Запланировано",
    READY:"Готово к проверке",
    APPROVED:"Подтверждено",
    SUBMITTED:"Отправлено",
    ACCEPTED:"Принято",
    REJECTED:"Отклонено",
    PAID:"Оплачено",
    CANCELLED:"Отменено",
    REVIEW_REQUIRED:"Нужно проверить",
    CONFIRMED:"Расчёт подтверждён",
    NOT_CALCULATED:"Не рассчитано",
    CALCULATED:"Рассчитано"
  };
  return labels[value]??value;
}

export function AccountingComplianceCenter({
  legalEntityId,
  legalEntityName,
  inn
}:Props) {
  const [profile,setProfile]=useState<TaxProfile|null>(null);
  const [obligations,setObligations]=useState<Obligation[]>([]);
  const [ledger,setLedger]=useState<LedgerItem[]>([]);
  const [ens,setEns]=useState<EnsSnapshot[]>([]);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [showProfile,setShowProfile]=useState(false);

  const load=useCallback(async()=>{
    if(!legalEntityId) return;
    setBusy(true);
    setError("");
    try{
      const horizon=new Date();
      horizon.setMonth(horizon.getMonth()+12);
      const from=new Date();
      from.setMonth(from.getMonth()-1);

      const [profileRow,obligationRows,ledgerRows,ensRows]=await Promise.all([
        apiRequest<TaxProfile|null>(
          "/accounting/compliance/profile?legalEntityId="+
          encodeURIComponent(legalEntityId)
        ),
        apiRequest<Obligation[]>(
          "/accounting/compliance/obligations?legalEntityId="+
          encodeURIComponent(legalEntityId)+
          "&from="+encodeURIComponent(from.toISOString())+
          "&to="+encodeURIComponent(horizon.toISOString())
        ),
        apiRequest<LedgerItem[]>(
          "/accounting/compliance/tax-ledger?legalEntityId="+
          encodeURIComponent(legalEntityId)
        ),
        apiRequest<EnsSnapshot[]>(
          "/accounting/compliance/ens?legalEntityId="+
          encodeURIComponent(legalEntityId)
        )
      ]);
      setProfile(profileRow);
      setObligations(obligationRows);
      setLedger(ledgerRows);
      setEns(ensRows);
      if(!profileRow) setShowProfile(true);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить налоговый центр");
    }finally{
      setBusy(false);
    }
  },[legalEntityId]);

  useEffect(()=>{ void load(); },[load]);

  const active=useMemo(
    ()=>obligations.filter(item=>
      !["ACCEPTED","PAID","CANCELLED"].includes(item.workflow_status)
    ),
    [obligations]
  );
  const urgent=useMemo(
    ()=>active.filter(item=>daysUntil(item.due_at)<=7),
    [active]
  );
  const next=active[0]??null;
  const reviewCount=ledger.filter(
    item=>item.tax_treatment==="REVIEW_REQUIRED"
  ).length;
  const ensLatest=ens[0]??null;

  async function configureProfile() {
    const entityKind=(window.prompt(
      "Тип: ORGANIZATION или IP",
      profile?.entity_kind??"ORGANIZATION"
    )??"").trim().toUpperCase();
    if(!["ORGANIZATION","IP"].includes(entityKind)) return;

    const taxRegime=(window.prompt(
      "Режим: USN_INCOME, USN_INCOME_EXPENSE, OSNO, AUSN или OTHER",
      profile?.tax_regime??"USN_INCOME"
    )??"").trim().toUpperCase();
    if(![
      "USN_INCOME","USN_INCOME_EXPENSE","OSNO","AUSN","OTHER"
    ].includes(taxRegime)) return;

    const vatMode=(window.prompt(
      "НДС: NO_VAT, VAT_5, VAT_7, VAT_22 или VAT_MIXED",
      profile?.vat_mode??"NO_VAT"
    )??"NO_VAT").trim().toUpperCase();

    const hasEmployees=window.confirm("Есть сотрудники, по которым компания является налоговым агентом?");
    let usnRateBps:number|null=null;
    let usnMinimumTaxBps:number|null=null;

    if(taxRegime.startsWith("USN_")){
      const rate=window.prompt(
        "Ставка УСН в базисных пунктах. Например 6% = 600. Проверьте ставку для своего региона.",
        String(profile?.usn_rate_bps??(taxRegime==="USN_INCOME"?600:1500))
      );
      if(rate&&/^\d+$/.test(rate)) usnRateBps=Number(rate);

      if(taxRegime==="USN_INCOME_EXPENSE"){
        const minimum=window.prompt(
          "Ставка минимального налога в базисных пунктах. Например 1% = 100.",
          String(profile?.usn_minimum_tax_bps??100)
        );
        if(minimum&&/^\d+$/.test(minimum)) usnMinimumTaxBps=Number(minimum);
      }
    }

    setBusy(true);
    setError("");
    try{
      await apiRequest("/accounting/compliance/profile",{
        method:"POST",
        body:JSON.stringify({
          legalEntityId,
          entityKind,
          taxRegime,
          vatMode,
          hasEmployees,
          ensEnabled:true,
          reportingMode:"ASSISTED",
          riskTolerance:"CONSERVATIVE",
          usnRateBps,
          usnMinimumTaxBps
        })
      });
      setNotice("Налоговый профиль сохранён");
      setShowProfile(false);
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось сохранить налоговый профиль");
    }finally{
      setBusy(false);
    }
  }

  async function generateCalendar() {
    const start=new Date();
    const end=new Date();
    end.setMonth(end.getMonth()+12);
    setBusy(true);
    try{
      await apiRequest("/accounting/compliance/calendar/generate",{
        method:"POST",
        body:JSON.stringify({
          legalEntityId,
          from:start.toISOString().slice(0,10),
          to:end.toISOString().slice(0,10)
        })
      });
      setNotice("Налоговый календарь обновлён на 12 месяцев");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось обновить календарь");
    }finally{
      setBusy(false);
    }
  }

  async function syncLedger() {
    setBusy(true);
    try{
      const result=await apiRequest<{added:number}>(
        "/accounting/compliance/tax-ledger/sync",
        {
          method:"POST",
          body:JSON.stringify({legalEntityId})
        }
      );
      setNotice(
        result.added
          ? "Добавлено движений в налоговую книгу: "+result.added
          :"Новых движений нет"
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось обновить налоговую книгу");
    }finally{
      setBusy(false);
    }
  }

  async function reviewLedger(
    item:LedgerItem,
    treatment:"INCLUDED"|"EXCLUDED"
  ) {
    const reason=window.prompt(
      treatment==="INCLUDED"
        ?"Почему движение учитывается для налога?"
        :"Почему движение исключается из налоговой базы?",
      treatment==="INCLUDED"
        ?"Подтверждено первичными документами"
        :"Не относится к налоговой базе"
    );
    if(!reason?.trim()) return;
    try{
      await apiRequest(
        "/accounting/compliance/tax-ledger/"+item.id+"/review",
        {
          method:"POST",
          body:JSON.stringify({treatment,reason:reason.trim()})
        }
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось подтвердить движение");
    }
  }

  async function preparePacket(item:Obligation) {
    try{
      await apiRequest(
        "/accounting/compliance/obligations/"+item.id+"/packet",
        {method:"POST",body:"{}"}
      );
      setNotice("Пакет подготовлен. Перед отправкой его нужно проверить.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось подготовить пакет");
    }
  }

  return (
    <div className="compliance-center">
      <section className="compliance-hero">
        <div>
          <span className="compliance-eyebrow">Налоговый центр</span>
          <h2>Что нужно сделать и когда</h2>
          <p>
            CoreBiz собирает движения, формирует календарь и готовит пакет.
            Перед юридически значимой отправкой система требует проверку и подтверждение.
          </p>
        </div>
        <div className="compliance-hero-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={()=>setShowProfile(value=>!value)}
          >
            {profile?"Настройки налогов":"Настроить налоги"}
          </button>
          <button
            type="button"
            disabled={busy||!profile}
            onClick={()=>void generateCalendar()}
          >
            Обновить календарь
          </button>
        </div>
      </section>

      {error?(
        <div className="inline-error">
          <strong>Налоговый центр</strong>
          <span>{error}</span>
        </div>
      ):null}
      {notice?(
        <div className="compliance-notice">
          <strong>Готово</strong>
          <span>{notice}</span>
        </div>
      ):null}

      {showProfile?(
        <section className="compliance-setup-card">
          <div>
            <span className="compliance-step">1</span>
            <div>
              <strong>Укажите налоговый режим компании</strong>
              <p>
                {legalEntityName} · ИНН {inn??"не указан"}.
                Ставки УСН подтверждаются отдельно, потому что они могут зависеть от региона.
              </p>
            </div>
          </div>
          <button type="button" onClick={()=>void configureProfile()}>
            Настроить за 2 минуты
          </button>
        </section>
      ):null}

      <div className="compliance-kpis">
        <article>
          <span>Ближайший срок</span>
          <strong>{next?date(next.due_at):"Нет задач"}</strong>
          <small>
            {next
              ?daysUntil(next.due_at)<0
                ?"Срок уже прошёл"
                :daysUntil(next.due_at)+" дн."
              :"Календарь чист"}
          </small>
        </article>
        <article className={urgent.length?"attention":""}>
          <span>На 7 дней</span>
          <strong>{urgent.length}</strong>
          <small>{urgent.length?"нужны действия":"ничего срочного"}</small>
        </article>
        <article className={reviewCount?"attention":""}>
          <span>Проверить в налоговой книге</span>
          <strong>{reviewCount}</strong>
          <small>спорных движений</small>
        </article>
        <article>
          <span>ЕНС</span>
          <strong>
            {ensLatest?.balance_minor!==null&&ensLatest
              ?rub(ensLatest.balance_minor)
              :"Нет данных"}
          </strong>
          <small>
            {ensLatest?"на "+date(ensLatest.as_of):"добавьте снимок из ФНС/оператора"}
          </small>
        </article>
      </div>

      <section className="compliance-next-card">
        <div className="section-heading">
          <div>
            <p className="muted">Приоритет</p>
            <h3>{next?.title??"На ближайший период обязательств нет"}</h3>
          </div>
          {next?(
            <span className={"status-pill compliance-status "+next.workflow_status.toLowerCase()}>
              {statusLabel(next.workflow_status)}
            </span>
          ):null}
        </div>

        {next?(
          <div className="compliance-next-body">
            <div className="compliance-deadline">
              <span>Срок</span>
              <strong>{date(next.due_at)}</strong>
            </div>
            <div>
              <span>Что сделать</span>
              <strong>
                {next.obligation_type==="PAY"
                  ?"Проверить сумму и оплатить"
                  :next.obligation_type==="NOTIFY"
                    ?"Проверить уведомление и отправить"
                    :"Проверить и отправить отчёт"}
              </strong>
              <p>
                Расчёт: {statusLabel(next.calculation_status)}.
                {next.amount_minor!==null?" Сумма "+rub(next.amount_minor)+".":""}
              </p>
            </div>
            <div className="table-actions">
              {["PLANNED","REJECTED"].includes(next.workflow_status)?(
                <button type="button" onClick={()=>void preparePacket(next)}>
                  Подготовить
                </button>
              ):null}
              {next.source_url?(
                <a
                  className="button-link secondary"
                  href={next.source_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Основание ФНС
                </a>
              ):null}
            </div>
          </div>
        ):(
          <p className="workspace-summary">
            Настройте профиль и обновите календарь. CoreBiz покажет обязательства на год вперёд.
          </p>
        )}
      </section>

      <div className="compliance-grid">
        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Налоговая книга</p>
              <h3>Доходы и расходы для расчёта</h3>
            </div>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={()=>void syncLedger()}
            >
              Собрать из финансов
            </button>
          </div>

          <div className="compliance-ledger-list">
            {ledger.slice(0,10).map(item=>(
              <article key={item.id}>
                <div>
                  <small>{item.recognition_date} · {item.payment_number??"движение"}</small>
                  <strong>{item.party_name??item.category_code??item.direction}</strong>
                  <span>
                    {item.direction==="INCOME"?"Доход":"Расход"} · {rub(item.amount_minor)}
                  </span>
                </div>
                <div className="compliance-ledger-action">
                  <span className={"status-pill "+item.tax_treatment.toLowerCase()}>
                    {item.tax_treatment==="REVIEW_REQUIRED"
                      ?"Проверить"
                      :item.tax_treatment==="INCLUDED"
                        ?"Учтено"
                        :"Исключено"}
                  </span>
                  {item.tax_treatment==="REVIEW_REQUIRED"?(
                    <div className="table-actions">
                      <button
                        type="button"
                        onClick={()=>void reviewLedger(item,"INCLUDED")}
                      >
                        Учесть
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={()=>void reviewLedger(item,"EXCLUDED")}
                      >
                        Исключить
                      </button>
                    </div>
                  ):null}
                </div>
              </article>
            ))}
            {!ledger.length?(
              <div className="table-empty">
                <strong>Налоговая книга пока пустая</strong>
                <span>
                  Привяжите банковский/кассовый счёт к юрлицу и нажмите
                  «Собрать из финансов».
                </span>
              </div>
            ):null}
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Календарь</p>
              <h3>Ближайшие обязательства</h3>
            </div>
          </div>
          <div className="compliance-timeline">
            {active.slice(0,8).map(item=>(
              <article key={item.id}>
                <div className="compliance-date-badge">
                  <strong>
                    {new Date(item.due_at).toLocaleDateString("ru-RU",{day:"2-digit"})}
                  </strong>
                  <span>
                    {new Date(item.due_at).toLocaleDateString("ru-RU",{month:"short"})}
                  </span>
                </div>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.authority} · {statusLabel(item.workflow_status)}
                  </span>
                </div>
                {daysUntil(item.due_at)<=7?(
                  <span className="compliance-urgent">Скоро</span>
                ):null}
              </article>
            ))}
          </div>
        </section>
      </div>

      <p className="compliance-disclaimer">
        Расчёты в налоговом центре являются предварительными до подтверждения.
        Отправка отчётности должна подтверждаться квалифицированной подписью и
        квитанцией оператора/ФНС. CoreBiz хранит нормативный источник и версию
        правила для каждой обязанности.
      </p>
    </div>
  );
}
