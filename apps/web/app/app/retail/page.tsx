"use client";
import {useCallback,useEffect,useMemo,useState} from "react";
import {AppSidebar} from "../../../components/app-sidebar";
import {apiRequest} from "../../../lib/api";
type Location={
  id:string;code:string;name:string;address:string|null;
  pickup_enabled:boolean;warehouse_id:string;warehouse_name:string;
  open_shift_id:string|null;
  available_milli:string;physical_milli:string;reserved_milli:string;
};
type Stock={
  sku_id:string;sku_code:string;product_name:string;
  physical_milli:string;reserved_milli:string;available_milli:string;
  sellable_milli:string;
};
type Order={
  id:string;channel:string;created_at:string;order_id:string;
  business_number:string;order_status:string;fulfillment_status:string;
  payment_status:string;total_minor:string;customer_name:string|null;
};
type Customer={id:string;displayName:string;phone:string|null};
const rub=(minor:string)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB",maximumFractionDigits:0
}).format(Number(minor)/100);
const pcs=(milli:string)=>new Intl.NumberFormat("ru-RU",{
  maximumFractionDigits:3
}).format(Number(milli)/1000);
function token(){return typeof crypto!=="undefined"&&crypto.randomUUID?
  crypto.randomUUID():String(Date.now())+"-"+Math.random().toString(36).slice(2);}

export default function RetailPage(){
  const [locations,setLocations]=useState<Location[]>([]);
  const [locationId,setLocationId]=useState("");
  const [stock,setStock]=useState<Stock[]>([]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [customers,setCustomers]=useState<Customer[]>([]);
  const [search,setSearch]=useState("");
  const [createForm,setCreateForm]=useState(false);
  const [name,setName]=useState("");
  const [code,setCode]=useState("");
  const [address,setAddress]=useState("");
  const [pickup,setPickup]=useState(true);
  const [selectedSku,setSelectedSku]=useState("");
  const [quantity,setQuantity]=useState("1");
  const [customerId,setCustomerId]=useState("");
  const [mode,setMode]=useState<"COUNTER"|"CLICK_COLLECT">("COUNTER");
  const [key,setKey]=useState(()=>token());
  const [busy,setBusy]=useState(false);
  const [shiftCash,setShiftCash]=useState("0");
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [loading,setLoading]=useState(true);

  const refresh=useCallback(async()=>{
    try{
      const rows=await apiRequest<Location[]>("/retail/locations");
      setLocations(rows);
      setLocationId(prev=>rows.some(r=>r.id===prev)?prev:(rows[0]?.id??""));
      setError("");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось получить торговые точки");}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void refresh();},[refresh]);
  useEffect(()=>{void apiRequest<Customer[]>("/crm/customers")
    .then(setCustomers).catch(()=>setCustomers([]));},[]);
  const loadLocation=useCallback(async()=>{
    if(!locationId){setStock([]);setOrders([]);return;}
    try{
      const [items,sales]=await Promise.all([
        apiRequest<Stock[]>("/retail/locations/"+locationId+"/stock?q="+encodeURIComponent(search)),
        apiRequest<Order[]>("/retail/locations/"+locationId+"/orders")
      ]);
      setStock(items);setOrders(sales);setError("");
    }catch(e){setError(e instanceof Error?e.message:"Остатки или заказы недоступны");}
  },[locationId,search]);
  useEffect(()=>{void loadLocation();},[loadLocation]);
  const current=locations.find(l=>l.id===locationId);
  const available=useMemo(()=>stock.filter(x=>Number(x.sellable_milli)>0),[stock]);

  async function changeShift(action:"open"|"close"){
    if(!locationId)return;
    const cash=Number(shiftCash.replace(",","."));
    if(!Number.isFinite(cash)||cash<0||Math.round(cash*100)>1_000_000_000_000){
      setError("Укажите неотрицательную сумму наличных");return;
    }
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/retail/locations/"+locationId+"/shift/"+action,{
        method:"POST",
        body:JSON.stringify(action==="open"
          ?{openingCashMinor:String(Math.round(cash*100))}
          :{closingCashMinor:String(Math.round(cash*100))})
      });
      setShiftCash("0");
      setNotice(action==="open"?"Смена открыта. Это не фискальная регистрация.":
        "Смена закрыта. Сверьте суммы с кассой и платежами.");
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось изменить смену");}
    finally{setBusy(false);}
  }

  async function addLocation(){
    setBusy(true);setError("");setNotice("");
    try{
      await apiRequest("/retail/locations",{method:"POST",body:JSON.stringify({
        name,code,address,pickupEnabled:pickup
      })});
      setNotice("Точка открыта, филиал и отдельный склад созданы.");
      setName("");setCode("");setAddress("");setCreateForm(false);
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось создать точку");}
    finally{setBusy(false);}
  }
  async function reserve(){
    const amount=Number(quantity.replace(",","."));
    if(!selectedSku||!Number.isFinite(amount)||amount<=0||amount>100000){
      setError("Выберите товар и положительное количество");return;
    }
    setBusy(true);setError("");setNotice("");
    try{
      const result=await apiRequest<{
        orderId:string;orderNumber:string;notice:string;
      }>("/retail/orders/reserve",{
        method:"POST",body:JSON.stringify({
          locationId,partyId:customerId||undefined,channel:mode,
          idempotencyKey:key,
          lines:[{skuId:selectedSku,quantityMilli:String(Math.round(amount*1000))}]
        })
      });
      setNotice(result.orderNumber+" · "+result.notice);
      setSelectedSku("");setQuantity("1");setKey(token());
      await loadLocation();
      await refresh();
    }catch(e){
      setError(e instanceof Error?e.message:"Резерв не подтверждён. Повторите с тем же ключом.");
    }finally{setBusy(false);}
  }

  return <main className="app-shell">
    <AppSidebar active="retail"/>
    <section className="workspace workspace-wide studio-premium">
      <header className="studio-hero compact">
        <div>
          <span className="studio-eyebrow">Розница · офлайн + интернет-магазин</span>
          <h1>Сеть торговых точек</h1>
          <p>Один каталог и CRM, отдельные остатки каждой точки.
            Онлайн-заказ можно зарезервировать на выбранном складе,
            а сотрудник увидит его в общем списке заказов.</p>
        </div>
        <div className="studio-hero-actions">
          <a className="secondary-button" href="/app/sites">Интернет-магазин</a>
          <button type="button" onClick={()=>setCreateForm(v=>!v)}>+ Торговая точка</button>
        </div>
      </header>
      {error?<p className="inline-error" role="alert">{error}</p>:null}
      {notice?<p role="status">{notice}</p>:null}
      {createForm?<section className="studio-section">
        <h2>Открыть торговую точку</h2>
        <div className="studio-form-grid">
          <label>Название
            <input value={name} onChange={e=>setName(e.target.value)}
              placeholder="Электроника · ТЦ Север" minLength={2}/>
          </label>
          <label>Код
            <input value={code} onChange={e=>setCode(e.target.value.toUpperCase())}
              placeholder="MSK-SEVER" maxLength={34}/>
          </label>
          <label className="studio-form-wide">Адрес
            <input value={address} onChange={e=>setAddress(e.target.value)}
              placeholder="Москва, адрес точки"/>
          </label>
        </div>
        <label><input type="checkbox" checked={pickup}
          onChange={e=>setPickup(e.target.checked)}/>
          Разрешить самовывоз из этой точки</label>
        <p>Создадутся филиал и отдельный склад. Деньги, продажи и остатки
          будут учитываться в единой компании CoreBiz.</p>
        <button type="button" disabled={busy||name.trim().length<2||code.trim().length<2}
          onClick={()=>void addLocation()}>Создать точку</button>
      </section>:null}
      <section className="studio-section">
        <h2>Магазины сети</h2>
        {loading?<p>Загружаем торговые точки…</p>:null}
        <div className="first-day-choices">
          {locations.map(loc=><button type="button"
            className={loc.id===locationId?"first-day-choice selected":"first-day-choice"}
            aria-pressed={loc.id===locationId} key={loc.id}
            onClick={()=>{setLocationId(loc.id);setSelectedSku("");}}>
            <strong>{loc.name} · {loc.code}</strong>
            <small>{loc.address??"Адрес не указан"} · на складе {pcs(loc.available_milli)}
              {loc.pickup_enabled?" · Самовывоз включён":""}</small>
          </button>)}
        </div>
        {!loading&&!locations.length?<p>Добавьте первую торговую точку.
          Для неё автоматически создастся собственный склад.</p>:null}
      </section>
      {current?<section className="studio-section">
        <div className="studio-section-head">
          <div><span>{current.code}</span><h2>Остатки в {current.name}</h2>
            <p>Фактический остаток и резерв не смешиваются с другими магазинами.</p>
          </div>
          <a href="/app/inventory/stock" className="secondary-button">
            Приёмка и перемещение
          </a>
        </div>
        <label>Найти товар или артикул
          <input value={search} onChange={e=>setSearch(e.target.value)}
            placeholder="Ноутбук, iPhone, артикул" />
        </label>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Товар</th><th>Артикул</th><th>Факт</th><th>Резерв</th><th>К продаже</th></tr></thead>
            <tbody>{stock.map(x=><tr key={x.sku_id}>
              <td>{x.product_name}</td><td>{x.sku_code}</td>
              <td>{pcs(x.physical_milli)}</td><td>{pcs(x.reserved_milli)}</td>
              <td>{pcs(x.sellable_milli)}</td>
            </tr>)}</tbody>
          </table>
        </div>
        {!stock.length?<p>На этом складе пока нет товаров.
          Переместите их из центрального склада или проведите приход.</p>:null}
      </section>:null}
      {current?<section className="studio-section">
        <div className="studio-section-head">
          <div><h2>Кассовая смена</h2>
            <p>{current.open_shift_id?"Смена открыта: заказы на кассе доступны.":
              "Смена закрыта: доступны только онлайн-резервы для самовывоза."}</p>
          </div>
        </div>
        <div className="studio-form-grid">
          <label>{current.open_shift_id?"Наличные при закрытии смены, ₽":
            "Наличные на начало смены, ₽"}
            <input type="number" min="0" step="0.01" value={shiftCash}
              onChange={e=>setShiftCash(e.target.value)}/>
          </label>
          <div className="studio-form-actions">
            <button type="button" disabled={busy} onClick={()=>
              void changeShift(current.open_shift_id?"close":"open")}>
              {current.open_shift_id?"Закрыть смену":"Открыть смену"}
            </button>
          </div>
        </div>
        <p>Открытие и закрытие смены не регистрирует чек ККТ и не проводит оплату.</p>
      </section>:null}
      {current?<section className="studio-section">
        <h2>Резерв под покупателя</h2>
        <p>Продавец на кассе или оператор самовывоза создаёт один общий заказ.
          Он резервирует товар на складе именно выбранной точки.
          <strong>Оплата и фискальный чек не создаются автоматически.</strong></p>
        <div className="studio-form-grid">
          <label>Канал продажи
            <select value={mode}
              onChange={e=>setMode(e.target.value as typeof mode)}>
              <option value="COUNTER" disabled={!current.open_shift_id}>
                В магазине (касса)
              </option>
              <option value="CLICK_COLLECT" disabled={!current.pickup_enabled}>
                Самовывоз онлайн-заказа
              </option>
            </select>
          </label>
          <label>Клиент (необязательно)
            <select value={customerId} onChange={e=>setCustomerId(e.target.value)}>
              <option value="">Без клиента</option>
              {customers.map(c=><option key={c.id} value={c.id}>
                {c.displayName}
              </option>)}
            </select>
          </label>
          <label>Товар в выбранной точке
            <select value={selectedSku} onChange={e=>setSelectedSku(e.target.value)}>
              <option value="">Выберите SKU</option>
              {available.map(item=><option value={item.sku_id} key={item.sku_id}>
                {item.product_name} · {item.sku_code} ({pcs(item.sellable_milli)} шт.)
              </option>)}
            </select>
          </label>
          <label>Количество
            <input type="number" value={quantity} onChange={e=>setQuantity(e.target.value)}
              min="0.001" step="1" />
          </label>
        </div>
        <button type="button" onClick={()=>void reserve()}
          disabled={busy||!selectedSku||(mode==="COUNTER"&&!current.open_shift_id)}>
          Создать заказ и резерв</button>
        <p className="muted">При сбое сети повторите запрос, не меняя заказ:
          система использует ключ идемпотентности и проверяет склад.</p>
      </section>:null}
      {current?<section className="studio-section">
        <div className="studio-section-head">
          <div><h2>Заказы торговой точки</h2>
            <p>Реальные заказы из Sales с их статусом оплаты и отгрузки.</p></div>
          <a href="/app/sales/orders" className="secondary-button">Все заказы</a>
        </div>
        {orders.length?orders.map(o=><article key={o.id} className="first-day-step">
          <span>{o.channel==="COUNTER"?"₽":"↗"}</span>
          <div>
            <strong>{o.business_number} · {rub(o.total_minor)}</strong>
            <p>{o.customer_name??"Без клиента"} · {o.order_status} ·
              {o.fulfillment_status} · {o.payment_status}</p>
          </div>
          <a href="/app/sales/orders" aria-label="Открыть заказы">→</a>
        </article>):<p>На этой точке пока нет оформленных заказов.</p>}
      </section>:null}
      <section className="studio-section">
        <h2>Важное ограничение кассы</h2>
        <p>Открытие/закрытие смены ведётся в backend, но реальная
          выдача фискального чека, эквайринг терминала, маркировка
          и подтверждение наличной оплаты требуют отдельного
          подключения ККТ и проверки 54-ФЗ. До этого используйте
          создание заказов и резервирование, а не имитацию оплаты.</p>
      </section>
    </section>
  </main>;
}
