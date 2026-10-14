"use client";

import {type FormEvent,useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";

type Site={id:string;name:string;code:string;public_slug:string;status:string};
type SiteCheck={code:string;title:string;done:boolean;action:string};
type SiteReadiness={
  siteId:string;publicUrl:string;primaryDomain:string|null;
  canTestOrders:boolean;canLaunchWithOnlinePayments:boolean;
  checks:SiteCheck[];externalBlockers:string[]
};
type Commerce={
  pendingFulfillment:number;paymentReview:number;openSupplierOrders:number;
  replenishment:Array<{skuId:string;sku:string;urgency:string}>
};
type ReleaseCheck={code:string;title:string;detail:string;href:string;
  ok:boolean;blocking:boolean};
type Release={
  ready:boolean;stage:string;blockers:ReleaseCheck[];warnings:ReleaseCheck[]
};

const jump:Record<string,string>={
  STORE_ENABLED:"/app/sites",
  HOME_PUBLISHED:"/app/sites",
  CATALOG_PUBLISHED:"/app/sites",
  PRICED_PRODUCTS:"/app/catalog/products",
  AVAILABLE_STOCK:"/app/inventory/stock",
  CUSTOM_DOMAIN:"/app/sites",
  ACQUIRING_CONFIGURED:"/app/sites/payments",
  FISCAL_CONFIGURED:"/app/sites/payments",
  DELIVERY_CONFIGURED:"/app/sites/payments"
};
const phases=[
  {name:"Компания и тариф",detail:"Выберите нишу интернет-магазина, добавьте реквизиты и участников",href:"/app/start"},
  {name:"Каталог и цены",detail:"Заведите товары, варианты, SKU, изображения и себестоимость",href:"/app/catalog/products"},
  {name:"Склад и доступность",detail:"Создайте склад, примите товары, проверьте резерв и страховой запас",href:"/app/inventory/stock"},
  {name:"CMS и витрина",detail:"Создайте магазин, оформите страницы и опубликуйте товарный каталог",href:"/app/sites"},
  {name:"Оплата и получение",detail:"Настройте способы доставки и реального продавца, проверьте ККТ",href:"/app/sites/payments"},
  {name:"Заказы и отгрузка",detail:"Проверьте резерв, поступление денег, исполнение заказа и возвраты",href:"/app/sales/orders"},
  {name:"Контроль бизнеса",detail:"Закупки, остатки, задолженность, маржа, сбои интеграций",href:"/app/commerce"}
];

export default function OnlineStoreLaunchPage(){
  const [sites,setSites]=useState<Site[]>([]);
  const [siteId,setSiteId]=useState("");
  const [readiness,setReadiness]=useState<SiteReadiness|null>(null);
  const [commerce,setCommerce]=useState<Commerce|null>(null);
  const [release,setRelease]=useState<Release|null>(null);
  const [loading,setLoading]=useState(true);
  const [checking,setChecking]=useState(false);
  const [creating,setCreating]=useState(false);
  const [showCreate,setShowCreate]=useState(false);
  const [shopName,setShopName]=useState("");
  const [shopSlug,setShopSlug]=useState("");
  const [error,setError]=useState("");
  const [operationalWarning,setOperationalWarning]=useState("");
  const [releaseWarning,setReleaseWarning]=useState("");
  const [notice,setNotice]=useState("");

  const reload=useCallback(async()=>{
    setLoading(true);setError("");setNotice("");
    const [s,c,r]=await Promise.allSettled([
      apiRequest<Site[]>("/sites"),
      apiRequest<Commerce>("/dashboard/commerce"),
      apiRequest<Release>("/go-live/readiness")
    ]);
    if(s.status==="fulfilled"){
      setSites(s.value);
      setSiteId(current=>s.value.some(x=>x.id===current)?current:s.value[0]?.id??"");
    }else{
      setSites([]);setSiteId("");setReadiness(null);
      setError("Не получилось загрузить сайты. Проверка коммерческого запуска недоступна.");
    }
    if(c.status==="fulfilled"){
      setCommerce(c.value);setOperationalWarning("");
    }else{
      setCommerce(null);
      setOperationalWarning("Операционная сводка недоступна. Статусы заказов неизвестны.");
    }
    if(r.status==="fulfilled"){
      setRelease(r.value);setReleaseWarning("");
    }else{
      setRelease(null);
      setReleaseWarning("Проверка запуска компании недоступна. Это не разрешение принимать платежи.");
    }
    setLoading(false);
  },[]);
  useEffect(()=>{void reload();},[reload]);

  useEffect(()=>{
    let active=true;
    setReadiness(null);
    if(!siteId){setChecking(false);return;}
    setChecking(true);
    void apiRequest<SiteReadiness>(
      "/storefront/site/"+encodeURIComponent(siteId)+"/readiness"
    ).then(result=>{if(active)setReadiness(result);})
      .catch(()=>{if(active)setError(
        "Не удалось проверить сайт. Старые результаты не используются."
      );})
      .finally(()=>{if(active)setChecking(false);});
    return()=>{active=false;};
  },[siteId]);

  async function createShop(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(creating)return;
    const name=shopName.trim(),slug=shopSlug.trim().toLowerCase();
    if(name.length<2||name.length>160||
      (slug!==""&&!/^[a-z0-9][a-z0-9-]{2,80}$/.test(slug))){
      setError("Название: 2–160 символов. Адрес — от 3 символов латиницей, цифрами и дефисами.");
      return;
    }
    setCreating(true);setError("");setNotice("");
    try{
      // The server creates the CMS page, product block and storefront_config
      // in ONE transaction. Do not duplicate SKU, inventory or OMS tables.
      const shop=await apiRequest<{id:string;pageId:string;publicSlug:string}>(
        "/sites",{
          method:"POST",
          body:JSON.stringify({name,template:"STORE",...(slug?{publicSlug:slug}:{})})
        }
      );
      await apiRequest<SiteReadiness>(
        "/storefront/site/"+encodeURIComponent(shop.id)+"/readiness"
      );
      setShowCreate(false);setShopName("");setShopSlug("");
      setNotice("Магазин создан как черновик. Добавьте товары, остатки и настройте оплату. "
        +"Публичные продажи ещё не подтверждены.");
      setSiteId(shop.id);
      const latest=await apiRequest<Site[]>("/sites");
      setSites(latest);
    }catch(cause){
      // A timeout can mean the site was created. Keep the form instead of
      // submitting automatically again and risking a second store.
      setError((cause instanceof Error?cause.message:"Ошибка создания магазина")+
        ". Проверьте список сайтов перед повторным созданием.");
      try{
        const current=await apiRequest<Site[]>("/sites");
        setSites(current);
      }catch{/* original failure remains visible */}
    }finally{setCreating(false);}
  }

  const site=sites.find(x=>x.id===siteId);
  const missing=readiness?.checks.filter(x=>!x.done)??[];
  // Fail closed: neither CMS configuration nor a test-order milestone is a
  // provider-confirmed payment, fiscal or legal launch approval.
  const verifiedForSale=Boolean(readiness?.canLaunchWithOnlinePayments &&
    release?.ready && !checking && !loading);

  return <main className="app-shell">
    <AppSidebar active="commerce-decisions"/>
    <section className="workspace workspace-wide commerce-launch">
      <header className="workspace-header">
        <div>
          <p className="muted">CoreBiz · Интернет-магазин</p>
          <h1>Запуск моего магазина</h1>
          <p className="workspace-summary">
            Один каталог, единые остатки и заказы. CMS создаёт сайт поверх ERP,
            а не отдельную базу товаров.
          </p>
        </div>
        <button type="button" onClick={()=>void reload()} disabled={loading||creating}>
          {loading?"Проверяем…":"Обновить всё"}
        </button>
      </header>

      {error?<p role="alert" className="inline-error">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      {operationalWarning?<p role="status" className="muted">{operationalWarning}</p>:null}
      {releaseWarning?<p role="status" className="muted">{releaseWarning}</p>:null}

      <section className="section-block commerce-launch-top">
        <div>
          <h2>Мой сайт на встроенной CMS</h2>
          <p>Главная, товарные блоки, SEO и страницы редактируются в CoreBiz.
            Публичная корзина отправляет заказ в общий контур продаж.</p>
        </div>
        <div className="commerce-launch-site-picker">
          <label htmlFor="commerce-site">Магазин или сайт</label>
          <select id="commerce-site" value={siteId}
            onChange={e=>setSiteId(e.target.value)}>
            <option value="">Выберите сайт</option>
            {sites.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <button type="button" onClick={()=>setShowCreate(v=>!v)}
            disabled={creating}>+ Создать интернет-магазин</button>
        </div>
        {showCreate?<form className="commerce-launch-create" onSubmit={e=>void createShop(e)}>
          <label>Название магазина
            <input required minLength={2} maxLength={160} value={shopName}
              onChange={e=>setShopName(e.target.value)}
              placeholder="Мой магазин электроники"/>
          </label>
          <label>Публичный адрес (необязательно)
            <input value={shopSlug} onChange={e=>setShopSlug(e.target.value)}
              placeholder="my-electronics-shop" pattern="[a-z0-9][a-z0-9-]{2,80}"/>
          </label>
          <p>Если адрес не указан, сервер создаст уникальный автоматически.
            Сайт будет черновиком до публикации страницы.</p>
          <div className="commerce-launch-links">
            <button type="submit" disabled={creating||shopName.trim().length<2}>
              {creating?"Создаём…":"Создать сайт и каталог"}
            </button>
            <button type="button" className="secondary-button"
              disabled={creating} onClick={()=>setShowCreate(false)}>Отмена</button>
          </div>
        </form>:null}
        {site?<div className="commerce-launch-links">
          <a className="secondary-button" href="/app/sites">Редактор CMS →</a>
          <a className="secondary-button" target="_blank" rel="noopener noreferrer"
            href={"/s/"+encodeURIComponent(site.public_slug)}>Предпросмотр сайта ↗</a>
          <a className="secondary-button" href="/app/sites/payments">Оплата и доставка →</a>
        </div>:null}
      </section>

      <section className="section-block">
        <div className="commerce-launch-section-head">
          <h2>Что нужно настроить владельцу</h2>
          <span>{phases.length} этапов</span>
        </div>
        <div className="commerce-launch-steps">
          {phases.map((x,i)=><a href={x.href} key={x.name}>
            <span className="commerce-launch-stepnum">{i+1}</span>
            <span><strong>{x.name}</strong><small>{x.detail}</small></span>
            <span aria-hidden="true">→</span>
          </a>)}
        </div>
      </section>

      <section className="section-block">
        <div className="commerce-launch-section-head">
          <h2>Проверка выбранной витрины</h2>
          <span>{readiness?
            readiness.checks.filter(x=>x.done).length+" из "+readiness.checks.length:
            "Нет подтверждённых данных"}</span>
        </div>
        {checking?<p role="status">Получаем состояние CMS, SKU и склада…</p>:null}
        {!site?<p>Создайте магазин или выберите существующий сайт.</p>:null}
        {site&&!readiness&&!checking?<p>Сервер пока не подтвердил готовность.
          Повторите проверку перед заказами.</p>:null}
        {readiness?<div className="commerce-launch-checks">
          {readiness.checks.map(check=><a key={check.code}
            href={jump[check.code]??"/app/sites"}
            className={check.done?"complete":"incomplete"}>
            <span aria-hidden="true">{check.done?"✓":"○"}</span>
            <span><strong>{check.title}</strong>
              <small>{check.done?"Проверка конфигурации пройдена":check.action}</small></span>
            <span aria-hidden="true">→</span>
          </a>)}
        </div>:null}
        {readiness?<p>
          {missing.length===0?"Настройка CMS выполнена. ":
            "Осталось настроить: "+missing.length+". "}
          {readiness.canTestOrders?
            "Можно переходить к контролируемому тестированию заказов; платежи проверяются отдельно.":
            "Для тестовых заказов нужны опубликованная витрина, товары, остатки и способ получения."}
        </p>:null}
      </section>

      <section className="section-block">
        <h2>Реальные продажи и безопасность</h2>
        <p className="commerce-launch-verdict" role="status">
          {verifiedForSale?"Серверные проверки разрешают коммерческий запуск.":
            "Коммерческий запуск с оплатой НЕ подтверждён."}
        </p>
        {readiness?.externalBlockers.length?<ul>
          {readiness.externalBlockers.map(x=><li key={x}>{x}</li>)}
        </ul>:null}
        {release?.blockers.length?<div className="commerce-launch-links">
          {release.blockers.slice(0,6).map(x=><a key={x.code}
            className="secondary-button" href={x.href}>{x.title} →</a>)}
        </div>:null}
        <div className="commerce-launch-links">
          <a href="/app/settings/go-live" className="secondary-button">Проверка GO/NO-GO →</a>
          <a href="/app/sales/orders" className="secondary-button">Заказы и отгрузки →</a>
        </div>
      </section>
      {commerce?<section className="section-block">
        <h2>После запуска: ежедневный контроль</h2>
        <div className="commerce-launch-kpis">
          <a href="/app/sales/orders"><strong>{commerce.pendingFulfillment}</strong>
            <small>Заказы на исполнение</small></a>
          <a href="/app/sales/orders"><strong>{commerce.paymentReview}</strong>
            <small>Оплаты на проверку</small></a>
          <a href="/app/purchases"><strong>{commerce.openSupplierOrders}</strong>
            <small>Открытые закупки</small></a>
          <a href="/app/commerce"><strong>{commerce.replenishment.length}</strong>
            <small>Позиции в выборке риска нехватки</small></a>
        </div>
      </section>:null}
    </section>
  </main>;
}
