"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiRequest } from "../../lib/api";

type SuspensionRecord = {
  id:string;
  suspendedAt:string;
  resumedAt:string|null;
  reason:string;
  resumeReason:string|null;
};

type CommercialSummary = {
  tenants:number;
  operating:number;
  suspended:number;
  readOnly:number;
  trial:number;
  paidActive:number;
  missingSubscription:number;
  pastDue:number;
  expiredSubscriptions:number;
};

type SupportQueueItem = {
  ticketId:string;
  tenantId:string;
  companyName:string;
  number:string;
  subject:string;
  status:string;
  priority:string;
  category:string|null;
  createdAt:string;
  updatedAt:string;
  firstResponseDueAt:string;
  resolutionDueAt:string;
  firstRespondedAt:string|null;
  slaBreachedAt:string|null;
  escalationLevel:number;
};

type SupportDetails = {
  ticket: SupportQueueItem & {contextUrl:string|null};
  messages:Array<{
    id:string;
    body:string;
    createdAt:string;
    authorKind:"CUSTOMER"|"OPERATOR";
  }>;
  attachments:Array<{
    id:string;
    filename:string;
    mimeType:string|null;
    sizeBytes:string;
    createdAt:string;
  }>;
};

type Tenant = {
  tenantId: string;
  companyName: string;
  tenantStatus: string;
  subscriptionStatus: string | null;
  planCode: string | null;
  periodEnd: string | null;
  activeUsers: number;
  openTickets: number;
  createdAt: string;
};

export default function PlatformOperationsPage() {
  const [items,setItems] = useState<Tenant[]>([]);
  const [total,setTotal] = useState(0);
  const [summary,setSummary] = useState<CommercialSummary|null>(null);
  const [offset,setOffset] = useState(0);
  const [error,setError] = useState("");
  const [loading,setLoading] = useState(true);
  const [busyTenant,setBusyTenant] = useState<string|null>(null);
  const [historyTenant,setHistoryTenant] = useState<string|null>(null);
  const [history,setHistory] = useState<SuspensionRecord[]>([]);
  const historySerial = useRef(0);
  const [supportItems,setSupportItems]=useState<SupportQueueItem[]>([]);
  const [supportTotal,setSupportTotal]=useState(0);
  const [supportOffset,setSupportOffset]=useState(0);
  const [supportSelected,setSupportSelected]=useState<SupportDetails|null>(null);
  const [supportReply,setSupportReply]=useState("");
  const [supportLoading,setSupportLoading]=useState(false);


  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<{ total:number; items:Tenant[] }>(
        "/platform-operations/tenants?limit=25&offset=" + offset
      );
      setItems(data.items);
      setTotal(data.total);
      void apiRequest<CommercialSummary>("/platform-operations/summary")
        .then(setSummary).catch(()=>setSummary(null));
    } catch (cause) {
      setItems([]);
      setTotal(0);
      setError(cause instanceof Error ? cause.message : "Нет доступа");
    } finally {
      setLoading(false);
    }
  },[offset]);

  const loadSupport=useCallback(async()=>{
    setSupportLoading(true);
    try{
      const data=await apiRequest<{total:number;items:SupportQueueItem[]}>(
        "/platform-operations/support/tickets?limit=25&offset="+supportOffset
      );
      setSupportItems(data.items);
      setSupportTotal(data.total);
    }catch(cause){
      setSupportItems([]);
      setSupportTotal(0);
      setError(cause instanceof Error?cause.message:"Поддержка недоступна");
    }finally{
      setSupportLoading(false);
    }
  },[supportOffset]);

  async function openSupportTicket(ticketId:string){
    setError("");
    try{
      setSupportSelected(
        await apiRequest<SupportDetails>(
          "/platform-operations/support/tickets/"+encodeURIComponent(ticketId)
        )
      );
      setSupportReply("");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Обращение недоступно");
    }
  }

  async function sendSupportReply(){
    if(!supportSelected||!supportReply.trim())return;
    try{
      await apiRequest(
        "/platform-operations/support/tickets/"+
          encodeURIComponent(supportSelected.ticket.ticketId)+"/reply",
        {method:"POST",body:JSON.stringify({body:supportReply.trim()})}
      );
      setSupportReply("");
      await Promise.all([
        openSupportTicket(supportSelected.ticket.ticketId),
        loadSupport()
      ]);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось ответить");
    }
  }

  async function closeSupportTicket(){
    if(!supportSelected)return;
    const resolution=window.prompt(
      "Укажите итог решения обращения (10–2000 символов). Клиент увидит этот текст."
    );
    if(resolution===null)return;
    if(resolution.trim().length<10||resolution.trim().length>2000){
      setError("Укажите результат от 10 до 2000 символов");
      return;
    }
    try{
      await apiRequest(
        "/platform-operations/support/tickets/"+
          encodeURIComponent(supportSelected.ticket.ticketId)+"/close",
        {method:"PATCH",body:JSON.stringify({resolution:resolution.trim()})}
      );
      setSupportSelected(null);
      await loadSupport();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось закрыть обращение");
    }
  }

  async function downloadSupportAttachment(id:string){
    try{
      const file=await apiRequest<{url:string;expiresAt:string;filename:string}>(
        "/platform-operations/support/attachments/"+
          encodeURIComponent(id)+"/download"
      );
      const url=new URL(file.url);
      if(!["https:","http:"].includes(url.protocol))
        throw new Error("Недопустимая ссылка");
      window.open(url.toString(),"_blank","noopener,noreferrer");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Вложение недоступно");
    }
  }

  async function showHistory(tenant:Tenant) {
    const serial=++historySerial.current;
    setHistoryTenant(tenant.companyName);
    setHistory([]);
    try {
      const data = await apiRequest<SuspensionRecord[]>(
        "/platform-operations/tenants/"+encodeURIComponent(tenant.tenantId)+"/suspensions"
      );
      if(serial===historySerial.current)setHistory(data);
    } catch (cause) {
      if(serial===historySerial.current)
        setError(cause instanceof Error?cause.message:"История недоступна");
    }
  }

  async function setSuspension(tenant:Tenant, action:"SUSPEND"|"RESUME") {
    const label=action==="SUSPEND"?"приостановить":"возобновить";
    const confirmation=window.prompt(
      "Чтобы "+label+" компанию, введите её название полностью: "+tenant.companyName
    );
    if(confirmation===null)return;
    if(confirmation.trim()!==tenant.companyName){
      setError("Название не совпадает. Изменение отменено.");
      return;
    }
    const reason=window.prompt(
      "Укажите причину (от 15 до 800 символов). Она будет записана в журнал."
    );
    if(reason===null)return;
    if(reason.trim().length<15||reason.trim().length>800){
      setError("Укажите причину от 15 до 800 символов.");
      return;
    }
    setBusyTenant(tenant.tenantId);
    setError("");
    try{
      await apiRequest(
        "/platform-operations/tenants/"+encodeURIComponent(tenant.tenantId)+"/suspension",
        {method:"PATCH",body:JSON.stringify({action,reason:reason.trim()})}
      );
      ++historySerial.current;
      setHistoryTenant(null);
      setHistory([]);
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось изменить состояние");
    }finally{setBusyTenant(null);}
  }

  useEffect(() => { void load(); },[load]);
  useEffect(() => { void loadSupport(); },[loadSupport]);

  return <main className="workspace workspace-wide">
    <header className="workspace-header">
      <div>
        <p className="muted">Платформа CoreBiz · только для оператора</p>
        <h1>Клиенты сервиса</h1>
        <p className="muted">Панель не даёт доступ к коммерческим
          документам и данным клиентов. Оператор может приостановить и возобновить компанию с записью причины.
          Оплата, период подписки и документы при этом не меняются.</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading}>
        Обновить
      </button>
    </header>
    {error ? <div className="inline-error" role="alert">{error}</div> : null}
    {!error && summary ? <section className="studio-section">
      <h2>Коммерческое состояние платформы</h2>
      <div className="crm-funnel-metrics">
        <article><small>Компаний всего</small><strong>{summary.tenants}</strong></article>
        <article><small>Работают</small><strong>{summary.operating}</strong></article>
        <article><small>Приостановлены</small><strong>{summary.suspended}</strong></article>
        <article><small>Пробный период</small><strong>{summary.trial}</strong></article>
        <article><small>Активные с отметкой оплаты</small><strong>{summary.paidActive}</strong></article>
        <article><small>Только чтение</small><strong>{summary.readOnly}</strong></article>
        <article><small>Без подписки</small><strong>{summary.missingSubscription}</strong></article>
        <article><small>Задолженность / льготный период</small><strong>{summary.pastDue}</strong></article>
        <article><small>Истёк срок</small><strong>{summary.expiredSubscriptions}</strong></article>
      </div>
      <p className="muted">Статистика отражает данные БД, а не подтверждение
        банковского зачисления. Оплаченные подписки требуют отдельной сверки с ЮKassa.</p>
    </section> : null}
    {!error ? <section className="studio-section">
      <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center"}}>
        <div>
          <h2>Поддержка клиентов: {supportTotal}</h2>
          <p className="muted">
            SLA считается сервером. Просрочка автоматически повышает уровень
            эскалации и остаётся в журнале.
          </p>
        </div>
        <button type="button" disabled={supportLoading}
          onClick={()=>void loadSupport()}>Обновить обращения</button>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"minmax(320px,0.9fr) minmax(420px,1.4fr)",gap:16}}>
        <div>
          {supportLoading ? <p>Загрузка…</p> :
            supportItems.length===0 ? <p className="muted">Открытых обращений нет.</p> :
            <div className="support-ticket-list">
              {supportItems.map(item=><button
                className={
                  supportSelected?.ticket.ticketId===item.ticketId
                    ?"support-ticket active":"support-ticket"
                }
                key={item.ticketId}
                onClick={()=>void openSupportTicket(item.ticketId)}
                type="button">
                <div>
                  <strong>{item.companyName} · {item.subject}</strong>
                  <span>{item.number} · {item.priority} · {item.status}</span>
                </div>
                <small>
                  {item.escalationLevel>0
                    ?"SLA L"+item.escalationLevel
                    :"до "+new Date(
                      item.firstRespondedAt
                        ?item.resolutionDueAt:item.firstResponseDueAt
                    ).toLocaleString("ru-RU")}
                </small>
              </button>)}
            </div>}
          <div style={{display:"flex",gap:10,marginTop:12,alignItems:"center"}}>
            <button type="button"
              disabled={supportOffset===0||supportLoading}
              onClick={()=>setSupportOffset(Math.max(0,supportOffset-25))}>
              Назад
            </button>
            <span>
              {supportTotal===0?"0":supportOffset+1}–
              {Math.min(supportTotal,supportOffset+25)} из {supportTotal}
            </span>
            <button type="button"
              disabled={supportOffset+25>=supportTotal||supportLoading}
              onClick={()=>setSupportOffset(supportOffset+25)}>
              Далее
            </button>
          </div>
        </div>
        <div>
          {supportSelected ? <>
            <header style={{display:"flex",justifyContent:"space-between",gap:12}}>
              <div>
                <small>{supportSelected.ticket.companyName} · {supportSelected.ticket.number}</small>
                <h3>{supportSelected.ticket.subject}</h3>
                <p className="muted">
                  {supportSelected.ticket.priority} · {supportSelected.ticket.status}
                  {supportSelected.ticket.escalationLevel>0
                    ?" · эскалация L"+supportSelected.ticket.escalationLevel:""}
                </p>
              </div>
              <button className="secondary-button" type="button"
                onClick={()=>void closeSupportTicket()}>Закрыть с итогом</button>
            </header>
            <div className="message-stream">
              {supportSelected.messages.map(message=><article
                className="support-message" key={message.id}>
                <small>{message.authorKind==="OPERATOR"?"Оператор":"Клиент"}</small>
                <p>{message.body}</p>
                <small>{new Date(message.createdAt).toLocaleString("ru-RU")}</small>
              </article>)}
            </div>
            {supportSelected.attachments.length ? <div className="support-attachments">
              <strong>Вложения клиента</strong>
              <div className="support-attachment-list">
                {supportSelected.attachments.map(file=><button
                  className="secondary-button" key={file.id} type="button"
                  onClick={()=>void downloadSupportAttachment(file.id)}>
                  {file.filename} · {Math.max(1,Math.ceil(Number(file.sizeBytes)/1024))} КБ
                </button>)}
              </div>
            </div>:null}
            <div className="support-reply">
              <textarea rows={3} value={supportReply}
                onChange={event=>setSupportReply(event.target.value)}
                placeholder="Ответ клиенту…"/>
              <button type="button" disabled={!supportReply.trim()}
                onClick={()=>void sendSupportReply()}>Отправить ответ</button>
            </div>
          </> : <p className="muted">
            Выберите обращение. Доступ ограничен данными service desk;
            коммерческие документы tenant не открываются.
          </p>}
        </div>
      </div>
    </section> : null}
    {!error ? <section className="studio-section">
      <h2>Организации: {total}</h2>
      {loading ? <p>Загрузка…</p> : <div style={{overflowX:"auto"}}>
        <table>
          <thead><tr>
            <th>Компания</th><th>Организация</th><th>Тариф</th>
            <th>Подписка</th><th>Пользователей</th>
            <th>Обращений</th><th>Оплачен до / trial до</th><th>Действия</th>
          </tr></thead>
          <tbody>
            {items.map(t=><tr key={t.tenantId}>
              <td>{t.companyName}</td>
              <td>{t.tenantStatus}</td>
              <td>{t.planCode ?? "Нет"}</td>
              <td>{t.subscriptionStatus ?? "Нет"}</td>
              <td>{t.activeUsers}</td>
              <td>{t.openTickets}</td>
              <td>{t.periodEnd ?
                new Date(t.periodEnd).toLocaleDateString("ru-RU") : "—"}</td>
              <td><div style={{display:"flex",gap:8,alignItems:"center"}}><button type="button" onClick={()=>void showHistory(t)}>История</button>{t.tenantStatus==="ACTIVE"?
                <button type="button" disabled={busyTenant!==null}
                  onClick={()=>void setSuspension(t,"SUSPEND")}>
                  {busyTenant===t.tenantId?"Изменяем…":"Приостановить"}
                </button>:t.tenantStatus==="SUSPENDED"?
                <button type="button" disabled={busyTenant!==null}
                  onClick={()=>void setSuspension(t,"RESUME")}>
                  {busyTenant===t.tenantId?"Изменяем…":"Возобновить"}
                </button>:"—"}</div></td>
            </tr>)}
          </tbody>
        </table>
      </div>}
      {historyTenant ? <section className="studio-section">
        <h3>История решений: {historyTenant}</h3>
        {history.length===0 ? <p>Записей нет.</p> :
          <ul>{history.map(h=><li key={h.id}>
            <strong>{new Date(h.suspendedAt).toLocaleString("ru-RU")}</strong>
            {" · Приостановка: "}{h.reason}
            {h.resumedAt ? <span>
              {" · Возобновлено "}{new Date(h.resumedAt).toLocaleString("ru-RU")}
              {" · "}{h.resumeReason}
            </span>:null}
          </li>)}</ul>}
        <button type="button" onClick={()=>setHistoryTenant(null)}>Закрыть историю</button>
      </section> : null}
      <div style={{display:"flex",gap:12,marginTop:16,alignItems:"center"}}>
        <button type="button" disabled={offset===0 || loading}
          onClick={()=>setOffset(Math.max(0,offset-25))}>Назад</button>
        <span>{total===0 ? "0" : offset+1}–{Math.min(total,offset+25)} из {total}</span>
        <button type="button" disabled={offset+25>=total || loading}
          onClick={()=>setOffset(offset+25)}>Далее</button>
      </div>
    </section> : null}
  </main>;
}
