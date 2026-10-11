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
  usn_min_tax_bps:number|null;
  kpp:string|null;
  oktmo:string|null;
  tax_office_code:string|null;
  compliance_enabled:boolean;
  compliance_disabled_reason:string|null;
};

type Obligation = {
  id:string;
  code:string;
  title:string;
  authority:string;
  obligation_type:"FILE"|"PAY"|"NOTIFY"|"RECONCILE";
  due_at:string;
  amount_minor:string|null;
  workflow_status:string;
  calculation_status:string;
  validation_status:string|null;
  signature_status:string|null;
  source_url:string|null;
  form_code?:string|null;
  connector_provider?:string|null;
  connector_status?:string|null;
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

type Connector = {
  id:string;
  provider:string;
  status:string;
  supports_filing:boolean;
  supports_receipts:boolean;
  certificate_fingerprint:string|null;
  certificate_valid_to:string|null;
  last_error:string|null;
};

type CashAccount = {
  id:string;
  name:string;
  kind:string;
  currency:string;
  legal_entity_id:string|null;
  assignment_state:"THIS_ENTITY"|"UNASSIGNED"|"OTHER_ENTITY";
  is_default:boolean;
};

type TaxCalculation = {
  id:string;
  tax_code:string;
  period_key:string;
  taxable_income_minor:string;
  deductible_expense_minor:string;
  taxable_base_minor:string;
  calculated_tax_minor:string;
  advances_minor:string;
  tax_due_minor:string;
  status:string;
  obligation_id?:string|null;
};

type AutopilotTask = {
  id:string;
  task_key:string;
  category:string;
  severity:"INFO"|"WARNING"|"CRITICAL";
  status:"OPEN"|"IN_PROGRESS"|"DISMISSED";
  title:string;
  description:string;
  action_code:string|null;
  action_href:string|null;
  due_at:string|null;
  amount_minor:string|null;
  currency:string;
  payload:Record<string,unknown>;
};

type Autopilot = {
  summary:{critical:number;warning:number;info:number};
  tasks:AutopilotTask[];
};

type ComplianceLine = {
  id:string;
  line_number:number;
  kpp:string|null;
  oktmo:string|null;
  kbk:string|null;
  tax_period_code:string|null;
  reporting_year:number|null;
  amount_minor:string|null;
  status:"DRAFT"|"CONFIRMED";
};

type Props = {
  legalEntityId:string;
  legalEntityName:string;
  inn:string|null;
};

type ProviderDialog = {
  kind:"SIGN"|"SUBMIT"|"RECEIPT";
  item:Obligation;
  provider:string;
  certificateFingerprint?:string|null;
  receiptType?:"ACCEPTED"|"REJECTED"|"PAYMENT";
};

function rub(value:string|number|null|undefined) {
  return new Intl.NumberFormat("ru-RU",{
    style:"currency",
    currency:"RUB",
    maximumFractionDigits:0
  }).format(Number(value??0)/100);
}

function date(value:string) {
  return new Intl.DateTimeFormat("ru-RU",{
    day:"2-digit",
    month:"short",
    year:"numeric"
  }).format(new Date(value));
}

function daysUntil(value:string) {
  return Math.ceil((new Date(value).getTime()-Date.now())/86400000);
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
    CONFIRMED:"Подтверждено",
    NOT_CALCULATED:"Не рассчитано",
    CALCULATED:"Рассчитано",
    DRAFT:"Черновик",
    INCLUDED:"Учтено",
    EXCLUDED:"Исключено"
  };
  return labels[value]??value;
}

export function AccountingComplianceCenter({
  legalEntityId,
  legalEntityName,
  inn
}:Props) {
  const [profile,setProfile]=useState<TaxProfile|null>(null);
  const [autopilot,setAutopilot]=useState<Autopilot|null>(null);
  const [obligations,setObligations]=useState<Obligation[]>([]);
  const [ledger,setLedger]=useState<LedgerItem[]>([]);
  const [ens,setEns]=useState<EnsSnapshot[]>([]);
  const [cashAccounts,setCashAccounts]=useState<CashAccount[]>([]);
  const [connectors,setConnectors]=useState<Connector[]>([]);
  const [calculation,setCalculation]=useState<TaxCalculation|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [showProfile,setShowProfile]=useState(false);
  const [entityKind,setEntityKind]=useState<"ORGANIZATION"|"IP">("ORGANIZATION");
  const [taxRegime,setTaxRegime]=useState<TaxProfile["tax_regime"]>("USN_INCOME");
  const [vatMode,setVatMode]=useState<TaxProfile["vat_mode"]>("NO_VAT");
  const [hasEmployees,setHasEmployees]=useState(false);
  const [complianceEnabled,setComplianceEnabled]=useState(true);
  const [complianceDisabledReason,setComplianceDisabledReason]=useState("");
  const [taxPayAccountId,setTaxPayAccountId]=useState("");
  const [usnRate,setUsnRate]=useState("6");
  const [usnMinRate,setUsnMinRate]=useState("1");
  const [kpp,setKpp]=useState("");
  const [oktmo,setOktmo]=useState("");
  const [taxOfficeCode,setTaxOfficeCode]=useState("");
  const [notificationLine,setNotificationLine]=useState<ComplianceLine|null>(null);
  const [lineKpp,setLineKpp]=useState("");
  const [lineOktmo,setLineOktmo]=useState("");
  const [lineKbk,setLineKbk]=useState("");
  const [linePeriodCode,setLinePeriodCode]=useState("");
  const [lineYear,setLineYear]=useState(String(new Date().getFullYear()));
  const [lineAmountRub,setLineAmountRub]=useState("");
  const [reductionsRub,setReductionsRub]=useState("0");
  const [calculationNote,setCalculationNote]=useState(
    "Налоговая книга и сумма проверены владельцем."
  );
  const [providerDialog,setProviderDialog]=useState<ProviderDialog|null>(null);
  const [providerReference,setProviderReference]=useState("");
  const [providerReason,setProviderReason]=useState("");

  const load=useCallback(async()=>{
    if(!legalEntityId) return;
    setBusy(true);
    setError("");
    try{
      const horizon=new Date();
      horizon.setMonth(horizon.getMonth()+12);
      const from=new Date();
      from.setMonth(from.getMonth()-1);

      const [
        profileRow,
        autopilotRow,
        obligationRows,
        ledgerRows,
        ensRows,
        accountRows,
        connectorRows,
        calculationRows
      ]=await Promise.all([
        apiRequest<TaxProfile|null>(
          "/accounting/compliance/profile?legalEntityId="+
          encodeURIComponent(legalEntityId)
        ),
        apiRequest<Autopilot>(
          "/accounting/compliance/autopilot?legalEntityId="+
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
        ),
        apiRequest<CashAccount[]>(
          "/accounting/compliance/cash-accounts?legalEntityId="+
          encodeURIComponent(legalEntityId)
        ),
        apiRequest<Connector[]>(
          "/accounting/compliance/connectors?legalEntityId="+
          encodeURIComponent(legalEntityId)
        ),
        apiRequest<TaxCalculation[]>(
          "/accounting/compliance/calculations?legalEntityId="+
          encodeURIComponent(legalEntityId)
        )
      ]);

      setProfile(profileRow);
      setAutopilot(autopilotRow);
      setObligations(obligationRows);
      setLedger(ledgerRows);
      setEns(ensRows);
      setCashAccounts(accountRows);
      const firstAssigned=accountRows.find(
        account=>account.assignment_state==="THIS_ENTITY"
      );
      if(firstAssigned){
        setTaxPayAccountId(current=>current||firstAssigned.id);
      }
      setConnectors(connectorRows);
      setCalculation(calculationRows[0]??null);

      if(profileRow){
        setEntityKind(profileRow.entity_kind);
        setTaxRegime(profileRow.tax_regime);
        setVatMode(profileRow.vat_mode);
        setHasEmployees(profileRow.has_employees);
        setComplianceEnabled(profileRow.compliance_enabled!==false);
        setComplianceDisabledReason(profileRow.compliance_disabled_reason??"");
        if(profileRow.usn_rate_bps){
          setUsnRate(String(profileRow.usn_rate_bps/100));
        }
        if(profileRow.usn_min_tax_bps){
          setUsnMinRate(String(profileRow.usn_min_tax_bps/100));
        }
        setKpp(profileRow.kpp??"");
        setOktmo(profileRow.oktmo??"");
        setTaxOfficeCode(profileRow.tax_office_code??"");
      }else{
        setShowProfile(true);
      }
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось загрузить налоговый центр"
      );
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
  const assignedAccounts=cashAccounts.filter(
    account=>account.assignment_state==="THIS_ENTITY"
  );
  const unassignedAccounts=cashAccounts.filter(
    account=>account.assignment_state==="UNASSIGNED"
  );
  const usnPayObligation=active.find(
    item=>item.obligation_type==="PAY"&&item.code.includes("USN")
  )??null;

  useEffect(()=>{
    const item=next;
    if(!item||item.form_code!=="KND_1110355"){
      setNotificationLine(null);
      return;
    }
    void apiRequest<ComplianceLine[]>(
      "/accounting/compliance/obligations/"+
        item.id+
        "/lines"
    ).then(rows=>{
      const line=rows[0]??null;
      setNotificationLine(line);
      setLineKpp(line?.kpp??profile?.kpp??"");
      setLineOktmo(line?.oktmo??profile?.oktmo??"");
      setLineKbk(line?.kbk??"");
      setLinePeriodCode(line?.tax_period_code??"");
      setLineYear(String(
        line?.reporting_year??new Date(item.due_at).getFullYear()
      ));
      setLineAmountRub(
        line?.amount_minor!==null&&line?.amount_minor!==undefined
          ?String(Number(line.amount_minor)/100)
          :item.amount_minor!==null
            ?String(Number(item.amount_minor)/100)
            :""
      );
    }).catch(cause=>{
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось загрузить реквизиты уведомления"
      );
    });
  },[
    next?.id,
    next?.form_code,
    next?.amount_minor,
    next?.due_at,
    profile?.kpp,
    profile?.oktmo
  ]);

  async function updateAutopilotTask(
    task:AutopilotTask,
    status:"OPEN"|"IN_PROGRESS"|"DISMISSED"
  ){
    setBusy(true);
    setError("");
    try{
      await apiRequest(
        "/accounting/compliance/autopilot/"+task.id+"/status",
        {
          method:"POST",
          body:JSON.stringify({status})
        }
      );
      setNotice(
        status==="DISMISSED"
          ?"Задача скрыта. Автопилот продолжит следить за риском."
          :"Задача взята в работу."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось обновить задачу автопилота"
      );
    }finally{
      setBusy(false);
    }
  }

  async function saveProfile() {
    const rate=Number(usnRate.replace(",","."));
    const minimumRate=Number(usnMinRate.replace(",","."));
    if(
      taxRegime.startsWith("USN_") &&
      (!Number.isFinite(rate)||rate<=0||rate>100)
    ){
      setError("Проверьте ставку УСН");
      return;
    }
    if(
      taxRegime==="USN_INCOME_EXPENSE" &&
      (!Number.isFinite(minimumRate)||minimumRate<=0||minimumRate>100)
    ){
      setError("Проверьте ставку минимального налога");
      return;
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
          complianceEnabled,
          complianceDisabledReason:complianceEnabled
            ?undefined
            :(complianceDisabledReason.trim()||
              "Регламентированный налоговый контур отключён владельцем"),
          ensEnabled:true,
          reportingMode:"ASSISTED",
          riskTolerance:"CONSERVATIVE",
          usnRateBps:taxRegime.startsWith("USN_")
            ?Math.round(rate*100)
            :null,
          usnMinimumTaxBps:taxRegime==="USN_INCOME_EXPENSE"
            ?Math.round(minimumRate*100)
            :null,
          kpp:kpp.trim()||undefined,
          oktmo:oktmo.trim()||undefined,
          taxOfficeCode:taxOfficeCode.trim()||undefined
        })
      });
      setNotice("Налоговый профиль сохранён");
      setShowProfile(false);
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось сохранить налоговый профиль"
      );
    }finally{
      setBusy(false);
    }
  }

  async function payTax(item:Obligation) {
    const cashAccountId=taxPayAccountId||assignedAccounts[0]?.id||"";
    if(!cashAccountId){
      setError(
        "Сначала привяжите банковский или кассовый счёт к этому юридическому лицу"
      );
      return;
    }
    setBusy(true);
    setError("");
    try{
      const result=await apiRequest<{
        paid:boolean;
        alreadyPaid:boolean;
        paymentId:string|null;
        amountMinor:string;
      }>(
        "/accounting/compliance/obligations/"+item.id+"/pay",
        {
          method:"POST",
          body:JSON.stringify({
            cashAccountId,
            note:"Налоговый платёж зарегистрирован в CoreBiz"
          })
        }
      );
      setNotice(
        result.alreadyPaid
          ?"Налоговый платёж уже зарегистрирован."
          :"Платёж зарегистрирован в финансах и налоговая задача закрыта."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось зарегистрировать налоговый платёж"
      );
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
      const result=await apiRequest<{created:number}>(
        "/accounting/compliance/calendar/generate",
        {
          method:"POST",
          body:JSON.stringify({
            legalEntityId,
            from:start.toISOString().slice(0,10),
            to:end.toISOString().slice(0,10)
          })
        }
      );
      setNotice(
        result.created
          ?"Добавлено обязательств: "+result.created
          :"Календарь уже актуален"
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось обновить календарь"
      );
    }finally{
      setBusy(false);
    }
  }

  async function assignCashAccount(
    accountId:string,
    assign:boolean
  ) {
    setBusy(true);
    try{
      await apiRequest(
        "/accounting/compliance/cash-accounts/"+accountId+"/assign",
        {
          method:"POST",
          body:JSON.stringify({
            legalEntityId:assign?legalEntityId:null
          })
        }
      );
      setNotice(
        assign
          ?"Денежный счёт привязан к юрлицу"
          :"Привязка денежного счёта снята"
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось изменить привязку счёта"
      );
    }finally{
      setBusy(false);
    }
  }

  async function syncLedger() {
    if(!assignedAccounts.length){
      setError(
        "Сначала привяжите хотя бы один банковский или кассовый счёт к этому юрлицу"
      );
      return;
    }
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
          ?"Добавлено движений в налоговую книгу: "+result.added
          :"Новых движений нет"
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось обновить налоговую книгу"
      );
    }finally{
      setBusy(false);
    }
  }

  async function reviewLedger(
    item:LedgerItem,
    treatment:"INCLUDED"|"EXCLUDED"
  ) {
    const reason=
      treatment==="INCLUDED"
        ?"Проверено: подтверждено первичными документами"
        :"Проверено: не относится к налоговой базе";
    try{
      await apiRequest(
        "/accounting/compliance/tax-ledger/"+item.id+"/review",
        {
          method:"POST",
          body:JSON.stringify({treatment,reason})
        }
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось подтвердить движение"
      );
    }
  }

  async function calculateUsn() {
    if(!profile?.tax_regime.startsWith("USN_")){
      setError("Расчёт УСН доступен только для профиля УСН");
      return;
    }
    if(reviewCount>0){
      setError(
        "Сначала разберите операции со статусом «Проверить»: они могут изменить сумму налога"
      );
      return;
    }
    const year=new Date().getFullYear();
    const reductions=Number(reductionsRub.replace(",","."));
    if(!Number.isFinite(reductions)||reductions<0){
      setError("Проверьте сумму уменьшений");
      return;
    }

    setBusy(true);
    try{
      const result=await apiRequest<TaxCalculation>(
        "/accounting/compliance/calculations/usn-preview",
        {
          method:"POST",
          body:JSON.stringify({
            legalEntityId,
            periodFrom:year+"-01-01",
            periodTo:new Date().toISOString().slice(0,10),
            calculationType:"USN_ADVANCE",
            reductionsMinor:String(Math.round(reductions*100)),
            obligationId:usnPayObligation?.id??undefined
          })
        }
      );
      setCalculation(result);
      setNotice("Предварительный расчёт УСН обновлён");
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось рассчитать УСН"
      );
    }finally{
      setBusy(false);
    }
  }

  async function confirmCalculation() {
    if(!calculation) return;
    if(calculationNote.trim().length<8){
      setError("Добавьте комментарий к проверке расчёта");
      return;
    }
    setBusy(true);
    try{
      await apiRequest(
        "/accounting/compliance/calculations/"+
          calculation.id+
          "/confirm",
        {
          method:"POST",
          body:JSON.stringify({
            obligationId:
              calculation.obligation_id??
              usnPayObligation?.id??
              undefined,
            note:calculationNote.trim()
          })
        }
      );
      setNotice("Расчёт подтверждён и зафиксирован");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось подтвердить расчёт"
      );
    }finally{
      setBusy(false);
    }
  }

  async function saveNotificationLine(item:Obligation) {
    const amount=Number(lineAmountRub.replace(",","."));
    const year=Number(lineYear);
    if(!Number.isFinite(amount)||amount<0){
      setError("Проверьте сумму строки уведомления");
      return;
    }
    if(!Number.isSafeInteger(year)||year<2000||year>2100){
      setError("Проверьте отчётный год");
      return;
    }
    if(entityKind==="ORGANIZATION"&&!/^\d{9}$/.test(lineKpp.trim())){
      setError("Для организации укажите КПП: 9 цифр");
      return;
    }
    if(!/^(?:\d{8}|\d{11})$/.test(lineOktmo.trim())){
      setError("ОКТМО должен содержать 8 или 11 цифр");
      return;
    }
    if(!/^\d{20}$/.test(lineKbk.trim())){
      setError("КБК должен содержать 20 цифр");
      return;
    }
    if(!/^\d{2}\/\d{2}$/.test(linePeriodCode.trim())){
      setError("Код периода укажите в формате 00/00");
      return;
    }

    setBusy(true);
    setError("");
    try{
      const line=await apiRequest<ComplianceLine>(
        "/accounting/compliance/obligations/"+item.id+"/lines",
        {
          method:"POST",
          body:JSON.stringify({
            lineNumber:1,
            kpp:lineKpp.trim()||undefined,
            oktmo:lineOktmo.trim(),
            kbk:lineKbk.trim(),
            taxPeriodCode:linePeriodCode.trim(),
            reportingYear:year,
            amountMinor:String(Math.round(amount*100)),
            confirm:true
          })
        }
      );
      setNotificationLine(line);
      setNotice(
        "Строка уведомления подтверждена. Теперь можно собрать пакет."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось сохранить строку уведомления"
      );
    }finally{
      setBusy(false);
    }
  }

  async function preparePacket(item:Obligation) {
    try{
      await apiRequest(
        "/accounting/compliance/obligations/"+item.id+"/packet",
        {method:"POST",body:"{}"}
      );
      setNotice(
        "Пакет подготовлен. Перед подписью его нужно проверить."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ?cause.message
          :"Не удалось подготовить пакет"
      );
    }
  }

  async function validatePacket(item:Obligation) {
    const note="Проверены реквизиты, сумма, период и нормативное основание.";
    setBusy(true);
    setError("");
    try{
      await apiRequest(
        "/accounting/compliance/obligations/"+item.id+"/packet/validate",
        {method:"POST",body:JSON.stringify({note})}
      );
      setNotice("Пакет проверен. Теперь его можно утвердить.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось проверить пакет");
    }finally{
      setBusy(false);
    }
  }

  async function approveObligation(item:Obligation) {
    setBusy(true);
    setError("");
    try{
      await apiRequest(
        "/accounting/compliance/obligations/"+item.id+"/approve",
        {method:"POST",body:"{}"}
      );
      setNotice("Документ утверждён. Для отправки нужна подтверждённая КЭП.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось утвердить документ");
    }finally{
      setBusy(false);
    }
  }

  function openProviderDialog(dialog:ProviderDialog){
    setProviderReference("");
    setProviderReason("");
    setProviderDialog(dialog);
    setError("");
  }

  async function signWithConnector(item:Obligation) {
    const verified=connectors.find(connector=>
      connector.status==="VERIFIED" &&
      connector.supports_filing &&
      connector.certificate_fingerprint
    );
    if(!verified){
      setError(
        "Нет проверенного оператора с действующим сертификатом. Подключите оператора электронной отчётности."
      );
      return;
    }
    openProviderDialog({
      kind:"SIGN",
      item,
      provider:verified.provider,
      certificateFingerprint:verified.certificate_fingerprint
    });
  }

  async function recordSubmitted(item:Obligation) {
    const verified=connectors.find(connector=>
      connector.status==="VERIFIED" && connector.supports_filing
    );
    if(!verified){
      setError("Нет проверенного канала электронной сдачи.");
      return;
    }
    openProviderDialog({
      kind:"SUBMIT",
      item,
      provider:verified.provider
    });
  }

  async function recordReceipt(
    item:Obligation,
    receiptType:"ACCEPTED"|"REJECTED"|"PAYMENT"
  ) {
    openProviderDialog({
      kind:"RECEIPT",
      item,
      receiptType,
      provider:
        item.connector_provider||
        connectors.find(connector=>connector.status==="VERIFIED")?.provider||
        "MANUAL"
    });
  }

  async function confirmProviderDialog(){
    const dialog=providerDialog;
    const reference=providerReference.trim();
    if(!dialog||!reference){
      setError("Укажите идентификатор операции или квитанции");
      return;
    }
    if(dialog.kind==="RECEIPT"&&dialog.receiptType==="REJECTED"&&!providerReason.trim()){
      setError("Укажите причину отказа из квитанции");
      return;
    }

    setBusy(true);
    setError("");
    try{
      if(dialog.kind==="SIGN"){
        if(!dialog.certificateFingerprint){
          throw new Error("У оператора не указан отпечаток сертификата");
        }
        await apiRequest(
          "/accounting/compliance/obligations/"+dialog.item.id+"/signature",
          {
            method:"POST",
            body:JSON.stringify({
              provider:dialog.provider,
              certificateFingerprint:dialog.certificateFingerprint,
              providerReference:reference
            })
          }
        );
        setNotice("КЭП подтверждена оператором. Документ готов к отправке.");
      }else if(dialog.kind==="SUBMIT"){
        await apiRequest(
          "/accounting/compliance/obligations/"+dialog.item.id+"/submitted",
          {
            method:"POST",
            body:JSON.stringify({
              provider:dialog.provider,
              externalReference:reference
            })
          }
        );
        setNotice("Отправка зафиксирована. Ожидаем квитанцию.");
      }else{
        await apiRequest(
          "/accounting/compliance/obligations/"+dialog.item.id+"/receipt",
          {
            method:"POST",
            body:JSON.stringify({
              provider:dialog.provider,
              externalReference:reference,
              receiptType:dialog.receiptType,
              payload:providerReason.trim()
                ?{reason:providerReason.trim()}
                :undefined
            })
          }
        );
        setNotice(
          dialog.receiptType==="ACCEPTED"
            ?"ФНС приняла документ."
            :dialog.receiptType==="PAYMENT"
              ?"Оплата подтверждена."
              :"Отказ сохранён. Исправьте пакет и отправьте повторно."
        );
      }
      setProviderDialog(null);
      setProviderReference("");
      setProviderReason("");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось выполнить действие"
      );
    }finally{
      setBusy(false);
    }
  }

  return (
    <div className="compliance-center">
      <section className="compliance-hero">
        <div>
          <span className="compliance-eyebrow">Налоговый центр</span>
          <h2>Что нужно сделать и когда</h2>
          <p>
            CoreBiz собирает движения, считает предварительные налоги,
            формирует календарь и готовит пакет. Юридически значимая отправка
            выполняется только после проверки, подписи и подтверждения оператора.
          </p>
        </div>
        <div className="compliance-hero-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={()=>setShowProfile(value=>!value)}
          >
            {profile?"Налоговый профиль":"Настроить налоги"}
          </button>
          <button
            type="button"
            disabled={busy||!profile||profile.compliance_enabled===false}
            title={
              profile?.compliance_enabled===false
                ?"Налоговый контур выключен в профиле"
                :undefined
            }
            onClick={()=>void generateCalendar()}
          >
            Обновить календарь
          </button>
        </div>
      </section>

      {autopilot?(
        <section className="accounting-autopilot">
          <div className="accounting-autopilot-head">
            <div>
              <span className="compliance-eyebrow">Бухгалтерский автопилот</span>
              <h3>
                {autopilot.summary.critical>0
                  ?"Есть риски, которые нельзя откладывать"
                  :autopilot.summary.warning>0
                    ?"Есть задачи, которые лучше закрыть заранее"
                    :"Критичных бухгалтерских задач нет"}
              </h3>
              <p>
                Проверяем ФНС-календарь, ЕНС, налоговую книгу, банковскую
                сверку, НПД и закрытие периода. Здесь только действия,
                которые действительно требуют решения.
              </p>
            </div>
            <div className="accounting-autopilot-score">
              <span><strong>{autopilot.summary.critical}</strong> критично</span>
              <span><strong>{autopilot.summary.warning}</strong> проверить</span>
            </div>
          </div>

          <div className="accounting-autopilot-grid">
            {autopilot.tasks
              .filter(task=>task.status!=="DISMISSED")
              .slice(0,6)
              .map(task=>(
              <article
                key={task.id}
                className={
                  "accounting-autopilot-card severity-"+
                  task.severity.toLowerCase()
                }
              >
                <div className="accounting-autopilot-card-head">
                  <span className="status-pill">
                    {task.severity==="CRITICAL"
                      ?"Срочно"
                      :task.severity==="WARNING"
                        ?"Проверить"
                        :"На контроле"}
                    {" · "}
                    {task.category.replaceAll("_"," ")}
                  </span>
                  {task.amount_minor?(
                    <strong>{rub(task.amount_minor)}</strong>
                  ):null}
                </div>
                <h4>{task.title}</h4>
                <p>{task.description}</p>
                <div className="accounting-autopilot-card-footer">
                  <span className="muted">
                    {task.due_at
                      ?"Срок: "+date(task.due_at)
                      :"Автоматическая проверка"}
                  </span>
                  <div className="studio-card-actions">
                    {task.action_href?(
                      <a className="primary-button" href={task.action_href}>
                        Исправить
                      </a>
                    ):null}
                    {task.status==="OPEN"?(
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={busy}
                        onClick={()=>void updateAutopilotTask(
                          task,"IN_PROGRESS"
                        )}
                      >
                        В работу
                      </button>
                    ):null}
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={busy}
                      onClick={()=>void updateAutopilotTask(
                        task,"DISMISSED"
                      )}
                    >
                      Скрыть
                    </button>
                  </div>
                </div>
              </article>
            ))}
            {!autopilot.tasks.some(task=>task.status!=="DISMISSED")?(
              <div className="accounting-autopilot-empty">
                <strong>✓ Всё под контролем</strong>
                <span>
                  Открытых рисков нет. Автопилот пересчитает состояние после
                  изменений в банке, налогах, ЕНС и закрытии периода.
                </span>
              </div>
            ):null}
          </div>
        </section>
      ):null}

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

      {profile?.compliance_enabled===false?(
        <div className="compliance-notice">
          <strong>Налоговый контур выключен</strong>
          <span>
            Внутренний бухгалтерский и управленческий учёт продолжает работать.
            CoreBiz не создаёт новые регламентные задачи ФНС и не готовит их к отправке.
          </span>
        </div>
      ):null}

      {showProfile?(
        <section className="section-block compliance-profile-card">
          <div className="section-heading">
            <div>
              <p className="muted">Настройка один раз</p>
              <h3>Как {legalEntityName} платит налоги</h3>
            </div>
            <span className="tax-safety-chip">
              ИНН {inn??"не указан"}
            </span>
          </div>

          <div className="compliance-profile-grid">
            <label>
              <span>Тип</span>
              <select
                value={entityKind}
                onChange={event=>
                  setEntityKind(
                    event.target.value as "ORGANIZATION"|"IP"
                  )
                }
              >
                <option value="ORGANIZATION">Организация</option>
                <option value="IP">ИП</option>
              </select>
            </label>
            <label>
              <span>Налоговый режим</span>
              <select
                value={taxRegime}
                onChange={event=>
                  setTaxRegime(
                    event.target.value as TaxProfile["tax_regime"]
                  )
                }
              >
                <option value="USN_INCOME">УСН · Доходы</option>
                <option value="USN_INCOME_EXPENSE">
                  УСН · Доходы минус расходы
                </option>
                <option value="OSNO">ОСНО</option>
                <option value="AUSN">АУСН</option>
                <option value="OTHER">Другой</option>
              </select>
            </label>
            <label>
              <span>НДС</span>
              <select
                value={vatMode}
                onChange={event=>
                  setVatMode(
                    event.target.value as TaxProfile["vat_mode"]
                  )
                }
              >
                <option value="NO_VAT">Без НДС / освобождение</option>
                <option value="VAT_5">5%</option>
                <option value="VAT_7">7%</option>
                <option value="VAT_22">22%</option>
                <option value="VAT_MIXED">Смешанный</option>
              </select>
            </label>
            {taxRegime.startsWith("USN_")?(
              <label>
                <span>Ставка УСН, %</span>
                <input
                  inputMode="decimal"
                  value={usnRate}
                  onChange={event=>setUsnRate(event.target.value)}
                />
              </label>
            ):null}
            {taxRegime==="USN_INCOME_EXPENSE"?(
              <label>
                <span>Минимальный налог, %</span>
                <input
                  inputMode="decimal"
                  value={usnMinRate}
                  onChange={event=>setUsnMinRate(event.target.value)}
                />
              </label>
            ):null}
            <label>
              <span>КПП</span>
              <input
                inputMode="numeric"
                value={kpp}
                onChange={event=>setKpp(event.target.value)}
                placeholder={entityKind==="ORGANIZATION"?"9 цифр":"Для ИП не требуется"}
                disabled={entityKind==="IP"}
              />
            </label>
            <label>
              <span>ОКТМО</span>
              <input
                inputMode="numeric"
                value={oktmo}
                onChange={event=>setOktmo(event.target.value)}
                placeholder="8 или 11 цифр"
              />
            </label>
            <label>
              <span>Код ИФНС</span>
              <input
                inputMode="numeric"
                value={taxOfficeCode}
                onChange={event=>setTaxOfficeCode(event.target.value)}
                placeholder="4 цифры"
              />
            </label>
            <label className="compliance-checkbox">
              <input
                type="checkbox"
                checked={hasEmployees}
                onChange={event=>setHasEmployees(event.target.checked)}
              />
              <span>Есть сотрудники / выплаты физлицам</span>
            </label>
            <label>
              <span>Регламентированный контур</span>
              <select
                value={complianceEnabled?"ENABLED":"DISABLED"}
                onChange={event=>
                  setComplianceEnabled(event.target.value==="ENABLED")
                }
              >
                <option value="ENABLED">Включён · ФНС, сроки, платежи</option>
                <option value="DISABLED">Выключен · только внутренний учёт</option>
              </select>
            </label>
            {!complianceEnabled?(
              <label>
                <span>Причина отключения</span>
                <input
                  value={complianceDisabledReason}
                  onChange={event=>
                    setComplianceDisabledReason(event.target.value)
                  }
                  placeholder="Например: отчётность ведёт внешний бухгалтер"
                />
              </label>
            ):null}
          </div>

          <div className="compliance-profile-footer">
            <p>
              Ставка не подставляется «навечно»: для УСН её нужно подтвердить
              с учётом региона. Основная ставка НДС для операций 2026 года — 22%.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={()=>void saveProfile()}
            >
              Сохранить профиль
            </button>
          </div>
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
          <small>
            {urgent.length?"нужны действия":"ничего срочного"}
          </small>
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
            {ensLatest
              ?"на "+date(ensLatest.as_of)
              :"добавьте снимок из ФНС/оператора"}
          </small>
        </article>
      </div>

      <section className="compliance-next-card">
        <div className="section-heading">
          <div>
            <p className="muted">Приоритет</p>
            <h3>
              {next?.title??"На ближайший период обязательств нет"}
            </h3>
          </div>
          {next?(
            <span
              className={
                "status-pill compliance-status "+
                next.workflow_status.toLowerCase()
              }
            >
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
                {next.amount_minor!==null
                  ?" Сумма "+rub(next.amount_minor)+"."
                  :""}
              </p>
            </div>
            {next.form_code==="KND_1110355" &&
             ["PLANNED","READY","REJECTED"].includes(next.workflow_status)?(
              <div className="compliance-document-editor">
                <div className="compliance-document-head">
                  <div>
                    <span>КНД 1110355</span>
                    <strong>Реквизиты строки уведомления</strong>
                    <p>
                      Заполните налоговую строку до подготовки пакета.
                      Сумма строки станет подтверждённой суммой обязательства.
                    </p>
                  </div>
                  <span
                    className={
                      "status-pill "+
                      (notificationLine?.status==="CONFIRMED"
                        ?"confirmed"
                        :"review_required")
                    }
                  >
                    {notificationLine?.status==="CONFIRMED"
                      ?"Строка подтверждена"
                      :"Нужно заполнить"}
                  </span>
                </div>

                <div className="compliance-document-grid">
                  {entityKind==="ORGANIZATION"?(
                    <label>
                      <span>КПП</span>
                      <input
                        value={lineKpp}
                        onChange={event=>setLineKpp(event.target.value)}
                        inputMode="numeric"
                        placeholder="9 цифр"
                      />
                    </label>
                  ):null}
                  <label>
                    <span>ОКТМО</span>
                    <input
                      value={lineOktmo}
                      onChange={event=>setLineOktmo(event.target.value)}
                      inputMode="numeric"
                      placeholder="8 или 11 цифр"
                    />
                  </label>
                  <label>
                    <span>КБК</span>
                    <input
                      value={lineKbk}
                      onChange={event=>setLineKbk(event.target.value)}
                      inputMode="numeric"
                      placeholder="20 цифр"
                    />
                  </label>
                  <label>
                    <span>Код периода</span>
                    <input
                      value={linePeriodCode}
                      onChange={event=>setLinePeriodCode(event.target.value)}
                      placeholder="Например 34/01"
                    />
                  </label>
                  <label>
                    <span>Отчётный год</span>
                    <input
                      value={lineYear}
                      onChange={event=>setLineYear(event.target.value)}
                      inputMode="numeric"
                    />
                  </label>
                  <label>
                    <span>Сумма, ₽</span>
                    <input
                      value={lineAmountRub}
                      onChange={event=>setLineAmountRub(event.target.value)}
                      inputMode="decimal"
                      placeholder="0"
                    />
                  </label>
                </div>

                <div className="compliance-document-footer">
                  <p>
                    КБК и код периода должны соответствовать конкретному
                    обязательству. CoreBiz сохраняет их в аудируемой строке,
                    а не только внутри PDF/JSON.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={()=>void saveNotificationLine(next)}
                  >
                    {notificationLine?.status==="CONFIRMED"
                      ?"Обновить подтверждённую строку"
                      :"Сохранить и подтвердить"}
                  </button>
                </div>
              </div>
            ):null}

            <div className="table-actions">
              {["PLANNED","REJECTED"].includes(
                next.workflow_status
              )?(
                <button
                  type="button"
                  onClick={()=>void preparePacket(next)}
                >
                  Подготовить пакет
                </button>
              ):null}
              {next.workflow_status==="READY" &&
               next.validation_status!=="VALID"?(
                <button
                  type="button"
                  onClick={()=>void validatePacket(next)}
                >
                  Проверить пакет
                </button>
              ):null}
              {next.workflow_status==="READY" &&
               next.validation_status==="VALID"?(
                <button
                  type="button"
                  onClick={()=>void approveObligation(next)}
                >
                  Утвердить
                </button>
              ):null}
              {next.workflow_status==="APPROVED" &&
               next.signature_status!=="SIGNED" &&
               next.obligation_type!=="PAY"?(
                <button
                  type="button"
                  onClick={()=>void signWithConnector(next)}
                >
                  Подтвердить КЭП
                </button>
              ):null}
              {next.workflow_status==="APPROVED" &&
               next.signature_status==="SIGNED" &&
               next.obligation_type!=="PAY"?(
                <button
                  type="button"
                  onClick={()=>void recordSubmitted(next)}
                >
                  Зафиксировать отправку
                </button>
              ):null}
              {next.workflow_status==="APPROVED" &&
               next.obligation_type==="PAY"?(
                <>
                  <select
                    aria-label="Счёт для налогового платежа"
                    value={taxPayAccountId}
                    onChange={event=>setTaxPayAccountId(event.target.value)}
                  >
                    <option value="">Выберите счёт</option>
                    {assignedAccounts.map(account=>(
                      <option key={account.id} value={account.id}>
                        {account.name} · {account.currency}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={busy||!assignedAccounts.length}
                    onClick={()=>void payTax(next)}
                  >
                    Зарегистрировать оплату
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={()=>void recordReceipt(next,"PAYMENT")}
                  >
                    Оплачено вне CoreBiz
                  </button>
                </>
              ):null}
              {next.workflow_status==="SUBMITTED"?(
                <>
                  <button
                    type="button"
                    onClick={()=>void recordReceipt(next,"ACCEPTED")}
                  >
                    Принято ФНС
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={()=>void recordReceipt(next,"REJECTED")}
                  >
                    Есть отказ
                  </button>
                </>
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
            Настройте профиль и обновите календарь. CoreBiz покажет
            обязательства на год вперёд.
          </p>
        )}
      </section>

      <div className="compliance-grid">
        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Деньги → налоги</p>
              <h3>Счета этого юрлица</h3>
            </div>
            <span className="tax-safety-chip">
              привязано {assignedAccounts.length}
            </span>
          </div>

          <div className="compliance-account-list">
            {assignedAccounts.map(account=>(
              <article key={account.id}>
                <div>
                  <strong>{account.name}</strong>
                  <span>{account.kind} · {account.currency}</span>
                </div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={()=>void assignCashAccount(account.id,false)}
                >
                  Отвязать
                </button>
              </article>
            ))}
            {unassignedAccounts.map(account=>(
              <article key={account.id}>
                <div>
                  <strong>{account.name}</strong>
                  <span>Не распределён · {account.currency}</span>
                </div>
                <button
                  type="button"
                  onClick={()=>void assignCashAccount(account.id,true)}
                >
                  Привязать
                </button>
              </article>
            ))}
            {!assignedAccounts.length&&!unassignedAccounts.length?(
              <div className="table-empty">
                <strong>Нет денежных счетов</strong>
                <span>
                  Создайте банковский или кассовый счёт в разделе «Финансы».
                </span>
              </div>
            ):null}
          </div>
        </section>

        <section className="section-block compliance-usn-card">
          <div className="section-heading">
            <div>
              <p className="muted">Предварительный налог</p>
              <h3>Расчёт УСН</h3>
            </div>
            <span className="tax-safety-chip">
              {reviewCount?"сначала проверка":"можно считать"}
            </span>
          </div>

          {profile?.tax_regime.startsWith("USN_")?(
            <>
              <div className="compliance-usn-controls">
                <label>
                  <span>Уменьшения / авансы, ₽</span>
                  <input
                    inputMode="decimal"
                    value={reductionsRub}
                    onChange={event=>
                      setReductionsRub(event.target.value)
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={busy||reviewCount>0}
                  onClick={()=>void calculateUsn()}
                >
                  Рассчитать с начала года
                </button>
              </div>

              {calculation?(
                <div className="compliance-calculation">
                  <div>
                    <span>Доход учтён</span>
                    <strong>
                      {rub(calculation.taxable_income_minor)}
                    </strong>
                  </div>
                  <div>
                    <span>Расход принят</span>
                    <strong>
                      {rub(calculation.deductible_expense_minor)}
                    </strong>
                  </div>
                  <div>
                    <span>Предварительно к уплате</span>
                    <strong>{rub(calculation.tax_due_minor)}</strong>
                  </div>
                  <div className="compliance-calculation-confirm">
                    <input
                      value={calculationNote}
                      onChange={event=>
                        setCalculationNote(event.target.value)
                      }
                      placeholder="Комментарий к проверке"
                    />
                    <button
                      type="button"
                      disabled={
                        busy||
                        calculation.status==="CONFIRMED"||
                        reviewCount>0
                      }
                      onClick={()=>void confirmCalculation()}
                    >
                      Подтвердить расчёт
                    </button>
                  </div>
                </div>
              ):(
                <p className="workspace-summary">
                  CoreBiz использует только подтверждённые строки налоговой
                  книги. Спорные расходы не уменьшают налог автоматически.
                </p>
              )}
            </>
          ):(
            <p className="workspace-summary">
              Блок появится после выбора УСН в налоговом профиле.
            </p>
          )}
        </section>
      </div>

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
            {ledger.slice(0,12).map(item=>(
              <article key={item.id}>
                <div>
                  <small>
                    {item.recognition_date} ·
                    {" "+(item.payment_number??"движение")}
                  </small>
                  <strong>
                    {item.party_name??item.category_code??item.direction}
                  </strong>
                  <span>
                    {item.direction==="INCOME"?"Доход":"Расход"}
                    {" · "+rub(item.amount_minor)}
                  </span>
                </div>
                <div className="compliance-ledger-action">
                  <span
                    className={
                      "status-pill "+
                      item.tax_treatment.toLowerCase()
                    }
                  >
                    {statusLabel(item.tax_treatment)}
                  </span>
                  {item.tax_treatment==="REVIEW_REQUIRED"?(
                    <div className="table-actions">
                      <button
                        type="button"
                        onClick={()=>
                          void reviewLedger(item,"INCLUDED")
                        }
                      >
                        Учесть
                      </button>
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={()=>
                          void reviewLedger(item,"EXCLUDED")
                        }
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
                  Привяжите денежный счёт и нажмите
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
            {active.slice(0,10).map(item=>(
              <article key={item.id}>
                <div className="compliance-date-badge">
                  <strong>
                    {new Date(item.due_at).toLocaleDateString(
                      "ru-RU",{day:"2-digit"}
                    )}
                  </strong>
                  <span>
                    {new Date(item.due_at).toLocaleDateString(
                      "ru-RU",{month:"short"}
                    )}
                  </span>
                </div>
                <div>
                  <strong>{item.title}</strong>
                  <span>
                    {item.authority}
                    {" · "+statusLabel(item.workflow_status)}
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

      {providerDialog?(
        <div
          className="compliance-dialog-backdrop"
          role="presentation"
          onMouseDown={event=>{
            if(event.target===event.currentTarget&&!busy){
              setProviderDialog(null);
            }
          }}
        >
          <section
            className="compliance-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="compliance-dialog-title"
          >
            <div className="compliance-dialog-head">
              <div>
                <span className="compliance-eyebrow">
                  {providerDialog.provider}
                </span>
                <h3 id="compliance-dialog-title">
                  {providerDialog.kind==="SIGN"
                    ?"Подтверждение электронной подписи"
                    :providerDialog.kind==="SUBMIT"
                      ?"Подтверждение отправки"
                      :providerDialog.receiptType==="PAYMENT"
                        ?"Подтверждение оплаты"
                        :"Квитанция ФНС / оператора"}
                </h3>
              </div>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={()=>setProviderDialog(null)}
              >
                Закрыть
              </button>
            </div>
            <p>
              {providerDialog.kind==="SIGN"
                ?"Укажите реальный идентификатор подписи или операции, полученный от подключённого оператора."
                :providerDialog.kind==="SUBMIT"
                  ?"Укажите идентификатор фактической отправки у оператора. Это не выполняет отправку само по себе."
                  :"Сохраните номер квитанции или подтверждения, полученного из внешней системы."}
            </p>
            <label>
              <span>
                {providerDialog.kind==="SIGN"
                  ?"Идентификатор подписи"
                  :providerDialog.receiptType==="PAYMENT"
                    ?"Номер подтверждения оплаты"
                    :"Идентификатор / номер квитанции"}
              </span>
              <input
                autoFocus
                value={providerReference}
                onChange={event=>setProviderReference(event.target.value)}
                placeholder="Например, reference оператора"
              />
            </label>
            {providerDialog.kind==="RECEIPT"&&
             providerDialog.receiptType==="REJECTED"?(
              <label>
                <span>Причина отказа</span>
                <textarea
                  rows={4}
                  value={providerReason}
                  onChange={event=>setProviderReason(event.target.value)}
                  placeholder="Скопируйте причину из квитанции"
                />
              </label>
            ):null}
            <div className="compliance-dialog-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={()=>setProviderDialog(null)}
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={busy||!providerReference.trim()}
                onClick={()=>void confirmProviderDialog()}
              >
                {busy?"Сохраняем…":"Подтвердить"}
              </button>
            </div>
          </section>
        </div>
      ):null}

      <p className="compliance-disclaimer">
        Налоговые расчёты являются предварительными до подтверждения.
        Календарь хранит версию нормативного правила; переносы из-за
        официальных праздничных дней требуют обновлённого производственного
        календаря. Электронная отправка считается завершённой только после
        подтверждённой подписи и квитанции оператора/ФНС.
      </p>
    </div>
  );
}
