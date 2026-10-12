"use client";
import {useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../../components/app-sidebar";
import {apiRequest} from "../../../../../lib/api";

type Site={id:string;name:string};
type Connection={
  configured:boolean;provider:string;state?:string;enabled?:boolean;
  fromPostcode?:string|null;verifiedAt?:string|null
};
type PostalShipment={
  id:string;sales_order_id:string;business_number:string;state:string;
  provider_order_id:string|null;barcode:string|null;
  amount_minor:string;last_error_code:string|null;created_at:string
};
type Quote={
  quoteId:string;amountMinor:string;vatMinor:string;fromPostcode:string;
  toPostcode:string;massGrams:number;periodMin:number|null;
  periodMax:number|null;expiresAt:string;disclaimer:string
};
const money=(minor:string)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB"
}).format(Number(minor)/100);

export default function RussianPostPage(){
  const [sites,setSites]=useState<Site[]>([]);
  const [siteId,setSiteId]=useState("");
  const [connection,setConnection]=useState<Connection|null>(null);
  const [accessToken,setAccessToken]=useState("");
  const [userKey,setUserKey]=useState("");
  const [fromPostcode,setFromPostcode]=useState("");
  const [toPostcode,setToPostcode]=useState("");
  const [mass,setMass]=useState("1000");
  const [quote,setQuote]=useState<Quote|null>(null);
  const [shipments,setShipments]=useState<PostalShipment[]>([]);
  const [orderId,setOrderId]=useState("");
  const [recipientName,setRecipientName]=useState("");
  const [recipientPhone,setRecipientPhone]=useState("");
  const [region,setRegion]=useState("");
  const [place,setPlace]=useState("");
  const [street,setStreet]=useState("");
  const [house,setHouse]=useState("");

  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);

  useEffect(()=>{
    void apiRequest<Site[]>("/sites").then(items=>{
      setSites(items);setSiteId(items[0]?.id??"");
    }).catch(e=>setError(e instanceof Error?e.message:"Список сайтов недоступен"));
  },[]);
  const load=useCallback(async()=>{
    if(!siteId)return;
    try{
      const result=await apiRequest<Connection>(
        "/provider-connectors/sites/"+siteId+"/russian-post");
      setConnection(result);
      setFromPostcode(result.fromPostcode??"");
      const records=await apiRequest<PostalShipment[]>(
        "/provider-connectors/sites/"+siteId+"/russian-post/shipments");
      setShipments(records);
    }catch(e){
      setError(e instanceof Error?e.message:"Не удалось получить настройки Почты");
    }
  },[siteId]);
  useEffect(()=>{void load();},[load]);
  async function save(){
    if(!siteId||busy)return;
    setBusy(true);setError("");setNotice("");setQuote(null);
    try{
      await apiRequest("/provider-connectors/sites/"+siteId+
        "/russian-post/configure",{
        method:"POST",body:JSON.stringify({
          accessToken,userAuthorizationKey:userKey,fromPostcode
        })
      });
      setAccessToken("");setUserKey("");
      setNotice("Ключи сохранены зашифрованными. Проверьте их тарифным запросом.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Сохранение недоступно");}
    finally{setBusy(false);}
  }
  async function verify(){
    if(!siteId||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/provider-connectors/sites/"+siteId+"/russian-post/verify",{
        method:"POST",body:JSON.stringify({toPostcode})
      });
      setNotice("Почта России подтвердила доступ к расчёту тарифов.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Ключ не подтверждён");}
    finally{setBusy(false);}
  }
  async function calculate(){
    if(!siteId||busy)return;
    setBusy(true);setError("");setNotice("");setQuote(null);
    try{
      const result=await apiRequest<Quote>(
        "/provider-connectors/sites/"+siteId+"/russian-post/quotes",{
          method:"POST",body:JSON.stringify({
            toPostcode,massGrams:Number(mass)
          })
        });
      setQuote(result);
    }catch(e){setError(e instanceof Error?e.message:"Расчёт недоступен");}
    finally{setBusy(false);}
  }

  async function book(){
    if(!quote||busy||!siteId)return;
    if(!window.confirm("Создать реальный заказ в системе Почты России? "+
      "Может возникнуть расход по договору. Проверьте адрес, "+
      "подтверждённую оплату и резерв товара."))return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await apiRequest<{state:string;note:string}>(
        "/provider-connectors/sites/"+siteId+"/russian-post/shipments",{
          method:"POST",body:JSON.stringify({
            orderId:orderId.trim(),quoteId:quote.quoteId,
            recipientName:recipientName.trim(),
            recipientPhone:recipientPhone.trim(),
            destination:{index:toPostcode,region,place,street,house}
          })
        });
      setNotice(result.note);setQuote(null);await load();
    }catch(e){
      setError(e instanceof Error?e.message:
        "Заказ не подтверждён. Перед повтором проверьте кабинет Почты.");
    }finally{setBusy(false);}
  }
  async function reconcileShipment(shipment:PostalShipment){
    if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const result=await apiRequest<{state:string;note:string;
        barcode:string|null}>(
        "/provider-connectors/sites/"+siteId+"/russian-post/shipments/"+
          shipment.id+"/reconcile",{method:"POST"});
      setNotice(result.note+(result.barcode?" · ШПИ "+result.barcode:""));
      await load();
    }catch(e){
      setError(e instanceof Error?e.message:"Сверка Почты России недоступна");
    }finally{setBusy(false);}
  }

  return <main className="app-shell">
    <AppSidebar active="settings"/>
    <section className="workspace workspace-wide studio-premium">
      <header className="studio-hero compact">
        <div><span className="studio-eyebrow">Интеграции продавца</span>
          <h1>Почта России · API «Отправка»</h1>
          <p>Договор и отдельные API-ключи вашего магазина. Реальная стоимость
            по тарифу Почты России без выдуманных расчётов.</p>
        </div>
        <a className="secondary-button" href="/app/settings/integrations">
          Все интеграции
        </a>
      </header>
      {error?<p className="inline-error" role="alert">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      <section className="studio-section">
        <label>Интернет-магазин
          <select value={siteId} onChange={e=>{
            setSiteId(e.target.value);setQuote(null);setConnection(null);
          }}>
            {sites.map(s=><option value={s.id} key={s.id}>{s.name}</option>)}
          </select>
        </label>
        <p><strong>Подключение:</strong> {connection?.state??"Не настроено"}</p>
        <p className="muted">Поддерживается рабочий API-договор «Отправка».
          Тестовая имитация почтового тарифа не используется.</p>
      </section>
      <section className="studio-section">
        <h2>Реквизиты продавца</h2>
        <div className="studio-form-grid">
          <label>Токен авторизации приложения
            <input type="password" value={accessToken}
              onChange={e=>setAccessToken(e.target.value)}
              autoComplete="new-password"/>
          </label>
          <label>Ключ авторизации пользователя (Base64 без префикса Basic)
            <input type="password" value={userKey}
              onChange={e=>setUserKey(e.target.value)}
              autoComplete="new-password"/>
          </label>
          <label>Индекс отправления (6 цифр)
            <input value={fromPostcode} inputMode="numeric" maxLength={6}
              onChange={e=>setFromPostcode(e.target.value)}/>
          </label>
        </div>
        <button type="button" onClick={()=>void save()}
          disabled={busy||!siteId||!accessToken||!userKey||
            !/^[0-9]{6}$/.test(fromPostcode)}>
          Сохранить защищённое подключение
        </button>
        <p className="muted">При смене ключей подтверждённый статус
          сбрасывается. Пароли не возвращаются в браузер.</p>
      </section>
      <section className="studio-section">
        <h2>Проверка и тариф</h2>
        <div className="studio-form-grid">
          <label>Индекс получателя
            <input value={toPostcode} maxLength={6} inputMode="numeric"
              onChange={e=>{setToPostcode(e.target.value);setQuote(null);}}/>
          </label>
          <label>Вес посылки, граммы
            <input value={mass} type="number" min={1} max={20000} step={1}
              onChange={e=>{setMass(e.target.value);setQuote(null);}}/>
          </label>
        </div>
        <div className="studio-hero-actions">
          <button type="button" className="secondary-button"
            onClick={()=>void verify()}
            disabled={busy||!connection?.configured||!siteId||
              !/^[0-9]{6}$/.test(toPostcode)}>
            Проверить доступ к API
          </button>
          <button type="button" onClick={()=>void calculate()}
            disabled={busy||connection?.state!=="VERIFIED"||!siteId||
              !/^[0-9]{6}$/.test(toPostcode)||
              !Number.isInteger(Number(mass))||
              Number(mass)<1||Number(mass)>20000}>
            Рассчитать стоимость
          </button>
        </div>
        {quote?<div className="first-day-summary">
          <h3>Тариф POSTAL_PARCEL · обычная посылка</h3>
          <p><strong>{money(quote.amountMinor)}</strong>
            {" · НДС "+money(quote.vatMinor)}</p>
          <p>Индексы: {quote.fromPostcode} → {quote.toPostcode},
            вес {quote.massGrams} г</p>
          <p>Срок: {quote.periodMin??"?"}–{quote.periodMax??"?"} дней.
            Предложение действует до {new Date(quote.expiresAt).toLocaleString("ru-RU")}.</p>
          <p className="muted">{quote.disclaimer}</p>
        </div>:null}
      </section>
      <section className="studio-section">
        <h2>Оформление заказа в Почте России</h2>
        <p className="muted">Используйте только оплаченный заказ с подтверждённым
          чеком, резервом и способом «Курьер продавца». Стоимость Почты
          оплачивается по договору продавца, а не списывается с покупателя.
          Город, улица и дом должны совпадать с адресом покупки.</p>
        <div className="studio-form-grid">
          <label>ID заказа CoreBiz
            <input value={orderId} onChange={e=>setOrderId(e.target.value)}
              placeholder="UUID заказа"/>
          </label>
          <label>ФИО получателя
            <input value={recipientName}
              onChange={e=>setRecipientName(e.target.value)}/>
          </label>
          <label>Телефон получателя
            <input value={recipientPhone} onChange={e=>setRecipientPhone(e.target.value)}
              placeholder="+79990000000"/>
          </label>
          <label>Регион
            <input value={region} onChange={e=>setRegion(e.target.value)}/>
          </label>
          <label>Населённый пункт
            <input value={place} onChange={e=>setPlace(e.target.value)}/>
          </label>
          <label>Улица
            <input value={street} onChange={e=>setStreet(e.target.value)}/>
          </label>
          <label>Дом
            <input value={house} onChange={e=>setHouse(e.target.value)}/>
          </label>
        </div>
        <button type="button" onClick={()=>void book()}
          disabled={busy||!siteId||!quote||!orderId||!recipientName||
            !recipientPhone||!region||!place||!street||!house||
            new Date(quote.expiresAt).getTime()<=Date.now()}>
          Создать заказ в «Отправка»
        </button>
        <p className="muted">После создания получите ID внутреннего заказа.
          ШПИ и почтовый ярлык появятся только после отдельного
          оформления партии в личном кабинете перевозчика.</p>
      </section>
      <section className="studio-section">
        <h2>Почтовые заявки · сверка</h2>
        {shipments.length===0?<p className="muted">Отправлений пока нет.</p>:null}
        {shipments.map(item=><div key={item.id} className="first-day-summary">
          <p><strong>{item.business_number}</strong> · {item.state}</p>
          <p>ID Почты: {item.provider_order_id??"ещё не подтверждён"}
            {item.barcode?" · ШПИ "+item.barcode:""}</p>
          <p className="muted">Тариф: {money(item.amount_minor)} ·
            {item.last_error_code??"нет ошибок"}</p>
          <button type="button" className="secondary-button"
            onClick={()=>void reconcileShipment(item)} disabled={busy}>
            Сверить с Почтой России (без создания повторного заказа)
          </button>
        </div>)}
      </section>
      <section className="studio-section">
        <h2>Следующий этап</h2>
        <p>Формирование партий, печать ярлыков, подтверждённое
          отслеживание движения посылки, отмена и возврат.
          Созданный заказ в «Новых» ещё не означает сдачу перевозчику.</p>
      </section>
    </section>
  </main>;
}
