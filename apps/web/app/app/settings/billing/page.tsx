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

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Настройки / Подписка</p>
            <h1>Тариф и доступ</h1>
            <p className="workspace-summary">
              Данные не удаляются при grace или read-only.
            </p>
          </div>
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

        <div className="plan-grid">
          {plans.map((plan) => {
            const active = current?.subscription.planCode === plan.code;
            const modules = Array.isArray(plan.entitlements.modules)
              ? plan.entitlements.modules
              : [];
            const maxUsers = plan.entitlements.max_users;

            return (
              <article className={active ? "plan-card active" : "plan-card"} key={plan.id}>
                <div>
                  <span>{plan.code}</span>
                  <h2>{plan.name}</h2>
                  <strong>{money(plan.monthlyPriceMinor, plan.currency)} / мес</strong>
                </div>

                <ul>
                  <li>
                    Пользователей: {String(maxUsers ?? "—")}
                  </li>
                  <li>
                    Модули: {modules.includes("*") ? "Все" : modules.join(", ")}
                  </li>
                </ul>

                <button
                  disabled={pending || active}
                  onClick={() => void selectPlan(plan.code)}
                  type="button"
                >
                  {active ? "Текущий" : "Выбрать"}
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
                  : "Подписка продолжится после окончания текущего периода."}
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
