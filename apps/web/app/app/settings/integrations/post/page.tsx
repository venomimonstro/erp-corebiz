"use client";
import {useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../../components/app-sidebar";
import {apiRequest} from "../../../../../lib/api";

type Site={id:string;name:string};
type Connection={
  configured:boolean;provider:string;state?:string;enabled?:boolean;
  fromPostcode?:string|null;verifiedAt?:string|null
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
        <h2>Пока недоступно</h2>
        <p>Создание и отмена почтовых отправлений, присвоение ШПИ,
          формирование партии, печать ярлыка, отслеживание и возвраты.
          Эти операции будут доступны только после отдельной интеграции,
          проверенной на реальном договоре и тестовых заказах.</p>
      </section>
    </section>
  </main>;
}
