"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Plan = {
  id: string;
  code: string;
  name: string;
  monthlyPriceMinor: string;
  currency: string;
  entitlements: Record<string, unknown>;
  usage: Record<string, {
    used: number;
    limit: number | null;
    remaining: number | null;
    percent: number | null;
  }>;
};

type ReconciliationStatus = {
  enabled:boolean;
  jobs:Array<{state:string;count:number;oldestDue:string|null}>;
};

type CurrentBilling = {
  state: "ACTIVE" | "GRACE" | "READ_ONLY";
  subscription: {
    planId: string;
    planCode: string;
    planName: string;
    status: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    graceUntil: string | null;
    cancelAtPeriodEnd: boolean;
  };
  entitlements: Record<string, unknown>;
};

const usageLabels: Record<string,string> = {
  max_users: "Пользователи",
  max_branches: "Филиалы",
  max_warehouses: "Склады",
  max_service_resources: "Сотрудники и ресурсы"
};

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

type BillingEvent = {
  id:string; type:string; status:string|null;
  amountMinor:string|null; currency:string|null;
  provider:string|null; createdAt:string;
};

function BillingHistory() {
  const [events,setEvents]=useState<BillingEvent[]>([]);
  const [error,setError]=useState("");
  useEffect(()=>{
    let active=true;
    void apiRequest<BillingEvent[]>("/billing/events")
      .then(items=>{if(active)setEvents(items);})
      .catch(cause=>{
        if(active)setError(cause instanceof Error?cause.message:"Недоступно");
      });
    return ()=>{active=false;};
  },[]);
  if(error)return null; // History is restricted to billing.manage roles.
  return <section className="studio-section">
    <h2>История подписки</h2>
    <p className="muted">Записи операций сервиса. Подтверждение оплаты
      проверяется отдельно у платёжного провайдера.</p>
    {events.length===0?<p>Пока нет операций.</p>:
      <div style={{overflowX:"auto"}}><table>
        <thead><tr><th>Дата</th><th>Событие</th>
          <th>Статус</th><th>Сумма</th></tr></thead>
        <tbody>{events.map(event=><tr key={event.id}>
          <td>{new Date(event.createdAt).toLocaleString("ru-RU")}</td>
          <td>{event.type}</td>
          <td>{event.status??"—"}</td>
          <td>{event.amountMinor!==null && event.currency==="RUB"
            ?money(event.amountMinor,"RUB"):"—"}</td>
        </tr>)}</tbody>
      </table></div>}
  </section>;
}

export default function BillingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [reconciliation,setReconciliation]=useState<ReconciliationStatus|null>(null);
  const [current, setCurrent] = useState<CurrentBilling | null>(null);
  const [error, setError] = useState("");
  const [emailStatus,setEmailStatus] = useState<{verified:boolean;email:string}|null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<Plan[]>("/billing/plans"),
        apiRequest<CurrentBilling>("/billing/current")
      ]);
      setPlans(data[0]);
      setCurrent(data[1]);
      // Reconciliation is a separate operational integration. Failure to
      // load its statistics must not hide subscription information.
      void apiRequest<ReconciliationStatus>("/payments/reconciliation/status")
        .then(setReconciliation).catch(()=>setReconciliation(null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить подписку");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let mounted = true;
    void apiRequest<{verified:boolean;email:string}>("/auth/email-verification/status")
      .then(data => { if (mounted) setEmailStatus(data); })
      .catch(() => { if (mounted) setEmailStatus(null); });
    return () => { mounted = false; };
  }, []);

  async function payPlan(code:string){
    setPending(true);
    setError("");
    try{
      const response=await apiRequest<{
        intentId:string;status:string;confirmationUrl?:string;
      }>("/payments/saas/start",{
        method:"POST",body:JSON.stringify({planCode:code})
      });
      if(!response.confirmationUrl)throw new Error("Платёжная форма ещё не доступна");
      const url=new URL(response.confirmationUrl);
      if(url.protocol!=="https:" ||
        !["yookassa.ru","yoomoney.ru"].some(host=>
          url.hostname===host||url.hostname.endsWith("."+host))){
        throw new Error("Некорректная платёжная ссылка");
      }
      sessionStorage.setItem("corebiz_billing_payment_intent",response.intentId);
      window.location.assign(url.href);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось открыть оплату");
    }finally{setPending(false);}
  }

  useEffect(()=>{
    const intentId=sessionStorage.getItem("corebiz_billing_payment_intent");
    if(!intentId)return;
    let active=true;
    void apiRequest<{status:string;fiscal_status:string}>(
      "/payments/saas/"+encodeURIComponent(intentId)+"/status"
    ).then(state=>{
      if(!active)return;
      if(state.status==="SUCCEEDED"){
        sessionStorage.removeItem("corebiz_billing_payment_intent");
        void load();
      }
      if(state.status==="CANCELED"){
        sessionStorage.removeItem("corebiz_billing_payment_intent");
        setError("Платёж отменён. Тариф не изменён.");
      }
    }).catch(()=>{
      if(active)setError("Не удалось проверить оплату. Проверьте статус позже.");
    });
    return ()=>{active=false};
  },[load]);

  async function selectPlan(code: string) {
    setPending(true);
    setError("");
    try {
      await apiRequest("/billing/select-plan", {
        method: "POST",
        body: JSON.stringify({ planCode: code })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выбрать тариф");
    } finally {
      setPending(false);
    }
  }

  async function toggleCancel() {
    if (!current) return;

    setPending(true);
    setError("");
    try {
      await apiRequest("/billing/cancel-at-period-end", {
        method: "POST",
        body: JSON.stringify({
          value: !current.subscription.cancelAtPeriodEnd
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить подписку");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="billing" />

      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero compact billing-hero">
          <div>
            <span className="studio-eyebrow">Коммерческий контур</span>
            <h1>Тариф и ресурсы</h1>
            <p>
              Понимайте, за что платит компания, сколько лимита уже использовано
              и что произойдёт при смене тарифа. CoreBiz не удаляет данные при
              grace или read-only.
            </p>
          </div>
          {current ? (
            <div className="billing-plan-badge">
              <span>Текущий план</span>
              <strong>{current.subscription.planName}</strong>
              <small>{current.state}</small>
            </div>
          ) : null}
        </header>

        {emailStatus && !emailStatus.verified ? <section className="studio-section">
          <h2>Подтвердите адрес электронной почты</h2>
          <p>Подписка не может быть оплачена, пока адрес {emailStatus.email}
            не подтверждён. Работа в пробном тарифе сохраняется.</p>
          <a href="/app/verify-email">Отправить письмо подтверждения</a>
        </section> : null}
        {reconciliation?<section className="studio-section">
          <h2>Контроль подтверждения платежей</h2>
          <p>Фоновая сверка: <strong>{reconciliation.enabled?
            "включена":"не включена на сервере"}</strong>.
            Это независимая проверка ЮKassa, которая восстанавливает
            потерянные уведомления, не продлевая тариф дважды.</p>
          <div className="crm-funnel-metrics">
            <article><small>Ожидают проверки</small>
              <strong>{reconciliation.jobs.filter(j=>["DUE","LEASED"].includes(j.state))
                .reduce((sum,j)=>sum+j.count,0)}</strong>
            </article>
            <article><small>Требуют вмешательства</small>
              <strong>{reconciliation.jobs.find(j=>j.state==="EXHAUSTED")?.count??0}</strong>
            </article>
          </div>
          {!reconciliation.enabled?<p className="muted">
            Для коммерческих оплат включите на сервере
            COREBIZ_PAYMENT_RECONCILE_ENABLED после миграции 234.
          </p>:null}
        </section>:null}
        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {current ? (
          <section className="subscription-summary">
            <div>
              <span>Текущий тариф</span>
              <strong>{current.subscription.planName}</strong>
            </div>
            <div>
              <span>Состояние</span>
              <strong>{current.state}</strong>
            </div>
            <div>
              <span>Период до</span>
              <strong>
                {new Date(current.subscription.currentPeriodEnd).toLocaleDateString("ru-RU")}
              </strong>
            </div>
            <div>
              <span>Grace до</span>
              <strong>
                {current.subscription.graceUntil
                  ? new Date(current.subscription.graceUntil).toLocaleDateString("ru-RU")
                  : "—"}
              </strong>
            </div>
          </section>
        ) : null}

        {current ? (
          <section className="studio-section billing-usage-section">
            <div className="studio-section-head">
              <div>
                <span>Использование тарифа</span>
                <h2>Запас для роста компании</h2>
                <p>
                  Лимиты контролируются сервером и базой данных. Их нельзя
                  обойти импортом, API или прямой операцией из другого раздела.
                </p>
              </div>
            </div>
            <div className="billing-usage-grid">
              {Object.entries(current.usage).map(([key,value]) => (
                <article key={key}>
                  <header>
                    <span>{usageLabels[key] ?? key}</span>
                    <strong>
                      {value.used}
                      <small>
                        {value.limit === null ? " / ∞" : " / " + value.limit}
                      </small>
                    </strong>
                  </header>
                  <div className="billing-usage-track">
                    <span style={{width: (value.percent ?? 0) + "%"}} />
                  </div>
                  <footer>
                    <span>
                      {value.limit === null
                        ? "Без ограничения"
                        : value.remaining + " доступно"}
                    </span>
                    <b>
                      {value.percent === null ? "∞" : value.percent + "%"}
                    </b>
                  </footer>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <div className="plan-grid">
          {plans.map((plan) => {
            const active = current?.subscription.planCode === plan.code;
            // Paid subscriptions can be purchased during a trial and renewed
            // on the same plan; previously the active plan button was always
            // disabled, blocking both of these legitimate checkout journeys.
            const requiresPayment = Number(plan.monthlyPriceMinor) > 0;
            const modules = Array.isArray(plan.entitlements.modules)
              ? plan.entitlements.modules
              : [];
            const maxUsers = plan.entitlements.max_users;
            const maxBranches = plan.entitlements.max_branches;
            const maxWarehouses = plan.entitlements.max_warehouses;
            const maxResources = plan.entitlements.max_service_resources;

            return (
              <article className={active ? "plan-card active" : "plan-card"} key={plan.id}>
                <div>
                  <span>{plan.code}</span>
                  <h2>{plan.name}</h2>
                  <strong>{money(plan.monthlyPriceMinor, plan.currency)} / мес</strong>
                </div>

                <ul>
                  <li>Пользователей: {String(maxUsers ?? "—")}</li>
                  <li>Филиалов: {String(maxBranches ?? "—")}</li>
                  <li>Складов: {String(maxWarehouses ?? "—")}</li>
                  <li>Сотрудников / ресурсов: {String(maxResources ?? "—")}</li>
                  <li>
                    Модули: {modules.includes("*") ? "Все" : modules.join(", ")}
                  </li>
                </ul>

                <button
                  disabled={pending || (active && !requiresPayment)}
                  onClick={() => void (requiresPayment
                    ? payPlan(plan.code) : selectPlan(plan.code))}
                  type="button"
                >
                  {active && requiresPayment
                    ? current?.subscription.status === "TRIAL"
                      ? "Оплатить этот тариф" : "Продлить на месяц"
                    : active ? "Текущий" : requiresPayment
                      ? "Перейти к безопасной оплате" : "Выбрать"}
                </button>
              </article>
            );
          })}
        </div>

        {current ? (
          <section className="subscription-actions">
            <div>
              <strong>Окончание подписки</strong>
              <span>
                {current.subscription.cancelAtPeriodEnd
                  ? "Подписка помечена к завершению. Доступ сохраняется до конца периода, автоматических списаний нет."
                  : "Автоматических списаний пока нет. Для продления можно оплатить текущий тариф на месяц вручную."}
              </span>
            </div>

            <button
              className="secondary-button"
              disabled={pending}
              onClick={() => void toggleCancel()}
              type="button"
            >
              {current.subscription.cancelAtPeriodEnd
                ? "Снять отметку завершения"
                : "Завершить в конце периода"}
            </button>
          </section>
        ) : null}
        <BillingHistory />
      </section>
    </main>
  );
}
