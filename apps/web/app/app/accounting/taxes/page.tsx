"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type LegalEntity={
  id:string;
  name:string;
  inn:string|null;
};

type Organization={
  legalEntities:LegalEntity[];
};

type TaxProfile={
  id:string;
  entity_kind:"ORGANIZATION"|"IP"|"INDIVIDUAL";
  tax_regime:"NPD"|"USN_INCOME"|"USN_INCOME_EXPENSE"|"OSNO"|"AUSN"|"OTHER";
  vat_mode:"NO_VAT"|"VAT_5"|"VAT_7"|"VAT_22"|"VAT_MIXED";
  has_employees:boolean;
  ens_enabled:boolean;
  reporting_mode:"ASSISTED"|"SEMI_AUTOMATIC"|"EXTERNAL_ACCOUNTANT";
  risk_tolerance:"CONSERVATIVE"|"STANDARD";
  compliance_enabled:boolean;
  compliance_disabled_reason:string|null;
  kpp:string|null;
  oktmo:string|null;
  tax_office_code:string|null;
};

type Obligation={
  id:string;
  authority:string;
  obligation_type:"FILE"|"PAY"|"NOTIFY"|"RECONCILE";
  code:string;
  title:string;
  period_key:string;
  due_at:string;
  amount_minor:string|null;
  currency:string;
  calculation_status:string;
  workflow_status:string;
  form_code:string|null;
  source_url:string|null;
  review_note:string|null;
  external_provider:string|null;
  external_reference:string|null;
  rejection_reason:string|null;
  packet_id:string|null;
  packet_validation_status:string|null;
  packet_signature_status:string|null;
  urgency:"DONE"|"OVERDUE"|"URGENT"|"UPCOMING"|"LATER";
};

type NpdOverview={
  profile:TaxProfile;
  totals:{
    person_income_minor:string;
    business_income_minor:string;
    year_income_minor:string;
    estimated_tax_minor:string;
    draft_receipts:number;
    error_receipts:number;
    annual_limit_minor:string;
    remaining_limit_minor:string;
  };
  months:Array<{
    period_key:string;
    gross_income_minor:string;
    estimated_tax_minor:string;
    official_tax_minor:string|null;
    payable_minor:string;
    source:string;
    status:string;
  }>;
  receipts:Array<{
    id:string;
    operation_date:string;
    buyer_kind:"PERSON"|"ORGANIZATION"|"IP";
    buyer_name:string|null;
    description:string;
    amount_minor:string;
    tax_rate_bps:number;
    calculated_tax_minor:string;
    fiscal_status:string;
    external_receipt_id:string|null;
    external_receipt_url:string|null;
    registered_at:string|null;
  }>;
};

type ComplianceOverview={
  profile:TaxProfile|null;
  counts:Record<string,number>;
  obligations:Obligation[];
  connectors:Array<{
    id:string;
    provider:string;
    status:string;
    supports_filing:boolean;
    supports_receipts:boolean;
    certificate_valid_to:string|null;
    last_verified_at:string|null;
    last_error:string|null;
  }>;
};

function dateLabel(value:string){
  return new Date(value).toLocaleDateString("ru-RU",{
    day:"numeric",
    month:"long",
    year:"numeric"
  });
}

function money(value:string|null,currency="RUB"){
  if(value===null) return "сумма не рассчитана";
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",currency,maximumFractionDigits:0
  }).format(Number(value)/100);
}

function urgencyLabel(value:Obligation["urgency"]){
  return ({
    OVERDUE:"Просрочено",
    URGENT:"До 7 дней",
    UPCOMING:"До 30 дней",
    LATER:"Позже",
    DONE:"Готово"
  } as Record<string,string>)[value]??value;
}

function statusLabel(value:string){
  return ({
    PLANNED:"Нужно подготовить",
    READY:"Готово к проверке",
    APPROVED:"Утверждено",
    SUBMITTED:"Отправлено",
    ACCEPTED:"Принято",
    REJECTED:"Есть отказ",
    PAID:"Оплачено",
    CANCELLED:"Отменено"
  } as Record<string,string>)[value]??value;
}

function typeLabel(value:Obligation["obligation_type"]){
  return ({
    FILE:"Отчётность",
    PAY:"Налог к оплате",
    NOTIFY:"Уведомление",
    RECONCILE:"Сверка"
  } as Record<string,string>)[value]??value;
}

export default function AccountingTaxesPage(){
  const [entities,setEntities]=useState<LegalEntity[]>([]);
  const [legalEntityId,setLegalEntityId]=useState("");
  const [overview,setOverview]=useState<ComplianceOverview|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  const [showProfile,setShowProfile]=useState(false);
  const [npd,setNpd]=useState<NpdOverview|null>(null);

  const [entityKind,setEntityKind]=useState<"ORGANIZATION"|"IP"|"INDIVIDUAL">("ORGANIZATION");
  const [taxRegime,setTaxRegime]=useState<TaxProfile["tax_regime"]>("USN_INCOME");
  const [vatMode,setVatMode]=useState<TaxProfile["vat_mode"]>("NO_VAT");
  const [hasEmployees,setHasEmployees]=useState(false);
  const [complianceEnabled,setComplianceEnabled]=useState(true);
  const [complianceDisabledReason,setComplianceDisabledReason]=useState("");
  const [kpp,setKpp]=useState("");
  const [oktmo,setOktmo]=useState("");
  const [taxOfficeCode,setTaxOfficeCode]=useState("");

  const year=new Date().getFullYear();

  useEffect(()=>{
    void apiRequest<Organization>("/organization")
      .then(data=>{
        setEntities(data.legalEntities);
        if(data.legalEntities[0]) setLegalEntityId(data.legalEntities[0].id);
      })
      .catch(cause=>setError(
        cause instanceof Error?cause.message:"Не удалось загрузить юридические лица"
      ));
  },[]);

  const load=useCallback(async()=>{
    if(!legalEntityId) return;
    setBusy(true);
    setError("");
    try{
      const data=await apiRequest<ComplianceOverview>(
        "/accounting/compliance?legalEntityId="+encodeURIComponent(legalEntityId)
      );
      setOverview(data);
      if(data.profile?.tax_regime==="NPD"){
        try{
          setNpd(await apiRequest<NpdOverview>(
            "/accounting/compliance/npd?legalEntityId="+
            encodeURIComponent(legalEntityId)+"&year="+year
          ));
        }catch{
          setNpd(null);
        }
      }else{
        setNpd(null);
      }
      if(data.profile){
        setEntityKind(data.profile.entity_kind);
        setTaxRegime(data.profile.tax_regime);
        setVatMode(data.profile.vat_mode);
        setHasEmployees(data.profile.has_employees);
        setComplianceEnabled(data.profile.compliance_enabled!==false);
        setComplianceDisabledReason(data.profile.compliance_disabled_reason??"");
        setKpp(data.profile.kpp??"");
        setOktmo(data.profile.oktmo??"");
        setTaxOfficeCode(data.profile.tax_office_code??"");
      }
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось загрузить налоговый центр");
    }finally{
      setBusy(false);
    }
  },[legalEntityId]);

  useEffect(()=>{void load();},[load]);

  const currentEntity=useMemo(
    ()=>entities.find(item=>item.id===legalEntityId)??null,
    [entities,legalEntityId]
  );

  const openItems=useMemo(
    ()=>overview?.obligations.filter(item=>item.urgency!=="DONE")??[],
    [overview]
  );

  async function saveProfile(event:FormEvent){
    event.preventDefault();
    if(!legalEntityId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try{
      await apiRequest("/accounting/compliance/profile",{
        method:"POST",
        body:JSON.stringify({
          legalEntityId,entityKind,taxRegime,vatMode,hasEmployees,
          complianceEnabled,
          complianceDisabledReason:complianceEnabled
            ?undefined
            :(complianceDisabledReason.trim()||"Регламентированный налоговый контур отключён владельцем"),
          kpp:kpp||undefined,oktmo:oktmo||undefined,
          taxOfficeCode:taxOfficeCode||undefined,
          ensEnabled:true,reportingMode:"ASSISTED",riskTolerance:"CONSERVATIVE"
        })
      });
      if(complianceEnabled){
        await apiRequest("/accounting/compliance/calendar/build",{
          method:"POST",
          body:JSON.stringify({legalEntityId,year})
        });
      }
      setShowProfile(false);
      setNotice(
        complianceEnabled
          ?"Налоговый профиль сохранён. Календарь обязательств собран."
          :"Налоговый профиль сохранён. Регламентированный контур выключен; управленческий и бухгалтерский учёт продолжают работать."
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось сохранить налоговый профиль");
    }finally{
      setBusy(false);
    }
  }

  async function rebuild(){
    if(!legalEntityId) return;
    setBusy(true);
    setError("");
    try{
      const result=await apiRequest<{created:number;total:number}>(
        "/accounting/compliance/calendar/build",{
          method:"POST",
          body:JSON.stringify({legalEntityId,year})
        }
      );
      setNotice(
        result.created
          ? "Добавлено задач: "+result.created+"."
          : "Календарь уже актуален, дубликатов не создано."
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось обновить календарь");
    }finally{
      setBusy(false);
    }
  }

  async function createNpdReceipt(){
    if(!legalEntityId) return;
    const amountRub=window.prompt("Сумма дохода, ₽");
    if(!amountRub) return;
    const amount=Number(amountRub.replace(",","."));
    if(!Number.isFinite(amount)||amount<=0){
      setError("Некорректная сумма дохода");
      return;
    }
    const buyer=window.prompt(
      "Покупатель: PERSON, ORGANIZATION или IP",
      "PERSON"
    )?.trim().toUpperCase();
    if(!buyer||!["PERSON","ORGANIZATION","IP"].includes(buyer)){
      setError("Укажите PERSON, ORGANIZATION или IP");
      return;
    }
    const description=window.prompt("Что продано / какая услуга оказана?");
    if(!description?.trim()) return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/accounting/compliance/npd/receipts",{
        method:"POST",
        body:JSON.stringify({
          legalEntityId,
          operationDate:new Date().toISOString(),
          buyerKind:buyer,
          description:description.trim(),
          amountMinor:String(Math.round(amount*100))
        })
      });
      await apiRequest("/accounting/compliance/npd/months/rebuild",{
        method:"POST",
        body:JSON.stringify({legalEntityId,year})
      });
      setNotice(
        "Доход сохранён как черновик. После формирования чека в «Мой налог» подтвердите его номер."
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось добавить доход НПД");
    }finally{setBusy(false);}
  }

  async function confirmNpdReceipt(id:string){
    const number=window.prompt("Номер чека из «Мой налог»");
    if(!number?.trim()) return;
    const url=window.prompt("Ссылка на чек, если есть")??"";
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/accounting/compliance/npd/receipts/"+id+"/confirm",{
        method:"POST",
        body:JSON.stringify({
          externalReceiptId:number.trim(),
          externalReceiptUrl:url.trim()||undefined,
          connectorProvider:"MANUAL"
        })
      });
      await apiRequest("/accounting/compliance/npd/months/rebuild",{
        method:"POST",
        body:JSON.stringify({legalEntityId,year})
      });
      setNotice("Чек подтверждён данными из «Мой налог».");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось подтвердить чек");
    }finally{setBusy(false);}
  }

  async function prepare(item:Obligation){
    setBusy(true);
    setError("");
    try{
      const result=await apiRequest<{
        validationStatus:string;
        missing:string[];
      }>("/accounting/compliance/packet",{
        method:"POST",
        body:JSON.stringify({obligationId:item.id})
      });
      setNotice(
        result.missing.length
          ?"Черновик готов. Нужно проверить: "+result.missing.join(", ")+"."
          :"Пакет сформирован и прошёл базовую проверку."
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось подготовить пакет");
    }finally{
      setBusy(false);
    }
  }

  async function transition(
    item:Obligation,
    action:"APPROVE"|"SUBMIT"|"ACCEPT"|"REJECT"|"MARK_PAID"|"REOPEN"
  ){
    const body:any={obligationId:item.id,action};

    if(action==="SUBMIT"){
      const provider=window.prompt(
        "Куда отправили? Например: ФНС ЛК, Контур, СБИС, Такском",
        item.external_provider??"ФНС ЛК"
      );
      if(!provider?.trim()) return;
      const reference=window.prompt(
        "Введите идентификатор отправки или квитанции"
      );
      if(!reference?.trim()) return;
      body.externalProvider=provider.trim();
      body.externalReference=reference.trim();
    }

    if(action==="ACCEPT"){
      body.externalProvider=item.external_provider??"MANUAL";
      body.externalReference=item.external_reference??("accepted:"+item.id);
    }

    if(action==="REJECT"){
      const reason=window.prompt("Причина отказа из квитанции ФНС/оператора");
      if(!reason?.trim()) return;
      body.rejectionReason=reason.trim();
      body.externalProvider=item.external_provider??"MANUAL";
      body.externalReference=item.external_reference??("rejected:"+item.id);
    }

    setBusy(true);
    setError("");
    try{
      await apiRequest("/accounting/compliance/transition",{
        method:"POST",body:JSON.stringify(body)
      });
      setNotice("Статус налоговой задачи обновлён.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось изменить статус");
    }finally{
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="accounting-taxes" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero">
          <div>
            <span className="studio-eyebrow">Бухгалтерия / контроль обязательств</span>
            <h1>Налоги и ФНС</h1>
            <p>
              CoreBiz собирает обязательства из данных компании и ведёт по шагам:
              рассчитать, проверить, подписать, отправить, получить квитанцию и оплатить.
            </p>
          </div>
          <div className="studio-hero-actions">
            <select
              value={legalEntityId}
              onChange={event=>setLegalEntityId(event.target.value)}
            >
              {entities.map(item=>(
                <option value={item.id} key={item.id}>
                  {item.name}{item.inn?" · ИНН "+item.inn:""}
                </option>
              ))}
            </select>
            <button
              className="secondary-button"
              type="button"
              onClick={()=>setShowProfile(value=>!value)}
            >
              Налоговый профиль
            </button>
            <button
              type="button"
              onClick={()=>void rebuild()}
              disabled={busy||overview?.profile?.compliance_enabled===false}
              title={overview?.profile?.compliance_enabled===false
                ?"Сначала включите налоговый контур в профиле"
                :undefined}
            >
              Обновить календарь
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

        {!overview?.profile&&!showProfile&&!busy?(
          <section className="studio-section">
            <div className="studio-empty">
              <span>01</span>
              <strong>Настройте налоговый профиль один раз</strong>
              <p>
                Укажите форму бизнеса, режим налогообложения, НДС и наличие сотрудников.
                После этого CoreBiz соберёт персональный календарь отчётности и платежей.
              </p>
              <button type="button" onClick={()=>setShowProfile(true)}>
                Настроить за 2 минуты
              </button>
            </div>
          </section>
        ):null}

        {showProfile?(
          <section className="studio-section">
            <div className="studio-section-head">
              <div>
                <span>Основа автоматизации</span>
                <h2>Налоговый профиль</h2>
                <p>
                  Эти настройки определяют, какие отчёты, уведомления и платежи
                  система должна контролировать.
                </p>
              </div>
            </div>
            <form className="studio-form-grid" onSubmit={saveProfile}>
              <label>
                <span>Форма бизнеса</span>
                <select value={entityKind} onChange={e=>setEntityKind(e.target.value as any)}>
                  <option value="ORGANIZATION">ООО / организация</option>
                  <option value="IP">ИП</option>
                  <option value="INDIVIDUAL">Физлицо / самозанятый</option>
                </select>
              </label>
              <label>
                <span>Налоговый режим</span>
                <select value={taxRegime} onChange={e=>setTaxRegime(e.target.value as any)}>
                  <option value="NPD">НПД / самозанятость</option>
                  <option value="USN_INCOME">УСН Доходы</option>
                  <option value="USN_INCOME_EXPENSE">УСН Доходы минус расходы</option>
                  <option value="AUSN">АвтоУСН</option>
                  <option value="OSNO">ОСНО</option>
                  <option value="OTHER">Другой</option>
                </select>
              </label>
              <label>
                <span>НДС</span>
                <select value={vatMode} onChange={e=>setVatMode(e.target.value as any)}>
                  <option value="NO_VAT">Без НДС</option>
                  <option value="VAT_5">НДС 5%</option>
                  <option value="VAT_7">НДС 7%</option>
                  <option value="VAT_22">НДС 22%</option>
                  <option value="VAT_MIXED">Смешанные ставки</option>
                </select>
              </label>
              <label>
                <span>Сотрудники</span>
                <select
                  value={hasEmployees?"YES":"NO"}
                  onChange={e=>setHasEmployees(e.target.value==="YES")}
                >
                  <option value="NO">Нет сотрудников</option>
                  <option value="YES">Есть сотрудники</option>
                </select>
              </label>
              <label>
                <span>Налоговый контур</span>
                <select
                  value={complianceEnabled?"ENABLED":"DISABLED"}
                  onChange={e=>setComplianceEnabled(e.target.value==="ENABLED")}
                >
                  <option value="ENABLED">Включён — контролировать ФНС и сроки</option>
                  <option value="DISABLED">Выключен — только внутренний учёт</option>
                </select>
              </label>
              {!complianceEnabled?(
                <label className="studio-form-wide">
                  <span>Почему отключён</span>
                  <input
                    value={complianceDisabledReason}
                    onChange={e=>setComplianceDisabledReason(e.target.value)}
                    placeholder="Например: отчётность ведёт внешний бухгалтер"
                  />
                  <small className="muted">
                    Отключение не удаляет операции и не исключает их из бухгалтерских данных.
                  </small>
                </label>
              ):null}
              <label>
                <span>КПП</span>
                <input value={kpp} onChange={e=>setKpp(e.target.value)} placeholder="Для организации" />
              </label>
              <label>
                <span>ОКТМО</span>
                <input value={oktmo} onChange={e=>setOktmo(e.target.value)} placeholder="Код муниципального образования" />
              </label>
              <label>
                <span>Код ИФНС</span>
                <input value={taxOfficeCode} onChange={e=>setTaxOfficeCode(e.target.value)} placeholder="4 цифры" />
              </label>
              <div className="studio-form-actions">
                <button className="secondary-button" type="button" onClick={()=>setShowProfile(false)}>
                  Отмена
                </button>
                <button type="submit" disabled={busy}>Сохранить и собрать календарь</button>
              </div>
            </form>
          </section>
        ):null}

        {overview?.profile?.tax_regime==="NPD"&&npd?(
          <section className="studio-section npd-center">
            <div className="studio-section-head">
              <div>
                <span>Самозанятость / «Мой налог»</span>
                <h2>НПД без бухгалтера</h2>
                <p>
                  CoreBiz считает ожидаемый налог и контролирует чеки.
                  Фискализированным считается только чек с подтверждённым номером
                  из «Мой налог» или подключённого провайдера.
                </p>
              </div>
              <button type="button" onClick={()=>void createNpdReceipt()} disabled={busy}>
                + Доход / чек
              </button>
            </div>

            <div className="studio-score-grid">
              <article>
                <span>Доход за {year}</span>
                <strong>{money(npd.totals.year_income_minor)}</strong>
                <p>Только зарегистрированные чеки.</p>
              </article>
              <article>
                <span>До лимита НПД</span>
                <strong>{money(npd.totals.remaining_limit_minor)}</strong>
                <p>Годовой лимит {money(npd.totals.annual_limit_minor)}.</p>
              </article>
              <article>
                <span>Ожидаемый налог</span>
                <strong>{money(npd.totals.estimated_tax_minor)}</strong>
                <p>4% физлица · 6% организации и ИП.</p>
              </article>
              <article>
                <span>Нужно оформить</span>
                <strong>{npd.totals.draft_receipts}</strong>
                <p>Доходы без подтверждённого чека.</p>
              </article>
            </div>

            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Дата</th><th>Покупатель</th><th>Описание</th>
                    <th>Доход</th><th>Налог</th><th>Чек</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {npd.receipts.map(item=>(
                    <tr key={item.id}>
                      <td>{new Date(item.operation_date).toLocaleDateString("ru-RU")}</td>
                      <td>{item.buyer_name??(item.buyer_kind==="PERSON"?"Физлицо":item.buyer_kind)}</td>
                      <td>{item.description}</td>
                      <td><strong>{money(item.amount_minor)}</strong></td>
                      <td>{money(item.calculated_tax_minor)} · {item.tax_rate_bps/100}%</td>
                      <td>
                        <span className="status-pill">
                          {item.fiscal_status==="REGISTERED"?"Зарегистрирован":"Черновик"}
                        </span>
                        {item.external_receipt_id?<small>{item.external_receipt_id}</small>:null}
                      </td>
                      <td>
                        {item.fiscal_status!=="REGISTERED"?(
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={()=>void confirmNpdReceipt(item.id)}
                            disabled={busy}
                          >
                            Подтвердить чек
                          </button>
                        ):null}
                      </td>
                    </tr>
                  ))}
                  {!npd.receipts.length?(
                    <tr><td colSpan={7}>
                      <div className="table-empty">
                        <strong>Доходов НПД пока нет</strong>
                        <span>Добавьте первый доход после оплаты клиентом.</span>
                      </div>
                    </td></tr>
                  ):null}
                </tbody>
              </table>
            </div>
          </section>
        ):null}

        {overview?.profile?.compliance_enabled===false?(
          <section className="studio-section">
            <div className="studio-message">
              <strong>Регламентированный контур выключен</strong>
              <span>
                CoreBiz продолжает вести деньги, P&L, склад и бухгалтерские данные,
                но не создаёт новые задачи ФНС и не переводит документы к отправке.
                Включить можно в «Налоговый профиль».
              </span>
            </div>
          </section>
        ):null}

        {overview?.profile?(
          <>
            <div className="studio-score-grid">
              <article>
                <span>Просрочено</span>
                <strong>{overview.counts.OVERDUE??0}</strong>
                <p>Требует действия сегодня.</p>
              </article>
              <article>
                <span>На 7 дней</span>
                <strong>{overview.counts.URGENT??0}</strong>
                <p>Лучше подготовить заранее, не в день срока.</p>
              </article>
              <article>
                <span>На 30 дней</span>
                <strong>{overview.counts.UPCOMING??0}</strong>
                <p>Ближайшие отчёты, уведомления и платежи.</p>
              </article>
              <article>
                <span>Контур сдачи</span>
                <strong>
                  {overview.connectors.some(item=>item.status==="VERIFIED")
                    ?"Подключён"
                    :"Нужна настройка"}
                </strong>
                <p>
                  {overview.connectors.some(item=>item.status==="VERIFIED")
                    ?"Можно получать статусы от оператора."
                    :"ФНС ЛК / оператор ЭДО / КЭП подключаются отдельно."}
                </p>
              </article>
            </div>

            <section className="studio-section">
              <div className="studio-section-head">
                <div>
                  <span>{currentEntity?.name??"Юридическое лицо"}</span>
                  <h2>Что нужно сделать</h2>
                  <p>
                    Не бухгалтерский календарь ради календаря: только задачи,
                    которые влияют на сдачу отчётности и налоги.
                  </p>
                </div>
                <span className="studio-chip">
                  {overview.profile.tax_regime.replaceAll("_"," ")}
                </span>
              </div>

              <div className="studio-rule-grid">
                {openItems.map(item=>(
                  <article className="studio-rule-card" key={item.id}>
                    <header>
                      <div>
                        <span className="studio-chip">
                          {urgencyLabel(item.urgency)} · {typeLabel(item.obligation_type)}
                        </span>
                        <h3>{item.title}</h3>
                        <p>
                          До {dateLabel(item.due_at)}
                          {item.form_code?" · "+item.form_code:""}
                        </p>
                      </div>
                      <strong>{money(item.amount_minor,item.currency)}</strong>
                    </header>

                    <div>
                      <p>
                        <b>{statusLabel(item.workflow_status)}</b>
                        {item.review_note?" · "+item.review_note:""}
                      </p>
                      {item.rejection_reason?(
                        <p className="muted">Причина отказа: {item.rejection_reason}</p>
                      ):null}
                    </div>

                    <footer>
                      <span>
                        {item.packet_validation_status
                          ?"Пакет: "+item.packet_validation_status
                          :"Пакет ещё не собран"}
                      </span>
                      <div className="studio-card-actions">
                        {item.workflow_status==="PLANNED"||item.workflow_status==="REJECTED"?(
                          <button type="button" onClick={()=>void prepare(item)} disabled={busy}>
                            Подготовить
                          </button>
                        ):null}
                        {item.workflow_status==="READY"?(
                          <button type="button" onClick={()=>void transition(item,"APPROVE")} disabled={busy}>
                            Утвердить
                          </button>
                        ):null}
                        {item.workflow_status==="APPROVED"&&item.obligation_type!=="PAY"?(
                          <button type="button" onClick={()=>void transition(item,"SUBMIT")} disabled={busy}>
                            Зафиксировать отправку
                          </button>
                        ):null}
                        {item.workflow_status==="APPROVED"&&item.obligation_type==="PAY"?(
                          <button type="button" onClick={()=>void transition(item,"MARK_PAID")} disabled={busy}>
                            Отметить оплату
                          </button>
                        ):null}
                        {item.workflow_status==="SUBMITTED"?(
                          <>
                            <button type="button" onClick={()=>void transition(item,"ACCEPT")} disabled={busy}>
                              Принято ФНС
                            </button>
                            <button className="secondary-button" type="button" onClick={()=>void transition(item,"REJECT")} disabled={busy}>
                              Есть отказ
                            </button>
                          </>
                        ):null}
                        {item.workflow_status==="REJECTED"?(
                          <button className="secondary-button" type="button" onClick={()=>void transition(item,"REOPEN")} disabled={busy}>
                            Исправить
                          </button>
                        ):null}
                      </div>
                    </footer>
                  </article>
                ))}

                {!openItems.length?(
                  <div className="studio-empty">
                    <span>✓</span>
                    <strong>На выбранном горизонте всё закрыто</strong>
                    <p>
                      CoreBiz продолжит показывать следующие обязательства по календарю.
                    </p>
                  </div>
                ):null}
              </div>
            </section>

            <section className="studio-section">
              <div className="studio-section-head">
                <div>
                  <span>Как работает сдача</span>
                  <h2>Автоматизация без опасной самодеятельности</h2>
                </div>
              </div>
              <div className="studio-rule-grid">
                <article className="studio-rule-card">
                  <header><div><span className="studio-chip">1</span><h3>CoreBiz считает и проверяет</h3></div></header>
                  <p>Система собирает данные продаж, зарплаты, банка, НДС и первички. Если данных не хватает, отправка блокируется.</p>
                </article>
                <article className="studio-rule-card">
                  <header><div><span className="studio-chip">2</span><h3>Владелец подтверждает</h3></div></header>
                  <p>Перед юридически значимой отправкой видны сумма, форма, период, источник правила и все предупреждения.</p>
                </article>
                <article className="studio-rule-card">
                  <header><div><span className="studio-chip">3</span><h3>КЭП / оператор отправляет</h3></div></header>
                  <p>Отправка в ФНС должна идти через поддержанный канал. Принятие считается завершённым только после квитанции.</p>
                </article>
              </div>
            </section>
          </>
        ):null}

        {busy?(
          <div className="board-loading">Обновляем налоговый центр…</div>
        ):null}
      </section>
    </main>
  );
}
