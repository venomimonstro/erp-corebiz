"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";

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
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось изменить состояние");
    }finally{setBusyTenant(null);}
  }

  useEffect(() => { void load(); },[load]);

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
              <td>{t.tenantStatus==="ACTIVE"?
                <button type="button" disabled={busyTenant!==null}
                  onClick={()=>void setSuspension(t,"SUSPEND")}>
                  {busyTenant===t.tenantId?"Изменяем…":"Приостановить"}
                </button>:t.tenantStatus==="SUSPENDED"?
                <button type="button" disabled={busyTenant!==null}
                  onClick={()=>void setSuspension(t,"RESUME")}>
                  {busyTenant===t.tenantId?"Изменяем…":"Возобновить"}
                </button>:"—"}</td>
            </tr>)}
          </tbody>
        </table>
      </div>}
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
