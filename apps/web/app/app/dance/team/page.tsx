"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Customer = {
  id: string;
  displayName: string;
};

type Resource = {
  id: string;
  name: string;
  type: string;
};

type Plan = {
  id: string;
  trainer_resource_id: string;
  trainer_name: string;
  lesson_type: string | null;
  calculation_type: string;
  fixed_minor: string;
  hourly_minor: string;
  percent_bps: number;
  per_attendee_minor: string;
  threshold_count: number;
  threshold_extra_minor: string;
  revenue_basis: string;
  priority: number;
};

type Accrual = {
  id: string;
  lesson_id: string;
  trainer_resource_id: string;
  trainer_name: string;
  lesson_type: string;
  group_name: string | null;
  starts_at: string;
  attended_count: number;
  eligible_revenue_minor: string;
  amount_minor: string;
  status: string;
  payroll_batch_id: string | null;
};

type Contract = {
  id: string;
  room_resource_id: string;
  room_name: string;
  counterparty_name: string | null;
  pricing_type: string;
  hourly_rate_minor: string;
  monthly_minor: string;
  slot_minor: string;
  minimum_billable_minutes: number;
  cancellation_charge_bps: number;
  payment_term_days: number;
  valid_from: string;
  valid_to: string | null;
};

type RoomStatement = {
  id: string;
  contract_id: string;
  room_name: string;
  counterparty_name: string | null;
  pricing_type: string;
  period_from: string;
  period_to: string;
  amount_minor: string;
  lesson_count: number;
  status: string;
  obligation_id: string | null;
  finalized_at: string | null;
};

type LegalEntity = { id: string; name: string };
type Organization = { legalEntities: LegalEntity[] };
type PayrollBatch = {
  id: string;
  period_from: string;
  period_to: string;
  status: string;
};

function money(value: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

function monthRange() {
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { from: from.toISOString(), to: to.toISOString() };
}

export default function DanceTeamPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [accruals, setAccruals] = useState<Accrual[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [roomStatements, setRoomStatements] = useState<RoomStatement[]>([]);
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [payroll, setPayroll] = useState<PayrollBatch[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const range = monthRange();
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const [
        customerRows,
        resourceRows,
        planRows,
        accrualRows,
        contractRows,
        statementRows,
        organization
      ] = await Promise.all([
          apiRequest<Resource[]>("/service/resources"),
          apiRequest<Plan[]>("/dance/compensation-plans"),
          apiRequest<Accrual[]>(
            "/dance/compensation-accruals?from=" +
              encodeURIComponent(range.from) +
              "&to=" +
              encodeURIComponent(range.to)
          ),
          apiRequest<Contract[]>("/dance/room-contracts"),
          apiRequest<RoomStatement[]>(
            "/dance/room-statements?month=" + encodeURIComponent(currentMonth)
          ),
          apiRequest<Organization>("/organization")
        ]);
      setCustomers(customerRows);
      setResources(resourceRows);
      setPlans(planRows);
      setAccruals(accrualRows);
      setContracts(contractRows);
      setRoomStatements(statementRows);
      setEntities(organization.legalEntities);

      if (organization.legalEntities[0]) {
        setPayroll(
          await apiRequest<PayrollBatch[]>(
            "/accounting/payroll/batches?legalEntityId=" +
              encodeURIComponent(organization.legalEntities[0].id)
          )
        );
      } else {
        setPayroll([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить тренеров и залы");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const trainers = resources.filter((item) => item.type === "EMPLOYEE");
  const rooms = resources.filter((item) =>
    ["ROOM", "HALL", "WORKPLACE"].includes(item.type)
  );

  const trainerTotals = useMemo(() => {
    const map = new Map<string, { name: string; amount: bigint; lessons: number; attended: number }>();
    for (const item of accruals) {
      const current = map.get(item.trainer_resource_id) ?? {
        name: item.trainer_name,
        amount: 0n,
        lessons: 0,
        attended: 0
      };
      current.amount += BigInt(item.amount_minor);
      current.lessons += 1;
      current.attended += Number(item.attended_count);
      map.set(item.trainer_resource_id, current);
    }
    return [...map.entries()];
  }, [accruals]);

  async function createPlan() {
    if (!trainers.length) return;
    const trainer = trainers[
      Number(window.prompt(
        "Тренер:\n" + trainers.map((item, i) => `${i + 1}. ${item.name}`).join("\n"),
        "1"
      )) - 1
    ];
    if (!trainer) return;

    const calculationType = (
      window.prompt("Схема: FIXED, HOURLY, PERCENT, ATTENDEE или TIERED", "FIXED") ?? "FIXED"
    ).trim().toUpperCase();
    if (!["FIXED", "HOURLY", "PERCENT", "ATTENDEE", "TIERED"].includes(calculationType)) {
      setError("Неизвестная схема");
      return;
    }
    const lessonType = (
      window.prompt(
        "Тип урока: GROUP / INDIVIDUAL / TRIAL / MASTER_CLASS или пусто = любой",
        ""
      ) ?? ""
    ).trim().toUpperCase();

    let fixedMinor = "0";
    let hourlyMinor = "0";
    let percentBps = 0;
    let perAttendeeMinor = "0";
    let thresholdCount = 0;
    let thresholdExtraMinor = "0";

    if (calculationType === "FIXED") {
      fixedMinor = String(Math.round(Number((window.prompt("Фикс за урок, ₽", "1500") ?? "0").replace(",", ".")) * 100));
    } else if (calculationType === "HOURLY") {
      hourlyMinor = String(Math.round(Number((window.prompt("Ставка ₽/час", "1500") ?? "0").replace(",", ".")) * 100));
    } else if (calculationType === "PERCENT") {
      percentBps = Math.round(Number((window.prompt("Процент", "40") ?? "0").replace(",", ".")) * 100);
    } else if (calculationType === "ATTENDEE") {
      fixedMinor = String(Math.round(Number((window.prompt("База за урок, ₽", "800") ?? "0").replace(",", ".")) * 100));
      perAttendeeMinor = String(Math.round(Number((window.prompt("За каждого пришедшего, ₽", "100") ?? "0").replace(",", ".")) * 100));
    } else {
      fixedMinor = String(Math.round(Number((window.prompt("База, ₽", "1200") ?? "0").replace(",", ".")) * 100));
      thresholdCount = Number(window.prompt("Порог учеников", "8") ?? "8");
      thresholdExtraMinor = String(Math.round(Number((window.prompt("За каждого сверх порога, ₽", "100") ?? "0").replace(",", ".")) * 100));
    }

    const revenueBasis =
      calculationType === "PERCENT"
        ? ((window.prompt("База процента: EARNED, PAID, BILLED или LIST", "EARNED") ?? "EARNED").trim().toUpperCase())
        : "EARNED";

    try {
      await apiRequest("/dance/compensation-plans", {
        method: "POST",
        body: JSON.stringify({
          trainerResourceId: trainer.id,
          lessonType: lessonType || undefined,
          calculationType,
          fixedMinor,
          hourlyMinor,
          percentBps,
          perAttendeeMinor,
          thresholdCount,
          thresholdExtraMinor,
          revenueBasis
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать правило зарплаты");
    }
  }

  async function createRoomContract() {
    if (!rooms.length) {
      setError("Сначала создайте ресурс-зал");
      return;
    }
    const room = rooms[
      Number(window.prompt(
        "Зал:\n" + rooms.map((item, i) => `${i + 1}. ${item.name}`).join("\n"),
        "1"
      )) - 1
    ];
    if (!room) return;

    let counterpartyPartyId: string | undefined;
    if (
      customers.length &&
      window.confirm(
        "Указать арендодателя? Если да, по итогам месяца будет создана кредиторка."
      )
    ) {
      const landlord = customers[
        Number(
          window.prompt(
            "Арендодатель:\n" +
              customers
                .slice(0, 80)
                .map((item, i) => `${i + 1}. ${item.displayName}`)
                .join("\n"),
            "1"
          )
        ) - 1
      ];
      counterpartyPartyId = landlord?.id;
    }
    const pricingType = (
      window.prompt("Тип аренды: HOURLY, FIXED_MONTHLY или FIXED_SLOT", "HOURLY") ?? "HOURLY"
    ).trim().toUpperCase();
    const amountRub = Number(
      (window.prompt(
        pricingType === "FIXED_MONTHLY" ? "Аренда в месяц, ₽" : pricingType === "FIXED_SLOT" ? "Стоимость слота, ₽" : "Стоимость часа, ₽",
        "1000"
      ) ?? "0").replace(",", ".")
    );
    const minimum = pricingType === "HOURLY"
      ? Number(window.prompt("Минимально оплачиваемых минут", "60") ?? "60")
      : 0;
    const cancelPercent = Number(
      (window.prompt("Штраф при отмене, %", "0") ?? "0").replace(",", ".")
    );
    const paymentTermDays = Number(
      window.prompt("Срок оплаты аренды после конца месяца, дней", "5") ?? "5"
    );

    try {
      await apiRequest("/dance/room-contracts", {
        method: "POST",
        body: JSON.stringify({
          roomResourceId: room.id,
          counterpartyPartyId,
          pricingType,
          hourlyRateMinor: pricingType === "HOURLY" ? String(Math.round(amountRub * 100)) : "0",
          monthlyMinor: pricingType === "FIXED_MONTHLY" ? String(Math.round(amountRub * 100)) : "0",
          slotMinor: pricingType === "FIXED_SLOT" ? String(Math.round(amountRub * 100)) : "0",
          minimumBillableMinutes: minimum,
          cancellationChargeBps: Math.round(cancelPercent * 100),
          paymentTermDays
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать договор аренды");
    }
  }

  async function finalizeRoomMonth() {
    const month = new Date().toISOString().slice(0, 7);
    if (
      !window.confirm(
        "Закрыть аренду залов за " +
          month +
          "? После финализации будут созданы кредиторские обязательства."
      )
    ) {
      return;
    }

    setPending(true);
    try {
      const result = await apiRequest<{
        month: string;
        statements: Array<{
          amountMinor?: string;
          amount_minor?: string;
          obligationId?: string | null;
          obligation_id?: string | null;
        }>;
      }>("/dance/room-statements/finalize", {
        method: "POST",
        body: JSON.stringify({ month })
      });
      const total = result.statements.reduce(
        (sum, item) =>
          sum +
          BigInt(
            item.amountMinor ??
              item.amount_minor ??
              "0"
          ),
        0n
      );
      window.alert(
        "Аренда закрыта: " +
          result.statements.length +
          " договоров, " +
          money(total.toString())
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось закрыть аренду месяца"
      );
    } finally {
      setPending(false);
    }
  }

  async function approveMonth() {
    const range = monthRange();
    setPending(true);
    try {
      const result = await apiRequest<{ approved: number }>("/dance/compensation/approve", {
        method: "POST",
        body: JSON.stringify(range)
      });
      window.alert("Утверждено начислений: " + result.approved);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось утвердить начисления");
    } finally {
      setPending(false);
    }
  }

  async function exportPayroll() {
    if (!entities[0]) {
      setError("Не настроено юридическое лицо");
      return;
    }
    const range = monthRange();
    let batch = payroll.find((item) => item.status === "DRAFT");
    setPending(true);
    try {
      if (!batch) {
        batch = await apiRequest<PayrollBatch>("/accounting/payroll/batches", {
          method: "POST",
          body: JSON.stringify({
            legalEntityId: entities[0].id,
            periodFrom: range.from.slice(0, 10),
            periodTo: new Date(new Date(range.to).getTime() - 86400000).toISOString().slice(0, 10)
          })
        });
      }
      const result = await apiRequest<{ trainers: number; accruals: number }>(
        "/dance/compensation/export-payroll",
        {
          method: "POST",
          body: JSON.stringify({
            batchId: batch.id,
            from: range.from,
            to: range.to
          })
        }
      );
      window.alert(`Передано в payroll: ${result.accruals} начислений, ${result.trainers} тренеров`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось передать начисления в payroll");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="dance-team" />
      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Студия / Тренеры и залы</p>
            <h1>Зарплата и стоимость ресурсов</h1>
            <p className="workspace-summary">
              Формулы оплаты тренеров, аренда залов и неизменяемые начисления по завершённым урокам.
            </p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={() => void createPlan()} type="button">+ Правило зарплаты</button>
            <button className="secondary-button" onClick={() => void createRoomContract()} type="button">+ Аренда зала</button>
            <button className="secondary-button" disabled={pending} onClick={() => void finalizeRoomMonth()} type="button">Закрыть аренду месяца</button>
            <button disabled={pending} onClick={() => void approveMonth()} type="button">Утвердить месяц</button>
            <button disabled={pending} onClick={() => void exportPayroll()} type="button">В payroll</button>
          </div>
        </header>

        {error ? <div className="inline-error"><strong>Тренеры и залы</strong><span>{error}</span></div> : null}

        <div className="owner-kpi-grid">
          {trainerTotals.map(([id, total]) => (
            <article className="owner-kpi" key={id}>
              <span>{total.name}</span>
              <strong>{money(total.amount.toString())}</strong>
              <small>{total.lessons} уроков · {total.attended} посещений</small>
            </article>
          ))}
          {!trainerTotals.length ? (
            <article className="owner-kpi">
              <span>Начисления месяца</span>
              <strong>0 ₽</strong>
              <small>Появятся после закрытия уроков</small>
            </article>
          ) : null}
        </div>

        <section className="section-block">
          <div className="section-heading"><div><p className="muted">Правила</p><h2>Оплата тренеров</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Тренер</th><th>Урок</th><th>Схема</th><th>Условия</th><th>База</th></tr></thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td><strong>{plan.trainer_name}</strong></td>
                    <td>{plan.lesson_type ?? "Любой"}</td>
                    <td>{plan.calculation_type}</td>
                    <td>
                      {plan.calculation_type === "FIXED" ? money(plan.fixed_minor) : null}
                      {plan.calculation_type === "HOURLY" ? money(plan.hourly_minor) + "/ч" : null}
                      {plan.calculation_type === "PERCENT" ? plan.percent_bps / 100 + "%" : null}
                      {plan.calculation_type === "ATTENDEE" ? money(plan.fixed_minor) + " + " + money(plan.per_attendee_minor) + "/уч." : null}
                      {plan.calculation_type === "TIERED" ? money(plan.fixed_minor) + " + " + money(plan.threshold_extra_minor) + " после " + plan.threshold_count : null}
                    </td>
                    <td>{plan.revenue_basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading"><div><p className="muted">Факт</p><h2>Начисления текущего месяца</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Дата</th><th>Тренер</th><th>Урок</th><th>Пришло</th><th>База</th><th>Начислено</th><th>Статус</th></tr></thead>
              <tbody>
                {accruals.map((item) => (
                  <tr key={item.id}>
                    <td>{new Date(item.starts_at).toLocaleDateString("ru-RU")}</td>
                    <td><strong>{item.trainer_name}</strong></td>
                    <td>{item.group_name ?? item.lesson_type}</td>
                    <td>{item.attended_count}</td>
                    <td>{money(item.eligible_revenue_minor)}</td>
                    <td><strong>{money(item.amount_minor)}</strong></td>
                    <td><span className="status-pill">{item.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading"><div><p className="muted">Залы</p><h2>Договоры и себестоимость</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Зал</th><th>Тип</th><th>Ставка</th><th>Минимум</th><th>Отмена</th><th>Оплата</th><th>Период</th></tr></thead>
              <tbody>
                {contracts.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.room_name}</strong><small>{item.counterparty_name ?? "собственный / без контрагента"}</small></td>
                    <td>{item.pricing_type}</td>
                    <td>
                      {item.pricing_type === "HOURLY" ? money(item.hourly_rate_minor) + "/ч" : item.pricing_type === "FIXED_MONTHLY" ? money(item.monthly_minor) + "/мес" : money(item.slot_minor) + "/слот"}
                    </td>
                    <td>{item.minimum_billable_minutes} мин</td>
                    <td>{item.cancellation_charge_bps / 100}%</td>
                    <td>{item.payment_term_days} дн.</td>
                    <td>{item.valid_from}{item.valid_to ? " — " + item.valid_to : " — ∞"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Finance</p>
              <h2>Аренда текущего месяца</h2>
            </div>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Зал</th>
                  <th>Тип</th>
                  <th>Уроков</th>
                  <th>Сумма</th>
                  <th>Статус</th>
                  <th>Кредиторка</th>
                </tr>
              </thead>
              <tbody>
                {roomStatements.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.room_name}</strong>
                      <small>{item.counterparty_name ?? "Внутренняя себестоимость"}</small>
                    </td>
                    <td>{item.pricing_type}</td>
                    <td>{item.lesson_count}</td>
                    <td><strong>{money(item.amount_minor)}</strong></td>
                    <td><span className="status-pill">{item.status}</span></td>
                    <td>{item.obligation_id ? "Создана" : "—"}</td>
                  </tr>
                ))}
                {!roomStatements.length ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="table-empty">
                        <strong>Месяц ещё не закрыт</strong>
                        <span>После закрытия здесь появятся statements и кредиторка арендодателю.</span>
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
