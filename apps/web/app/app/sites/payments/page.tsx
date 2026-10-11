"use client";
import {useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";

type Site={id:string;name:string;public_slug:string};
type Merchant={configured:boolean;shop_id?:string;enabled?:boolean;
  fiscal_enabled?:boolean;vat_code?:number;tax_system_code?:number|null};
type Method={id:string;code:string;title:string;mode:string;fee_minor:string;
  description:string|null};
type DeliveryResponse={methods:Method[];currency:string};

export default function StorePaymentsPage(){
  const [sites,setSites]=useState<Site[]>([]);
  const [siteId,setSiteId]=useState("");
  const [config,setConfig]=useState<Merchant|null>(null);
  const [methods,setMethods]=useState<Method[]>([]);
  const [shopId,setShopId]=useState("");
  const [secret,setSecret]=useState("");
  const [vatCode,setVatCode]=useState(1);
  const [taxCode,setTaxCode]=useState("0");
  const [fiscalEnabled,setFiscalEnabled]=useState(false);
  const [enabled,setEnabled]=useState(false);
  const [deliveryCode,setDeliveryCode]=useState("PICKUP");
  const [deliveryTitle,setDeliveryTitle]=useState("Самовывоз");
  const [deliveryMode,setDeliveryMode]=useState<"PICKUP"|"LOCAL_COURIER">("PICKUP");
  const [fee,setFee]=useState("0");
  const [message,setMessage]=useState("");
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{
    void apiRequest<Site[]>("/sites").then(rows=>{
      setSites(rows);if(rows[0])setSiteId(rows[0].id);
    }).catch(cause=>setError(String(cause)));
  },[]);
  const selected=sites.find(s=>s.id===siteId);
  const load=useCallback(async()=>{
    if(!siteId||!selected)return;
    try{
      const [merchant,delivery]=await Promise.all([
        apiRequest<Merchant>("/payments/stores/"+siteId+"/merchant"),
        apiRequest<DeliveryResponse>(
          "/payments/storefront/"+encodeURIComponent(selected.public_slug)+"/delivery")
      ]);
      setConfig(merchant);
      setMethods(delivery.methods);
      setShopId(merchant.shop_id??"");
      setVatCode(merchant.vat_code??1);
      setTaxCode(String(merchant.tax_system_code??0));
      setFiscalEnabled(merchant.fiscal_enabled??false);
      setEnabled(merchant.enabled??false);
      setError("");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Настройки недоступны");
    }
  },[siteId,selected?.public_slug]);
  useEffect(()=>{void load();},[load]);
  async function saveMerchant(){
    setBusy(true);setError("");setMessage("");
    try{
      await apiRequest("/payments/stores/"+siteId+"/merchant",{
        method:"POST",
        body:JSON.stringify({
          shopId, ...(secret?{secret}:{}),
          vatCode,taxSystemCode:Number(taxCode)||null,
          enabled,fiscalEnabled
        })
      });
      setSecret("");
      setMessage("Реквизиты сохранены. Ключ защищён и не отображается в интерфейсе.");
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Ошибка сохранения");}
    finally{setBusy(false);}
  }
  async function saveDelivery(){
    setBusy(true);setMessage("");setError("");
    try{
      await apiRequest("/payments/stores/"+siteId+"/delivery",{
        method:"POST",
        body:JSON.stringify({
          code:deliveryCode.trim().toUpperCase(),title:deliveryTitle.trim(),
          mode:deliveryMode,feeMinor:deliveryMode==="PICKUP"?"0":String(Math.round(Number(fee)*100)),
          active:true
        })
      });
      setMessage("Способ получения сохранён.");
      await load();
    }catch(cause){setError(cause instanceof Error?cause.message:"Ошибка доставки");}
    finally{setBusy(false);}
  }
  return (
    <main className="app-shell">
      <AppSidebar active="sites"/>
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero compact">
          <div>
            <span className="studio-eyebrow">Магазин · коммерческий запуск</span>
            <h1>Приём оплаты и доставка</h1>
            <p>Каждый магазин принимает средства на свой счёт YooKassa.
              CoreBiz не получает данные банковских карт покупателей.
              Подключение фискализации требует договора с онлайн-кассой.</p>
          </div>
        </header>
        {error?<p className="inline-error" role="alert">{error}</p>:null}
        {message?<p role="status">{message}</p>:null}
        <section className="studio-section">
          <h2>Магазин</h2>
          <label>Выберите сайт
            <select value={siteId} onChange={e=>setSiteId(e.target.value)}>
              {sites.map(site=><option value={site.id} key={site.id}>{site.name}</option>)}
            </select>
          </label>
        </section>
        <section className="studio-section">
          <h2>Эквайринг YooKassa</h2>
          <p>Реквизиты берутся из кабинета продавца. Секретный ключ
            хранится зашифрованным. При повторном сохранении оставьте поле ключа пустым.</p>
          <div className="studio-form-grid">
            <label>ID магазина
              <input value={shopId} onChange={e=>setShopId(e.target.value)}
                placeholder="123456"/>
            </label>
            <label>Секретный API-ключ
              <input type="password" autoComplete="new-password" value={secret}
                onChange={e=>setSecret(e.target.value)} placeholder={
                  config?.configured?"Оставить без изменений":"Укажите секретный ключ"}/>
            </label>
            <label>НДС в чеке
              <select value={vatCode} onChange={e=>setVatCode(Number(e.target.value))}>
                <option value={1}>Без НДС</option>
                <option value={2}>НДС 0%</option>
                <option value={3}>НДС 10%</option>
                <option value={7}>НДС 5%</option>
                <option value={8}>НДС 7%</option>
                <option value={11}>НДС 22% (2026)</option>
                <option value={12}>НДС 22/122 (2026)</option>
              </select>
            </label>
            <label>Система налогообложения (для ККТ)
              <select value={taxCode} onChange={e=>setTaxCode(e.target.value)}>
                <option value="0">Не передавать</option>
                <option value="1">ОСНО</option>
                <option value="2">УСН (доходы)</option>
                <option value="3">УСН (доходы − расходы)</option>
                <option value="5">ЕСХН</option>
                <option value="6">ПСН</option>
              </select>
            </label>
          </div>
          <label><input type="checkbox" checked={fiscalEnabled}
            onChange={e=>setFiscalEnabled(e.target.checked)}/>
            Подтверждаю: подключена онлайн-касса и передача чеков в YooKassa</label>
          <label><input type="checkbox" checked={enabled}
            onChange={e=>setEnabled(e.target.checked)}/>
            Разрешить онлайн-оплату покупателям</label>
          <p>Проведение денег и создание чека — разные операции.
            До подтверждения провайдером платёж остаётся ожидающим.
            При ошибке регистрации чека требуется ручная обработка.</p>
          <button type="button" disabled={busy||!siteId||!shopId||
            (enabled&&!fiscalEnabled)} onClick={()=>void saveMerchant()}>
            Сохранить подключение
          </button>
        </section>
        <section className="studio-section">
          <h2>Получение товара</h2>
          <p>Сейчас поддерживаются самовывоз и курьер магазина с фиксированной
            стоимостью. Внешний перевозчик и выдача трек-номера требуют отдельного подключения.</p>
          <div className="studio-form-grid">
            <label>Код
              <input value={deliveryCode} onChange={e=>setDeliveryCode(e.target.value)}/>
            </label>
            <label>Название
              <input value={deliveryTitle} onChange={e=>setDeliveryTitle(e.target.value)}/>
            </label>
            <label>Тип
              <select value={deliveryMode} onChange={e=>{
                setDeliveryMode(e.target.value as "PICKUP"|"LOCAL_COURIER");
                if(e.target.value==="PICKUP")setFee("0");
              }}>
                <option value="PICKUP">Самовывоз</option>
                <option value="LOCAL_COURIER">Курьер магазина</option>
              </select>
            </label>
            {deliveryMode==="LOCAL_COURIER"?<label>Стоимость, ₽
              <input type="number" min={0} step="0.01" value={fee}
                onChange={e=>setFee(e.target.value)}/>
            </label>:null}
          </div>
          <button type="button" disabled={busy||!siteId} onClick={()=>void saveDelivery()}>
            Сохранить способ доставки
          </button>
          <h3>Доступные способы</h3>
          {methods.length?methods.map(item=><p key={item.id}>
            <strong>{item.title}</strong> · {item.mode==="PICKUP"?"Самовывоз":"Курьер"}
            · {(Number(item.fee_minor)/100).toLocaleString("ru-RU")} ₽
          </p>):<p>Добавьте хотя бы один способ получения до запуска оплаты.</p>}
        </section>
      </section>
    </main>
  );
}
