"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Customer = {
  id: string;
  displayName: string;
  phone: string | null;
};

type Service = {
  id: string;
  name: string;
};

type PackagePlan = {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  applicable_service_id: string | null;
  applicable_service_name: string | null;
  package_kind: "VISITS" | "PERIOD" | "UNLIMITED" | "FAMILY" | "INDIVIDUAL" | "COMBO" | "TRIAL" | "GIFT";
  visit_limit: number | null;
  duration_days: number;
  management_visit_value_minor: string;
  freeze_days_allowed: number;
  makeup_days_valid: number;
  allow_makeup: boolean;
  price_minor: string;
  currency: string;
  no_show_policy: "RELEASE" | "CONSUME";
};

type ServicePackage = {
  id: string;
  party_id: string;
  plan_id: string;
  starts_at: string;
  expires_at: string;
  visit_limit_snapshot: number | null;
  reserved_visits: number;
  used_visits: number;
  available_visits: number | null;
  package_kind_snapshot: string;
  price_minor_snapshot: string;
  currency: string;
  status: string;
  party_name: string;
  plan_name: string;
  no_show_policy: string;
};

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function ServicePackagesPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [plans, setPlans] = useState<PackagePlan[]>([]);
  const [packages, setPackages] = useState<ServicePackage[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [selectedPlan, setSelectedPlan] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [customerRows, serviceRows, planRows, packageRows] =
        await Promise.all([
          apiRequest<Customer[]>("/crm/customers"),
          apiRequest<Service[]>("/service/catalog"),
          apiRequest<PackagePlan[]>("/service/package-plans"),
          apiRequest<ServicePackage[]>("/service/packages")
        ]);

      setCustomers(customerRows);
      setServices(serviceRows);
      setPlans(planRows);
      setPackages(packageRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить абонементы");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const activePackages = useMemo(
    () => packages.filter((item) => item.status === "ACTIVE"),
    [packages]
  );

  async function createPlan() {
    const name = window.prompt("Название абонемента", "8 занятий");
    if (!name?.trim()) return;

    const kindRaw = (
      window.prompt(
        "Тип: VISITS, PERIOD, UNLIMITED, FAMILY, INDIVIDUAL, COMBO, TRIAL или GIFT",
        "VISITS"
      ) ?? "VISITS"
    ).trim().toUpperCase();
    const allowedKinds = [
      "VISITS",
      "PERIOD",
      "UNLIMITED",
      "FAMILY",
      "INDIVIDUAL",
      "COMBO",
      "TRIAL",
      "GIFT"
    ] as const;
    if (!allowedKinds.includes(kindRaw as (typeof allowedKinds)[number])) {
      setError("Неизвестный тип абонемента");
      return;
    }
    const packageKind = kindRaw as (typeof allowedKinds)[number];

    const visits =
      packageKind === "UNLIMITED"
        ? undefined
        : Number(window.prompt("Количество посещений", "8") ?? "8");
    const days = Number(window.prompt("Срок действия, дней", "30") ?? "30");
    const priceRub = Number(
      (window.prompt("Цена абонемента, ₽", "0") ?? "0").replace(",", ".")
    );
    const visitValueRub = Number(
      (
        window.prompt(
          "Управленческая стоимость одного посещения, ₽ (для безлимита особенно важно)",
          packageKind === "UNLIMITED" ? "0" : String(priceRub / Math.max(visits ?? 1, 1))
        ) ?? "0"
      ).replace(",", ".")
    );
    const freezeDays = Number(
      window.prompt("Дней заморозки", "0") ?? "0"
    );
    const makeupDays = Number(
      window.prompt("Срок действия отработки, дней (0 = без отработок)", "0") ?? "0"
    );

    if (
      (packageKind !== "UNLIMITED" &&
        (!Number.isSafeInteger(visits) || Number(visits) < 1)) ||
      !Number.isSafeInteger(days) ||
      days < 1 ||
      !Number.isFinite(priceRub) ||
      priceRub < 0 ||
      !Number.isFinite(visitValueRub) ||
      visitValueRub < 0 ||
      !Number.isSafeInteger(freezeDays) ||
      freezeDays < 0 ||
      !Number.isSafeInteger(makeupDays) ||
      makeupDays < 0
    ) {
      setError("Некорректные параметры абонемента");
      return;
    }

    const serviceName = window.prompt(
      "Ограничить одной услугой? Введите точное название или оставьте пустым",
      ""
    )?.trim();
    const service = serviceName
      ? services.find(
          (item) => item.name.toLowerCase() === serviceName.toLowerCase()
        )
      : undefined;

    if (serviceName && !service) {
      setError("Услуга с таким названием не найдена");
      return;
    }

    const consumeNoShow = window.confirm(
      "Списывать посещение при no-show?"
    );

    const activationPolicy = (
      window.prompt(
        "Активация: FULL_PAYMENT, IMMEDIATE, PROPORTIONAL или GRACE_PERIOD",
        "FULL_PAYMENT"
      ) ?? "FULL_PAYMENT"
    ).trim().toUpperCase();
    if (!["FULL_PAYMENT","IMMEDIATE","PROPORTIONAL","GRACE_PERIOD"].includes(
      activationPolicy
    )) {
      setError("Неизвестная политика активации");
      return;
    }
    const gracePeriodDays =
      activationPolicy === "GRACE_PERIOD"
        ? Number(window.prompt("Льготный период, дней", "7") ?? "7")
        : 0;
    const allowedDebtRub =
      activationPolicy === "GRACE_PERIOD"
        ? Number(
            (window.prompt("Допустимый долг после grace period, ₽", "0") ?? "0")
              .replace(",", ".")
          )
        : 0;

    let entitlements:
      | Array<{
          lessonType: "GROUP" | "INDIVIDUAL";
          visitLimit: number;
          managementVisitValueMinor: string;
          priority: number;
        }>
      | undefined;
    let finalVisitLimit = visits;
    if (packageKind === "COMBO") {
      const groupVisits = Number(
        window.prompt("Групповых занятий в пакете", "8") ?? "8"
      );
      const individualVisits = Number(
        window.prompt("Индивидуальных занятий в пакете", "2") ?? "2"
      );
      if (
        !Number.isSafeInteger(groupVisits) ||
        groupVisits < 1 ||
        !Number.isSafeInteger(individualVisits) ||
        individualVisits < 1
      ) {
        setError("Некорректные квоты комбинированного пакета");
        return;
      }
      finalVisitLimit = groupVisits + individualVisits;
      entitlements = [
        {
          lessonType: "GROUP",
          visitLimit: groupVisits,
          managementVisitValueMinor: String(Math.round(visitValueRub * 100)),
          priority: 10
        },
        {
          lessonType: "INDIVIDUAL",
          visitLimit: individualVisits,
          managementVisitValueMinor: String(Math.round(visitValueRub * 100)),
          priority: 20
        }
      ];
    }

    setPending(true);
    try {
      await apiRequest("/service/package-plans", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          packageKind,
          visitLimit: finalVisitLimit,
          durationDays: days,
          priceMinor: String(Math.round(priceRub * 100)),
          managementVisitValueMinor: String(Math.round(visitValueRub * 100)),
          freezeDaysAllowed: freezeDays,
          makeupDaysValid: makeupDays,
          allowMakeup: makeupDays > 0,
          familyEligible: packageKind === "FAMILY",
          activationPolicy,
          gracePeriodDays,
          allowedDebtMinor: String(Math.round(allowedDebtRub * 100)),
          entitlements,
          applicableServiceId: service?.id,
          noShowPolicy: consumeNoShow ? "CONSUME" : "RELEASE"
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать тариф абонемента");
    } finally {
      setPending(false);
    }
  }

  async function issuePackage() {
    if (!selectedCustomer || !selectedPlan) {
      setError("Выберите клиента и тариф");
      return;
    }

    setPending(true);
    setError("");
    try {
      await apiRequest("/service/packages", {
        method: "POST",
        body: JSON.stringify({
          partyId: selectedCustomer,
          planId: selectedPlan,
          startsAt: new Date().toISOString()
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выдать абонемент");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="service-packages" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Сервис / Абонементы</p>
            <h1>Абонементы и пакеты услуг</h1>
            <p className="workspace-summary">
              Посещения, срок действия и no-show учитываются отдельно от обычной записи.
            </p>
          </div>
          <button className="secondary-button" disabled={pending} onClick={() => void createPlan()} type="button">
            + Тариф абонемента
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="metric-grid">
          <article className="metric-card">
            <span>Активных абонементов</span>
            <strong>{activePackages.length}</strong>
            <small>{plans.length} тарифов</small>
          </article>
          <article className="metric-card">
            <span>Доступно посещений</span>
            <strong>
              {activePackages.some((item) => item.available_visits === null)
                ? "∞ + " +
                  activePackages.reduce(
                    (sum, item) => sum + Number(item.available_visits ?? 0),
                    0
                  )
                : activePackages.reduce(
                    (sum, item) => sum + Number(item.available_visits ?? 0),
                    0
                  )}
            </strong>
            <small>по всем активным клиентам</small>
          </article>
          <article className="metric-card">
            <span>Заканчиваются за 7 дней</span>
            <strong>
              {
                activePackages.filter((item) => {
                  const left =
                    new Date(item.expires_at).getTime() - Date.now();
                  return left >= 0 && left <= 7 * 86400000;
                }).length
              }
            </strong>
            <small>повод для продления</small>
          </article>
        </div>

        <section className="settings-card">
          <div className="section-heading">
            <div>
              <p className="muted">Продажа / выдача</p>
              <h2>Выдать абонемент клиенту</h2>
            </div>
          </div>

          <div className="header-actions" style={{ flexWrap: "wrap" }}>
            <label>
              Клиент{" "}
              <select
                value={selectedCustomer}
                onChange={(event) => setSelectedCustomer(event.target.value)}
              >
                <option value="">Выберите клиента</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}
                    {customer.phone ? " · " + customer.phone : ""}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Тариф{" "}
              <select
                value={selectedPlan}
                onChange={(event) => setSelectedPlan(event.target.value)}
              >
                <option value="">Выберите тариф</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} · {plan.visit_limit === null ? "безлимит" : plan.visit_limit + " посещений"} ·{" "}
                    {money(plan.price_minor, plan.currency)}
                  </option>
                ))}
              </select>
            </label>

            <button disabled={pending} onClick={() => void issuePackage()} type="button">
              {pending ? "Сохраняем…" : "Выдать"}
            </button>
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Тарифы</p>
              <h2>Пакеты услуг</h2>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Тариф</th>
                  <th>Услуга</th>
                  <th>Посещений</th>
                  <th>Срок</th>
                  <th>Цена</th>
                  <th>No-show</th>
                </tr>
              </thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td>
                      <strong>{plan.name}</strong>
                      <small>{plan.package_kind}</small>
                    </td>
                    <td>{plan.applicable_service_name ?? "Любая услуга"}</td>
                    <td>{plan.visit_limit === null ? "∞" : plan.visit_limit}</td>
                    <td>{plan.duration_days} дней</td>
                    <td>{money(plan.price_minor, plan.currency)}</td>
                    <td>{plan.no_show_policy}</td>
                  </tr>
                ))}
                {!plans.length ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="table-empty">
                        <strong>Тарифов пока нет</strong>
                        <span>Создайте пакет посещений для студии, фитнеса или регулярного сервиса.</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Клиенты</p>
              <h2>Выданные абонементы</h2>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>Абонемент</th>
                  <th>Использовано</th>
                  <th>Зарезервировано</th>
                  <th>Осталось</th>
                  <th>Действует до</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                {packages.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.party_name}</strong></td>
                    <td>{item.plan_name}</td>
                    <td>{item.used_visits}</td>
                    <td>{item.reserved_visits}</td>
                    <td><strong>{item.available_visits === null ? "∞" : item.available_visits}</strong></td>
                    <td>{new Date(item.expires_at).toLocaleDateString("ru-RU")}</td>
                    <td><span className="status-pill">{item.status}</span></td>
                  </tr>
                ))}
                {!packages.length ? (
                  <tr>
                    <td colSpan={7}>
                      <div className="table-empty">
                        <strong>Абонементы клиентам ещё не выдавались</strong>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
