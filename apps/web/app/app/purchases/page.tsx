"use client";

import {type FormEvent,useCallback,useEffect,useRef,useState} from "react";
import {AppSidebar} from "../../../components/app-sidebar";
import {apiRequest} from "../../../lib/api";

type Supplier={id:string;displayName:string;phone:string|null;email:string|null};
type Product={skuId:string;productName:string;sku:string;costPriceMinor:string|null;currency:string};
type Warehouse={id:string;name:string;code:string;isDefault:boolean};
type Order={
  id:string;number:string;supplierName:string;status:
    "DRAFT"|"CONFIRMED"|"PARTIALLY_RECEIVED"|"RECEIVED"|"CANCELLED";
  totalMinor:string;currency:string;version:number;expectedAt:string|null
};
type Line={id:string;skuId:string;sku:string;productName:string;
  remainingQuantityMilli:string;orderedQuantityMilli:string;
  receivedQuantityMilli:string;unitCostMinor:string};
const money=(n:string)=>new Intl.NumberFormat("ru-RU",{
  style:"currency",currency:"RUB",maximumFractionDigits:2
}).format(Number(n)/100);
const label:Record<Order["status"],string>={
  DRAFT:"Черновик",CONFIRMED:"Ожидается поставка",
  PARTIALLY_RECEIVED:"Частично принято",RECEIVED:"Получено",CANCELLED:"Отменено"
};
function scaled(value:string,scale:number){
  const cleaned=value.trim().replace(",",".");
  if(!/^\d{1,12}(?:\.\d{1,3})?$/.test(cleaned))
    throw new Error("Введите положительное число без лишних символов");
  const [a,b=""]=cleaned.split(".");
  const digits=String(scale).length-1;
  if(b.length>digits)throw new Error("Слишком много знаков после запятой");
  const x=BigInt(a)*BigInt(scale)+BigInt(b.padEnd(digits,"0"));
  if(x<0n||x>9223372036854775807n)throw new Error("Неверное количество");
  return x.toString();
}
export default function PurchasesPage(){
  const [suppliers,setSuppliers]=useState<Supplier[]>([]);
  const [products,setProducts]=useState<Product[]>([]);
  const [warehouses,setWarehouses]=useState<Warehouse[]>([]);
  const [orders,setOrders]=useState<Order[]>([]);
  const [loading,setLoading]=useState(true);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [panel,setPanel]=useState<"supplier"|"order"|"receipt"|null>(null);
  const [supplierName,setSupplierName]=useState("");
  const [supplierContact,setSupplierContact]=useState("");
  const [supplierId,setSupplierId]=useState("");
  const [warehouseId,setWarehouseId]=useState("");
  const [skuId,setSkuId]=useState("");
  const [quantity,setQuantity]=useState("1");
  const [purchasePrice,setPurchasePrice]=useState("");
  const [expectedAt,setExpectedAt]=useState("");
  const [receiptOrder,setReceiptOrder]=useState<Order|null>(null);
  const [receiptLines,setReceiptLines]=useState<Line[]>([]);
  const [quantities,setQuantities]=useState<Record<string,string>>({});
  const [ack,setAck]=useState(false);
  const retry=useRef<{key:string;fingerprint:string;orderId:string}|null>(null);
  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const [o,s,p,w]=await Promise.all([
        apiRequest<Order[]>("/procurement/orders"),
        apiRequest<Supplier[]>("/procurement/suppliers"),
        apiRequest<Product[]>("/catalog/products"),
        apiRequest<Warehouse[]>("/inventory/warehouses")
      ]);
      setOrders(o);setSuppliers(s);setProducts(p);setWarehouses(w);
      setWarehouseId(current=>current||w.find(item=>item.isDefault)?.id||w[0]?.id||"");
    }catch(e){setError(e instanceof Error?e.message:"Не удалось загрузить закупки");}
    finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    const params=new URLSearchParams(window.location.search);
    if(params.get("create")==="1"){
      setPanel("order");
      window.history.replaceState(null,"","/app/purchases");
    }
  },[]);
  function chooseProduct(id:string){
    setSkuId(id);
    const product=products.find(p=>p.skuId===id);
    setPurchasePrice(product?.costPriceMinor===null?"":product?.costPriceMinor
      ?(Number(product.costPriceMinor)/100).toFixed(2):"");
  }
  async function saveSupplier(e:FormEvent){
    e.preventDefault();if(busy)return;
    setBusy(true);setError("");
    try{
      await apiRequest("/procurement/suppliers",{
        method:"POST",body:JSON.stringify({
          displayName:supplierName.trim(),type:"ORGANIZATION",
          email:supplierContact.includes("@")?supplierContact||undefined:undefined,
          phone:supplierContact&&!supplierContact.includes("@")?supplierContact:undefined
        })
      });
      setPanel("order");setSupplierName("");setSupplierContact("");
      setNotice("Поставщик добавлен. Теперь оформите закупку.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось создать поставщика");}
    finally{setBusy(false);}
  }
  async function saveOrder(e:FormEvent){
    e.preventDefault();if(busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const qty=scaled(quantity,1000),cost=scaled(purchasePrice,100);
      if(BigInt(qty)<=0n)throw new Error("Количество должно быть больше нуля");
      if(!warehouseId)throw new Error("Сначала создайте склад в разделе «Остатки»");
      await apiRequest("/procurement/orders",{
        method:"POST",body:JSON.stringify({
          supplierPartyId:supplierId,destinationWarehouseId:warehouseId,
          expectedAt:expectedAt?new Date(expectedAt+"T12:00:00").toISOString():undefined,
          lines:[{skuId,quantityMilli:qty,unitCostMinor:cost}]
        })
      });
      setPanel(null);setQuantity("1");setPurchasePrice("");
      setSkuId("");setSupplierId("");setExpectedAt("");
      setNotice("Заказ поставщику создан. Подтвердите его и проведите приёмку по факту.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Закупка не создана");}
    finally{setBusy(false);}
  }
  async function confirm(order:Order){
    if(busy)return;setBusy(true);setError("");
    try{
      await apiRequest("/procurement/orders/"+order.id+"/confirm",{
        method:"PATCH",body:JSON.stringify({version:order.version})
      });
      setNotice("Закупка подтверждена. Остатки появятся только после приёмки.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось подтвердить");}
    finally{setBusy(false);}
  }
  async function openReceipt(order:Order){
    setBusy(true);setError("");
    try{
      const lines=await apiRequest<Line[]>("/procurement/orders/"+order.id+"/lines");
      const active=lines.filter(x=>BigInt(x.remainingQuantityMilli)>0n);
      if(!active.length)throw new Error("Все позиции уже приняты");
      setReceiptOrder(order);setReceiptLines(active);
      setQuantities(Object.fromEntries(active.map(x=>
        [x.id,String(Number(x.remainingQuantityMilli)/1000)])));
      setAck(false);setPanel("receipt");
    }catch(e){setError(e instanceof Error?e.message:"Приёмка недоступна");}
    finally{setBusy(false);}
  }
  async function receive(e:FormEvent){
    e.preventDefault();if(!receiptOrder||!ack||busy)return;
    setBusy(true);setError("");setNotice("");
    try{
      const lines=receiptLines.flatMap(line=>{
        const qty=scaled(quantities[line.id]??"0",1000);
        if(BigInt(qty)>BigInt(line.remainingQuantityMilli))
          throw new Error("Получено больше оставшегося количества: "+line.sku);
        return BigInt(qty)>0n?[{purchaseOrderLineId:line.id,quantityMilli:qty}]:[];
      });
      if(!lines.length)throw new Error("Укажите реально полученное количество");
      const fingerprint=JSON.stringify([...lines].sort((a,b)=>
        a.purchaseOrderLineId.localeCompare(b.purchaseOrderLineId)));
      if(retry.current&&
        (retry.current.orderId!==receiptOrder.id||
         retry.current.fingerprint!==fingerprint))
        throw new Error("После неопределённого ответа предыдущей приёмки нельзя менять состав. Сначала сверьте заказ.");
      if(!retry.current)retry.current={
        key:crypto.randomUUID(),fingerprint,orderId:receiptOrder.id
      };
      const response=await apiRequest<{number:string}>(
        "/procurement/orders/"+receiptOrder.id+"/receipts",{
          method:"POST",body:JSON.stringify({
            lines,idempotencyKey:retry.current.key
          })
        });
      retry.current=null;
      setNotice("Приёмка "+response.number+" проведена. Остатки обновлены складским ledger.");
      setReceiptOrder(null);setPanel(null);setAck(false);
      await load();
    }catch(e){
      setError((e instanceof Error?e.message:"Приёмка не подтверждена")+
        ". Проверьте заказ перед повтором, чтобы не создать двойной приход.");
    }finally{setBusy(false);}
  }
  return <main className="app-shell">
    <AppSidebar active="purchases"/>
    <section className="workspace workspace-wide catalog-workspace">
      <header className="workspace-header">
        <div><p className="muted">Снабжение / Склад</p><h1>Закупки и приход товара</h1>
          <p className="workspace-summary">{orders.length} заказов ·
            {" "}{suppliers.length} поставщиков. Создание закупки не изменяет остатки.</p></div>
        <div className="catalog-actions">
          <button className="secondary-button" onClick={()=>setPanel("supplier")}>
            + Поставщик</button>
          <button onClick={()=>setPanel("order")}>+ Новая закупка</button>
        </div>
      </header>
      <nav className="catalog-guide">
        <a href="/app/catalog/products">Каталог и цены →</a>
        <a href="/app/inventory/stock">Остатки по складам →</a>
      </nav>
      {error?<p className="inline-error" role="alert">{error}</p>:null}
      {notice?<p className="catalog-notice" role="status">{notice}</p>:null}
      {loading?<p role="status">Загрузка…</p>:null}
      {!loading?<div className="data-table-wrap"><table className="data-table">
        <thead><tr><th>Закупка</th><th>Поставщик</th><th>Сумма</th>
          <th>Состояние</th><th>Поставка</th><th>Действия</th></tr></thead>
        <tbody>{orders.map(o=><tr key={o.id}>
          <td><strong>{o.number}</strong></td><td>{o.supplierName}</td>
          <td>{money(o.totalMinor)}</td><td>{label[o.status]}</td>
          <td>{o.expectedAt?new Date(o.expectedAt).toLocaleDateString("ru-RU"):"—"}</td>
          <td>{o.status==="DRAFT"?<button type="button"
            disabled={busy} onClick={()=>void confirm(o)}>Подтвердить</button>:null}
            {["CONFIRMED","PARTIALLY_RECEIVED"].includes(o.status)?
              <button type="button" disabled={busy}
                onClick={()=>void openReceipt(o)}>Принять товар</button>:null}</td>
        </tr>)}
        {!orders.length?<tr><td colSpan={6}>Создайте поставщика и первую закупку.</td></tr>:null}
        </tbody></table></div>:null}
      {panel?<div className="catalog-drawer-overlay">
        <section className="catalog-drawer" role="dialog" aria-modal="true"
          aria-label={panel==="supplier"?"Новый поставщик":
            panel==="order"?"Новая закупка":"Приёмка товара"}>
          <div className="catalog-drawer-head">
            <h2>{panel==="supplier"?"Новый поставщик":
              panel==="order"?"Заказ поставщику":"Приёмка "+receiptOrder?.number}</h2>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={()=>{setPanel(null);setReceiptOrder(null);retry.current=null;}}>
              Закрыть</button>
          </div>
          {panel==="supplier"?<form className="catalog-editor-form"
            onSubmit={e=>void saveSupplier(e)}>
            <label>Поставщик *
              <input required minLength={2} value={supplierName}
                onChange={e=>setSupplierName(e.target.value)}/></label>
            <label>Телефон или email
              <input value={supplierContact}
                onChange={e=>setSupplierContact(e.target.value)}/></label>
            <button disabled={busy||supplierName.trim().length<2}>Создать</button>
          </form>:null}
          {panel==="order"?<form className="catalog-editor-form"
            onSubmit={e=>void saveOrder(e)}>
            <label>Поставщик *
              <select required value={supplierId} onChange={e=>setSupplierId(e.target.value)}>
                <option value="">Выберите поставщика</option>
                {suppliers.map(x=><option key={x.id} value={x.id}>{x.displayName}</option>)}
              </select></label>
            <label>Товар / SKU *
              <select required value={skuId} onChange={e=>chooseProduct(e.target.value)}>
                <option value="">Выберите товар</option>
                {products.map(x=><option key={x.skuId} value={x.skuId}>
                  {x.productName} · {x.sku}</option>)}
              </select></label>
            <div className="catalog-editor-two">
              <label>Количество *
                <input required inputMode="decimal" value={quantity}
                  onChange={e=>setQuantity(e.target.value)}/></label>
              <label>Цена закупки за единицу, ₽ *
                <input required inputMode="decimal" value={purchasePrice}
                  onChange={e=>setPurchasePrice(e.target.value)}/></label>
            </div>
            <label>Склад назначения *
              <select required value={warehouseId}
                onChange={e=>setWarehouseId(e.target.value)}>
                <option value="">Выберите склад</option>
                {warehouses.map(w=><option key={w.id} value={w.id}>
                  {w.name}</option>)}
              </select></label>
            <label>Ожидаемая дата поставки
              <input type="date" value={expectedAt}
                onChange={e=>setExpectedAt(e.target.value)}/></label>
            <p className="muted">Этот документ фиксирует заказ поставщику.
              Он не увеличивает складской остаток до фактической приёмки.</p>
            <button disabled={busy||!supplierId||!skuId||!warehouseId}>
              Создать закупку</button>
          </form>:null}
          {panel==="receipt"&&receiptOrder?
            <form className="catalog-editor-form" onSubmit={e=>void receive(e)}>
              <p>Укажите фактически полученные количества. Нельзя принять
                больше остатка по заказу. Поступление изменит складской ledger.</p>
              {receiptLines.map(line=><label key={line.id}>
                {line.productName} · {line.sku} (осталось {Number(line.remainingQuantityMilli)/1000})
                <input inputMode="decimal" required value={quantities[line.id]??""}
                  onChange={e=>setQuantities(v=>({...v,[line.id]:e.target.value}))}/>
              </label>)}
              <label className="catalog-archive-confirm">
                <input type="checkbox" checked={ack}
                  onChange={e=>setAck(e.target.checked)}/>
                Подтверждаю факт поступления этих товаров на склад.
              </label>
              <button disabled={busy||!ack}>Провести приёмку</button>
              <p className="muted">При неопределённом ответе используется тот же
                ключ операции, повтор не должен создавать второй приход.</p>
            </form>:null}
        </section>
      </div>:null}
    </section>
  </main>;
}
