"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";

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
  const [offset,setOffset] = useState(0);
  const [error,setError] = useState("");
  const [loading,setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiRequest<{ total:number; items:Tenant[] }>(
        "/platform-operations/tenants?limit=25&offset=" + offset
      );
      setItems(data.items);
      setTotal(data.total);
    } catch (cause) {
      setItems([]);
      setTotal(0);
      setError(cause instanceof Error ? cause.message : "Нет доступа");
    } finally {
      setLoading(false);
    }
  },[offset]);

  useEffect(() => { void load(); },[load]);

  return <main className="workspace workspace-wide">
    <header className="workspace-header">
      <div>
        <p className="muted">Платформа CoreBiz · только для оператора</p>
        <h1>Клиенты сервиса</h1>
        <p className="muted">Панель не даёт доступ к коммерческим
          документам и данным клиентов. Изменение тарифов и блокировки
          в этой версии недоступны.</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading}>
        Обновить
      </button>
    </header>
    {error ? <div className="inline-error" role="alert">{error}</div> : null}
    {!error ? <section className="studio-section">
      <h2>Организации: {total}</h2>
      {loading ? <p>Загрузка…</p> : <div style={{overflowX:"auto"}}>
        <table>
          <thead><tr>
            <th>Компания</th><th>Организация</th><th>Тариф</th>
            <th>Подписка</th><th>Пользователей</th>
            <th>Обращений</th><th>Оплачен до / trial до</th>
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
