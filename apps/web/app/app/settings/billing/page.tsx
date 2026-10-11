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

export default function BillingPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [current, setCurrent] = useState<CurrentBilling | null>(null);
  const [error, setError] = useState("");
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить подписку");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
            const requiresPayment = Number(plan.monthlyPriceMinor) > 0 && !active;
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
                  disabled={pending || active || requiresPayment}
                  onClick={() => void selectPlan(plan.code)}
                  type="button"
                  title={requiresPayment
                    ? "Платные тарифы станут доступны после подключения оплаты" : undefined}
                >
                  {active ? "Текущий" : requiresPayment
                    ? "Оплата пока недоступна" : "Выбрать"}
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
                  ? "Автопродление отключено. Доступ сохранится до конца периода."
                  : "Продление тарифа зависит от условий сервиса. Автоматическое списание сейчас не подключено."}
              </span>
            </div>

            <button
              className="secondary-button"
              disabled={pending}
              onClick={() => void toggleCancel()}
              type="button"
            >
              {current.subscription.cancelAtPeriodEnd
                ? "Вернуть продление"
                : "Отменить в конце периода"}
            </button>
          </section>
        ) : null}
      </section>
    </main>
  );
}
