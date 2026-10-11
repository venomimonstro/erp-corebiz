"use client";
import {useCallback,useEffect,useState} from "react";
import {AppSidebar} from "../../../../components/app-sidebar";
import {apiRequest} from "../../../../lib/api";
type Location={id:string;name:string;code:string};
type Stock={sku_id:string;sku_code:string;product_name:string;physical_milli:string};
type Unit={
  id:string;sku_id:string;sku_code:string;serial_number:string;imei:string|null;
  gtin:string|null;marking_product_group:string|null;marking_code_present:boolean;
  marking_state:string;stock_state:string
};
export default function SerializedElectronicsPage(){
  const [locations,setLocations]=useState<Location[]>([]);
  const [locationId,setLocationId]=useState("");
  const [stocks,setStocks]=useState<Stock[]>([]);
  const [units,setUnits]=useState<Unit[]>([]);
  const [skuId,setSkuId]=useState("");
  const [serial,setSerial]=useState("");
  const [imei,setImei]=useState("");
  const [gtin,setGtin]=useState("");
  const [group,setGroup]=useState("");
  const [code,setCode]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [note,setNote]=useState("");
  useEffect(()=>{
    void apiRequest<Location[]>("/retail/locations").then(rows=>{
      setLocations(rows);setLocationId(rows[0]?.id??"");
    }).catch(e=>setError(e instanceof Error?e.message:"Нет доступа к точкам"));
  },[]);
  const load=useCallback(async()=>{
    if(!locationId)return;
    try{
      const [items,registered]=await Promise.all([
        apiRequest<Stock[]>("/retail/locations/"+locationId+"/stock"),
        apiRequest<Unit[]>("/retail/locations/"+locationId+"/serialized")
      ]);
      setStocks(items.filter(x=>Number(x.physical_milli)>=1000));
      setUnits(registered);
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить серию");}
  },[locationId]);
  useEffect(()=>{void load();},[load]);
  async function save(){
    if(!skuId||!serial.trim()||busy)return;
    setBusy(true);setError("");setNote("");
    try{
      await apiRequest("/retail/locations/"+locationId+"/serialized",{
        method:"POST",body:JSON.stringify({
          skuId,serialNumber:serial.trim(),
          ...(imei?{imei}:{ } ),...(gtin?{gtin}:{}),
          ...(group?{markingProductGroup:group}:{}),
          ...(code?{markingCode:code}:{})
        })
      });
      setNote("Серийная единица зарегистрирована. Маркировка не проверена у ГИС МТ.");
      setSerial("");setImei("");setGtin("");setGroup("");setCode("");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Единица не зарегистрирована");}
    finally{setBusy(false);}
  }
  return <main className="app-shell">
    <AppSidebar active="retail"/>
    <section className="workspace workspace-wide studio-premium">
      <header className="studio-hero compact"><div>
        <span className="studio-eyebrow">Розница · учёт электроники</span>
        <h1>Серийные номера, IMEI и маркировка</h1>
        <p>Укажите заводской номер и IMEI устройства, при необходимости
          сохраните считанный Data Matrix. Код маркировки шифруется и
          не показывается повторно в интерфейсе.</p>
      </div><a className="secondary-button" href="/app/retail">
        Сеть магазинов →</a></header>
      {error?<p className="inline-error" role="alert">{error}</p>:null}
      {note?<p role="status">{note}</p>:null}
      <section className="studio-section">
        <label>Магазин, в котором фактически находится товар
          <select value={locationId} onChange={e=>{
            setLocationId(e.target.value);setSkuId("");
          }}>
            {locations.map(l=><option value={l.id} key={l.id}>
              {l.name} · {l.code}</option>)}
          </select>
        </label>
        <div className="studio-form-grid">
          <label>Товар (в наличии)
            <select value={skuId} onChange={e=>setSkuId(e.target.value)}>
              <option value="">Выберите SKU</option>
              {stocks.map(s=><option key={s.sku_id} value={s.sku_id}>
                {s.product_name} · {s.sku_code}</option>)}
            </select>
          </label>
          <label>Серийный номер
            <input value={serial} onChange={e=>setSerial(e.target.value)}
              placeholder="Заводской номер на корпусе"/>
          </label>
          <label>IMEI (при наличии)
            <input value={imei} onChange={e=>setImei(e.target.value)}
              placeholder="15 цифр" inputMode="numeric" maxLength={15}/>
          </label>
          <label>GTIN (для маркировки)
            <input value={gtin} onChange={e=>setGtin(e.target.value)}
              placeholder="14 цифр" inputMode="numeric" maxLength={14}/>
          </label>
          <label>Код товарной группы (для маркировки)
            <input value={group} onChange={e=>setGroup(e.target.value)}
              placeholder="Группа из документации ГИС МТ"/>
          </label>
          <label>Data Matrix (сканер или строка)
            <input value={code} onChange={e=>setCode(e.target.value)}
              autoComplete="off" placeholder="Вставить считанный код"/>
          </label>
        </div>
        <button type="button" disabled={busy||!skuId||!serial.trim()}
          onClick={()=>void save()}>Зарегистрировать единицу</button>
        <p className="muted">Перед этим должен существовать реальный приход
          на склад точки. Количество зарегистрированных серийных единиц
          не может превысить её физический остаток.</p>
      </section>
      <section className="studio-section">
        <h2>Зарегистрированные единицы ({units.length})</h2>
        <div className="data-table-wrap"><table className="data-table">
          <thead><tr><th>Артикул</th><th>Serial</th><th>IMEI</th>
            <th>GTIN</th><th>Data Matrix</th><th>Статус</th></tr></thead>
          <tbody>{units.map(u=><tr key={u.id}>
            <td>{u.sku_code}</td><td>{u.serial_number}</td><td>{u.imei??"—"}</td>
            <td>{u.gtin??"—"}</td>
            <td>{u.marking_code_present?"Сохранён, не проверен":"Нет"}</td>
            <td>{u.stock_state} · {u.marking_state}</td>
          </tr>)}</tbody>
        </table></div>
      </section>
      <section className="studio-section">
        <h2>Ограничения перед продажей маркированного товара</h2>
        <p>Этот регистр не выполняет проверку кода в «Честном ЗНАКе»,
          не отправляет документы ЭДО и не выводит маркированный товар
          из оборота. Перед продажей соответствующих категорий
          необходимы True API, УКЭП, разрешительный режим, совместимая
          ККТ и связывание единицы с подтверждённой отгрузкой.</p>
      </section>
    </section>
  </main>;
}
