"use client";
import {useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../../components/app-sidebar";
import {apiRequest} from "../../../../../lib/api";

type Site={id:string;name:string};
type Provider="CDEK"|"ATOL_ONLINE";
type Connection={
  id:string;provider:Provider;state:string;
  environment:"SANDBOX"|"PRODUCTION";enabled:boolean;
  public_config:{fromCityCode?:number;groupCode?:string;fiscalCompany?:FiscalCompany};
  verified_at:string|null;last_error_code:string|null
};
type Quote={
  quoteId:string;tariffCode:number;amountMinor:string;
  periodMin:number|null;periodMax:number|null;expiresAt:string
};
type Shipment={
  id:string;sales_order_id:string;business_number:string;state:string;
  provider_order_uuid:string|null;provider_number:string|null;
  amount_minor:string;last_error_code:string|null;created_at:string
};
type FiscalReportHealth={
  pollingEnabled:boolean;
  queue:Array<{state:string;count:number;oldestDue:string|null}>;
  manualAttentionWithoutUuid:number;
};
type FiscalCompany={inn:string;email:string;sno:string;paymentAddress:string;vatType:string};
type FiscalPending={payment_intent_id:string;business_number:string;amount_minor:string};
type FiscalFollowup={payment_intent_id:string;business_number:string;
  amount_minor:string;kind:"REFUND"|"CLOSING"|"HANDOVER";delivery_status:string};
type FiscalDocument={id:string;payment_intent_id:string;operation:string;state:string;provider_uuid:string|null;
  fn_number:string|null;fiscal_document_number:number|null;
  fiscal_document_attribute:string|null;receipt_url:string|null;last_error_code:string|null};


const money=(minor:string)=>new Intl.NumberFormat("ru-RU",{
  currency:"RUB",style:"currency"
}).format(Number(minor)/100);
export default function MerchantConnectorsPage(){
  const [sites,setSites]=useState<Site[]>([]);
  const [siteId,setSiteId]=useState("");
  const [connections,setConnections]=useState<Connection[]>([]);
  const [provider,setProvider]=useState<Provider>("CDEK");
  const [environment,setEnvironment]=useState<"SANDBOX"|"PRODUCTION">("SANDBOX");
  const [clientId,setClientId]=useState("");
  const [clientSecret,setClientSecret]=useState("");
  const [city,setCity]=useState("44");
  const [atolLogin,setAtolLogin]=useState("");
  const [atolPassword,setAtolPassword]=useState("");
  const [atolGroup,setAtolGroup]=useState("");
  const [fiscalCompany,setFiscalCompany]=useState<FiscalCompany>({
    inn:"",email:"",sno:"usn_income",paymentAddress:"",vatType:"none"
  });
  const [atolPending,setAtolPending]=useState<FiscalPending[]>([]);
  const [atolFollowups,setAtolFollowups]=useState<FiscalFollowup[]>([]);
  const [atolDocs,setAtolDocs]=useState<FiscalDocument[]>([]);
  const [reportHealth,setReportHealth]=useState<FiscalReportHealth|null>(null);
  const [nonMarkedConfirmed,setNonMarkedConfirmed]=useState(false);
  const [fiscalUnknownUuid,setFiscalUnknownUuid]=useState("");
  const [handoverProof,setHandoverProof]=useState("");

  const [toCity,setToCity]=useState("137");
  const [weight,setWeight]=useState("1000");
  const [length,setLength]=useState("20");
  const [width,setWidth]=useState("20");
  const [height,setHeight]=useState("20");
  const [quotes,setQuotes]=useState<Quote[]>([]);
  const [shipments,setShipments]=useState<Shipment[]>([]);
  const [shipOrderId,setShipOrderId]=useState("");
  const [shipName,setShipName]=useState("");
  const [shipPhone,setShipPhone]=useState("");
  const [unknownUuid,setUnknownUuid]=useState("");

  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [note,setNote]=useState("");
  useEffect(()=>{
    void apiRequest<Site[]>("/sites").then(rows=>{
      setSites(rows);setSiteId(rows[0]?.id??"");
    }).catch(e=>setError(e instanceof Error?e.message:"Нет доступа к сайтам"));
  },[]);
  const load=useCallback(async()=>{
    if(!siteId)return;
    try{
      const [connections,shipments,pending,receipts,followups,health]=await Promise.all([
        apiRequest<Connection[]>("/provider-connectors/sites/"+siteId),
        apiRequest<Shipment[]>("/provider-connectors/sites/"+siteId+"/shipments"),
        apiRequest<FiscalPending[]>("/provider-connectors/sites/"+siteId+
          "/atol/pending-payments").catch(()=>[]),
        apiRequest<FiscalDocument[]>("/provider-connectors/sites/"+siteId+
          "/atol/receipts").catch(()=>[]),
        apiRequest<FiscalFollowup[]>("/provider-connectors/sites/"+siteId+
          "/atol/pending-followups").catch(()=>[]),
        apiRequest<FiscalReportHealth>("/provider-connectors/sites/"+siteId+
          "/atol/report-health").catch(()=>null)
      ]);
      setConnections(connections);setShipments(shipments);
      setAtolPending(pending);setAtolDocs(receipts);
      setAtolFollowups(followups);
      setReportHealth(health);
      const cfg=connections.find(c=>c.provider==="ATOL_ONLINE");
      if(cfg?.public_config?.fiscalCompany)
        setFiscalCompany(cfg.public_config.fiscalCompany);
    }catch(e){setError(e instanceof Error?e.message:"Подключения не загружены");}
  },[siteId]);
  useEffect(()=>{void load();},[load]);
  const current=connections.find(c=>c.provider===provider);
  async function save(){
    if(!siteId||busy)return;
    setBusy(true);setError("");setNote("");
    try{
      const credentials=provider==="CDEK"
        ?{clientId,clientSecret}:{login:atolLogin,password:atolPassword,
          groupCode:atolGroup};
      await apiRequest("/provider-connectors/sites/"+siteId+"/configure",{
        method:"POST",body:JSON.stringify({
          provider,environment,credentials,
          ...(provider==="CDEK"?{fromCityCode:Number(city)}
            :{fiscalCompany})
        })
      });
      setClientSecret("");setAtolPassword("");
      setNote("Реквизиты сохранены зашифрованными. Теперь проверьте авторизацию.");
      await load();setQuotes([]);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сохранить ключи");}
    finally{setBusy(false);}
  }
  async function verify(){
    if(!siteId||busy)return;
    setBusy(true);setError("");setNote("");
    try{
      const row=await apiRequest<{state:string;note:string}>(
        "/provider-connectors/sites/"+siteId+"/"+provider+"/verify",{
          method:"POST"
        });
      setNote(row.note);await load();
    }catch(e){setError(e instanceof Error?e.message:"Провайдер отклонил проверку");}
    finally{setBusy(false);}
  }
  async function quote(){
    if(!siteId||busy)return;
    setBusy(true);setError("");setNote("");
    try{
      const rows=await apiRequest<Quote[]>(
        "/provider-connectors/sites/"+siteId+"/cdek/quotes",{
          method:"POST",body:JSON.stringify({
            toCityCode:Number(toCity),weightGrams:Number(weight),
            lengthCm:Number(length),widthCm:Number(width),heightCm:Number(height)
          })
        });
      setQuotes(rows);setNote(rows.length?"Тарифы получены от СДЭК.":"СДЭК не предложил тарифов для этих параметров.");
    }catch(e){setError(e instanceof Error?e.message:"Расчёт доставки недоступен");}
    finally{setBusy(false);}
  }
  async function issueFiscal(paymentId:string){
    if(!nonMarkedConfirmed||busy)return;
    if(!window.confirm(
      "Отправить действительный чек предоплаты на ККТ АТОЛ? "+
      "Операция юридически значима и не может быть повторена автоматически."
    ))return;
    setBusy(true);setError("");setNote("");
    try{
      const receipt=await apiRequest<{state:string;note?:string}>(
        "/provider-connectors/sites/"+siteId+
        "/atol/payments/"+paymentId+"/receipt",{
          method:"POST",body:JSON.stringify({nonMarkedConfirmed:true})
        });
      setNote(receipt.note??("Состояние АТОЛ: "+receipt.state+
        ". Для получения ФН/ФД/ФП нажмите «Сверить»"));
      await load();
    }catch(e){
      setError(e instanceof Error?e.message:
        "Чек не отправлен: проверьте журнал, не дублируйте фискальную операцию");
    }finally{setBusy(false);}
  }
  async function confirmHandover(item:FiscalFollowup){
    if(busy||handoverProof.trim().length<8)return;
    if(!window.confirm(
      "Подтвердите, что товар действительно передан покупателю и отгрузка "+
      "уже проведена на складе. Это действие попадёт в журнал аудита."
    ))return;
    setBusy(true);setError("");setNote("");
    try{
      await apiRequest("/provider-connectors/sites/"+siteId+
        "/atol/payments/"+item.payment_intent_id+"/confirm-handover",{
          method:"POST",body:JSON.stringify({
            proofReference:handoverProof.trim(),confirmed:true
          })
        });
      setHandoverProof("");
      setNote("Факт выдачи подтверждён. Теперь можно оформить чек зачёта аванса.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:
      "Выдача не подтверждена. Проверьте отгрузку и статус перевозчика.");}
    finally{setBusy(false);}
  }
  async function fiscalFollowup(item:FiscalFollowup){
    if(!nonMarkedConfirmed||busy)return;
    const returning=item.kind==="REFUND";
    if(!window.confirm(returning
      ?"Отправить чек возврата прихода? Банк уже должен вернуть деньги. "
        +"ККТ сформирует отдельный фискальный документ."
      :"Сформировать чек полного расчёта с зачётом аванса? "
        +"Товар должен быть фактически выдан, второго списания с карты не будет."))return;
    setBusy(true);setError("");setNote("");
    try{
      const result=await apiRequest<{state:string;note?:string}>(
        "/provider-connectors/sites/"+siteId+"/atol/payments/"+
          item.payment_intent_id+
          (returning?"/refund-receipt":"/settlement"),{
            method:"POST",body:JSON.stringify({nonMarkedConfirmed:true})
          });
      setNote(result.note??("АТОЛ: "+result.state+". Дождитесь ФН/ФД/ФП."));
      await load();
    }catch(e){
      setError(e instanceof Error?e.message:
        "АТОЛ не подтвердил операцию. Не дублируйте запрос без сверки.");
    }finally{setBusy(false);}
  }

  async function verifyFiscal(document:FiscalDocument){
    setBusy(true);setError("");setNote("");
    try{
      const result=await apiRequest<{
        state:string;fnNumber?:string;documentNumber?:number;fiscalSign?:string
      }>("/provider-connectors/sites/"+siteId+
        "/atol/receipts/"+document.id+"/verify",{
          method:"POST",body:JSON.stringify({
            ...(document.provider_uuid?{}:{providerUuid:fiscalUnknownUuid.trim()})
          })
        });
      setNote(result.state==="DONE"
        ?("Чек подтверждён: ФН "+result.fnNumber+
          ", ФД "+result.documentNumber+", ФП "+result.fiscalSign)
        :("Состояние чека: "+result.state));
      setFiscalUnknownUuid("");await load();
    }catch(e){
      setError(e instanceof Error?e.message:"АТОЛ не подтвердил фискальные реквизиты");
    }finally{setBusy(false);}
  }

  async function book(quoteId:string){
    if(!window.confirm(
      "Создать реальное отправление у СДЭК? Операция может привести к расходам по договору магазина. "
      +"Заказ должен быть оплачен, зарезервирован и оформлен на курьерскую доставку."
    ))return;
    setBusy(true);setError("");setNote("");
    try{
      const result=await apiRequest<{shipmentId:string;state:string;note?:string}>(
        "/provider-connectors/sites/"+siteId+"/cdek/shipments",{
          method:"POST",body:JSON.stringify({
            orderId:shipOrderId.trim(),quoteId,
            recipientName:shipName.trim(),recipientPhone:shipPhone.trim(),
            lengthCm:Number(length),widthCm:Number(width),heightCm:Number(height)
          })
        });
      setNote(result.state==="UNKNOWN"
        ?"СДЭК мог создать отправление. Не повторяйте! Сверьте UUID в кабинете и проверьте существующее."
        :result.note??"Накладная отправлена в СДЭК. Проверьте статус.");
      await load();setQuotes([]);
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось отправить накладную; перед повтором проверьте СДЭК.");
    }finally{setBusy(false);}
  }
  async function verifyShipment(row:Shipment){
    setBusy(true);setError("");setNote("");
    try{
      const checked=await apiRequest<{
        state:string;trackingNumber:string|null
      }>("/provider-connectors/sites/"+siteId+"/cdek/shipments/"+row.id+"/verify",{
        method:"POST",body:JSON.stringify({
          ...(row.provider_order_uuid?{}:{providerUuid:unknownUuid.trim()})
        })
      });
      setNote("СДЭК подтвердил: "+checked.state+
        (checked.trackingNumber?" · "+checked.trackingNumber:""));
      setUnknownUuid("");await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось сверить UUID СДЭК");}
    finally{setBusy(false);}
  }

  return <main className="app-shell">
    <AppSidebar active="settings"/>
    <section className="workspace workspace-wide studio-premium">
      <header className="studio-hero compact"><div>
        <span className="studio-eyebrow">Провайдеры продавца · по каждому сайту</span>
        <h1>Подключение СДЭК и АТОЛ Онлайн</h1>
        <p>Сохраняем секретные ключи зашифрованными, проверяем их непосредственно
          у провайдера. Без проверки не показываем статус подключения.</p>
      </div><a className="secondary-button"
        href="/app/settings/integrations">Все интеграции</a></header>
      {error?<p className="inline-error" role="alert">{error}</p>:null}
      {note?<p role="status">{note}</p>:null}
      <section className="studio-section">
        <div className="studio-form-grid">
          <label>Интернет-магазин
            <select value={siteId} onChange={e=>{setSiteId(e.target.value);setQuotes([]);}}>
              {sites.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}
            </select>
          </label>
          <label>Провайдер
            <select value={provider} onChange={e=>{setProvider(e.target.value as Provider);setQuotes([]);}}>
              <option value="CDEK">СДЭК API v2</option>
              <option value="ATOL_ONLINE">АТОЛ Онлайн v5 · ФФД 1.2</option>
            </select>
          </label>
          <label>Контур
            <select value={environment}
              onChange={e=>setEnvironment(e.target.value as typeof environment)}>
              <option value="SANDBOX">Тестовый</option>
              <option value="PRODUCTION">Рабочий</option>
            </select>
          </label>
        </div>
        <p><strong>Статус:</strong> {current?.state??"Реквизиты не сохранены"}
          {current?.verified_at?" · проверено "+new Date(current.verified_at).toLocaleString("ru-RU"):""}
          {current?.environment?" · "+current.environment:""}
        </p>
        <p className="muted">Повторное сохранение реквизитов отключает ранее проверенное
          подключение до повторной авторизации.</p>
      </section>
      <section className="studio-section">
        <h2>{provider==="CDEK"?"Учётные данные СДЭК":"Кассовые реквизиты АТОЛ"}</h2>
        <div className="studio-form-grid">
          {provider==="CDEK"?<>
            <label>Client ID
              <input value={clientId} onChange={e=>setClientId(e.target.value)}
                autoComplete="off"/>
            </label>
            <label>Client Secret
              <input type="password" value={clientSecret}
                onChange={e=>setClientSecret(e.target.value)}
                autoComplete="new-password"/>
            </label>
            <label>Код города отправления (СДЭК)
              <input type="number" min="1" step="1" value={city}
                onChange={e=>setCity(e.target.value)}/>
            </label>
          </>:<>
            <label>Login АТОЛ
              <input value={atolLogin} onChange={e=>setAtolLogin(e.target.value)}
                autoComplete="off"/>
            </label>
            <label>Password АТОЛ
              <input type="password" value={atolPassword}
                onChange={e=>setAtolPassword(e.target.value)}
                autoComplete="new-password"/>
            </label>
            <label>Код группы ККТ
              <input value={atolGroup} onChange={e=>setAtolGroup(e.target.value)}/>
            </label>
            {([
              ["inn","ИНН юридического лица/ИП"],
              ["email","Email для отправки чеков"],
              ["paymentAddress","Место расчёта (адрес сайта)"]
            ] as const).map(([key,label])=>(
              <label key={key}>{label}
                <input value={fiscalCompany[key]}
                  onChange={e=>setFiscalCompany(old=>({
                    ...old,[key]:e.target.value
                  }))}/>
              </label>
            ))}
            <label>Система налогообложения
              <select value={fiscalCompany.sno}
                onChange={e=>setFiscalCompany(old=>({...old,sno:e.target.value}))}>
                <option value="osn">ОСНО</option>
                <option value="usn_income">УСН доходы</option>
                <option value="usn_income_outcome">УСН доходы − расходы</option>
                <option value="esn">ЕСХН</option>
                <option value="patent">ПСН</option>
              </select>
            </label>
            <label>НДС для всех позиций пилотного чека
              <select value={fiscalCompany.vatType}
                onChange={e=>setFiscalCompany(old=>({...old,vatType:e.target.value}))}>
                <option value="none">Без НДС</option>
                <option value="vat0">0%</option>
                <option value="vat5">5%</option>
                <option value="vat7">7%</option>
                <option value="vat10">10%</option>
                <option value="vat20">20% (для старых операций)</option>
                <option value="vat22">22% (2026)</option>
              </select>
            </label>
          </>}
        </div>
        <div className="studio-hero-actions">
          <button type="button" disabled={!siteId||busy}
            onClick={()=>void save()}>Сохранить ключи</button>
          <button type="button" className="secondary-button"
            disabled={!siteId||!current||busy} onClick={()=>void verify()}>
            Проверить доступ у провайдера
          </button>
        </div>
        <p className="muted">{provider==="ATOL_ONLINE"
          ?"Авторизация по API v5 не фискализирует чек. Для отправки чеков потребуется отдельный жизненный цикл."
          :"Авторизация не создаёт доставку. Отправления включим после приёмки накладных, ярлыков и статусов."}</p>
      </section>
      {provider==="ATOL_ONLINE"?<section className="studio-section">
        <h2>Предоплата и фискальные документы</h2>
        <p>Одна подтверждённая оплата YooKassa → один чек АТОЛ. Документы
          создаются из строк заказа. Отправка возможна только при включённом
          фискальном контуре сервера и проверенной кассе.</p>
        <label>
          <input type="checkbox" checked={nonMarkedConfirmed}
            onChange={e=>setNonMarkedConfirmed(e.target.checked)}/>
          Подтверждаю, что в этих заказах нет маркируемых или подакцизных
          товаров и применима указанная ставка НДС.
        </label>
        <h3>Оплачены банком, ожидают чек АТОЛ</h3>
        {atolPending.length?atolPending.map(payment=><div
          key={payment.payment_intent_id} className="first-day-step">
          <div><strong>{payment.business_number}</strong>
            <p>{money(payment.amount_minor)}</p></div>
          <button type="button" disabled={busy||!nonMarkedConfirmed}
            onClick={()=>void issueFiscal(payment.payment_intent_id)}>
            Отправить чек предоплаты</button>
        </div>):<p>Нет доступных платежей для чеков АТОЛ.</p>}
        <h3>Выдача товаров и возвраты</h3>
        <label>Номер документа вручения / акта выдачи
          <input value={handoverProof}
            onChange={e=>setHandoverProof(e.target.value)}
            placeholder="Например, акт выдачи № 12345"/>
        </label>
        {atolFollowups.length?atolFollowups.map(item=><div
          className="first-day-step" key={item.payment_intent_id}>
          <div><strong>{item.business_number}</strong>
            <p>{money(item.amount_minor)} · {item.kind==="REFUND"
              ?"Деньги возвращены банком":item.kind==="HANDOVER"
                ?"Отгружено со склада; подтвердите фактическую выдачу"
                :"Товар выдан, зачесть предоплату"}</p>
          </div>
          {item.kind==="HANDOVER"?
            <button type="button" disabled={busy||handoverProof.trim().length<8}
              onClick={()=>void confirmHandover(item)}>
              Подтвердить выдачу
            </button>:
            <button type="button" disabled={busy||!nonMarkedConfirmed}
              onClick={()=>void fiscalFollowup(item)}>
              {item.kind==="REFUND"?"Чек возврата прихода":"Чек полного расчёта"}
            </button>
          }
        </div>):<p>Нет ожидающих закрывающих чеков и возвратов.</p>}
        <h3>Контроль автоматической сверки чеков</h3>
        <p><strong>Проверка отчётов:</strong> {
          reportHealth?.pollingEnabled?"Включена (только запросы статуса)"
          :"Выключена"
        }. Отправка новых чеков автоматической проверкой не производится.</p>
        {reportHealth?<div className="first-day-summary">
          <p>Ручная сверка без UUID АТОЛ: <strong>{
            reportHealth.manualAttentionWithoutUuid
          }</strong></p>
          <p>{reportHealth.queue.map(q=>
            q.state+": "+q.count).join(" · ")||"В очереди нет задач"}</p>
          {reportHealth.queue.some(q=>q.state==="EXHAUSTED")?
            <p role="alert">Есть исчерпанные попытки сверки. Проверьте
              документы и договор с АТОЛ вручную, не создавайте повторный чек.</p>
            :null}
        </div>:null}
        <h3>Журнал фискализации</h3>
        <div className="data-table-wrap"><table className="data-table">
          <thead><tr><th>Документ</th><th>Состояние</th><th>ФН/ФД/ФП</th><th>Сверка</th></tr></thead>
          <tbody>{atolDocs.map(doc=><tr key={doc.id}>
            <td>{doc.id.slice(0,8)} · {
              doc.operation==="sell"?"Предоплата":
              doc.operation==="sell_full_payment"?"Зачёт аванса":
              doc.operation==="sell_refund"?"Возврат прихода":doc.operation
            }</td>
            <td>{doc.state}</td>
            <td>{doc.fn_number??"—"} / {doc.fiscal_document_number??"—"} /
              {doc.fiscal_document_attribute??"—"}</td>
            <td>
              {!doc.provider_uuid?<input value={fiscalUnknownUuid}
                onChange={e=>setFiscalUnknownUuid(e.target.value)}
                aria-label="UUID АТОЛ из кабинета" placeholder="UUID из кабинета АТОЛ"/>:null}
              <button type="button"
                disabled={busy||doc.state==="DONE"||
                  (!doc.provider_uuid&&!fiscalUnknownUuid.trim())}
                onClick={()=>void verifyFiscal(doc)}>Сверить в АТОЛ</button>
            </td>
          </tr>)}</tbody>
        </table></div>
        <p className="muted">Если автоопрос включён администратором,
          известные UUID сверяются в фоне. Отправление чека никогда не
          повторяется автоматически. UNKNOWN без UUID всегда требует
          сверки через кабинет АТОЛ.</p>
        <p className="muted">WAIT/UNKNOWN не являются чеком.
          Факт фискализации подтверждает только отчёт АТОЛ с ФН/ФД/ФП.
          Пилот поддерживает закрытие полной предоплаты и полный банковский
          возврат. Частичные возвраты, корректировки, маркируемые товары и
          реальная кассовая приёмка требуют отдельного этапа.</p>
      </section>:null}
      {provider==="CDEK"&&current?.state==="VERIFIED"?<section className="studio-section">
        <h2>Проверить расчёт доставки</h2>
        <div className="studio-form-grid">
          {[
            ["Код города назначения",toCity,setToCity],
            ["Вес, грамм",weight,setWeight],
            ["Длина, см",length,setLength],
            ["Ширина, см",width,setWidth],
            ["Высота, см",height,setHeight]
          ].map(([title,value,change],i)=><label key={i}>{title as string}
            <input type="number" min="1" step="1" value={value as string}
              onChange={e=>(change as (v:string)=>void)(e.target.value)}/>
          </label>)}
        </div>
        <button type="button" disabled={busy} onClick={()=>void quote()}>
          Получить тарифы СДЭК
        </button>
        {quotes.length>0?<div className="data-table-wrap">
          <table className="data-table"><thead><tr>
            <th>Тариф</th><th>Стоимость</th><th>Срок</th><th>Действует до</th>
          </tr></thead><tbody>
            {quotes.map(q=><tr key={q.quoteId}>
              <td>{q.tariffCode}</td><td>{money(q.amountMinor)}</td>
              <td>{q.periodMin??"?"}–{q.periodMax??"?"} дней</td>
              <td>{new Date(q.expiresAt).toLocaleString("ru-RU")}</td>
            </tr>)}
          </tbody></table>
        </div>:null}
        <p className="muted">Тариф рассчитан по API СДЭК. Цена не
          изменяет автоматически сумму уже оплаченного заказа. Стоимость
          перевозки оплачивается продавцом по его договору.</p>
        <h3>Оформить накладную для уже оплаченного заказа</h3>
        <p>Одна накладная на заказ. При неизвестном ответе СДЭК
          система блокирует повтор до ручной сверки.</p>
        <div className="studio-form-grid">
          <label>ID оплаченного заказа CoreBiz
            <input value={shipOrderId} onChange={e=>setShipOrderId(e.target.value)}
              placeholder="UUID из списка заказов"/>
          </label>
          <label>Имя получателя
            <input value={shipName} onChange={e=>setShipName(e.target.value)}/>
          </label>
          <label>Телефон
            <input value={shipPhone} onChange={e=>setShipPhone(e.target.value)}
              placeholder="+79991112233"/>
          </label>
        </div>
        <div className="first-day-steps">
          {quotes.map(q=><article className="first-day-step" key={q.quoteId}>
            <span>📦</span>
            <div><strong>Тариф №{q.tariffCode} · {money(q.amountMinor)}</strong>
              <p>Действует до {new Date(q.expiresAt).toLocaleString("ru-RU")}</p>
            </div>
            <button type="button" disabled={busy||!shipOrderId||!shipName||!shipPhone}
              onClick={()=>void book(q.quoteId)}>Создать накладную</button>
          </article>)}
        </div>
      </section>:null}
      <section className="studio-section">
        <h2>Существующие отправления СДЭК</h2>
        <p>Статус проверяется через GET СДЭК. Он не означает
          поступление оплаты или фактическое списание товара со склада.</p>
        <div className="data-table-wrap"><table className="data-table">
          <thead><tr><th>Заказ</th><th>Номер СДЭК</th><th>Состояние</th><th>Действие</th></tr></thead>
          <tbody>{shipments.map(sh=><tr key={sh.id}>
            <td>{sh.business_number}</td>
            <td>{sh.provider_number??"—"}</td>
            <td>{sh.state}{sh.last_error_code?" · сверка требуется":""}</td>
            <td>
              {!sh.provider_order_uuid?<input
                aria-label="UUID СДЭК для сверки" placeholder="UUID из кабинета СДЭК"
                value={unknownUuid} onChange={e=>setUnknownUuid(e.target.value)}
              />:null}
              <button type="button" disabled={busy||
                (!sh.provider_order_uuid&&!unknownUuid.trim())}
                onClick={()=>void verifyShipment(sh)}>Сверить</button>
            </td>
          </tr>)}</tbody>
        </table></div>
      </section>
    </section>
  </main>;
}
