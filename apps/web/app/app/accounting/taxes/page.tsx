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
  entity_kind:"ORGANIZATION"|"IP";
  tax_regime:"USN_INCOME"|"USN_INCOME_EXPENSE"|"OSNO"|"AUSN"|"OTHER";
  vat_mode:"NO_VAT"|"VAT_5"|"VAT_7"|"VAT_20"|"VAT_MIXED";
  has_employees:boolean;
  ens_enabled:boolean;
  reporting_mode:"ASSISTED"|"SEMI_AUTOMATIC"|"EXTERNAL_ACCOUNTANT";
  risk_tolerance:"CONSERVATIVE"|"STANDARD";
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

  const [entityKind,setEntityKind]=useState<"ORGANIZATION"|"IP">("ORGANIZATION");
  const [taxRegime,setTaxRegime]=useState<TaxProfile["tax_regime"]>("USN_INCOME");
  const [vatMode,setVatMode]=useState<TaxProfile["vat_mode"]>("NO_VAT");
  const [hasEmployees,setHasEmployees]=useState(false);
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
      if(data.profile){
        setEntityKind(data.profile.entity_kind);
        setTaxRegime(data.profile.tax_regime);
        setVatMode(data.profile.vat_mode);
        setHasEmployees(data.profile.has_employees);
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
          kpp:kpp||undefined,oktmo:oktmo||undefined,
          taxOfficeCode:taxOfficeCode||undefined,
          ensEnabled:true,reportingMode:"ASSISTED",riskTolerance:"CONSERVATIVE"
        })
      });
      await apiRequest("/accounting/compliance/calendar/build",{
        method:"POST",
        body:JSON.stringify({legalEntityId,year})
      });
      setShowProfile(false);
      setNotice("Налоговый профиль сохранён. Календарь обязательств собран.");
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
            <button type="button" onClick={()=>void rebuild()} disabled={busy}>
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
                </select>
              </label>
              <label>
                <span>Налоговый режим</span>
                <select value={taxRegime} onChange={e=>setTaxRegime(e.target.value as any)}>
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
                  <option value="VAT_20">НДС 20%</option>
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
