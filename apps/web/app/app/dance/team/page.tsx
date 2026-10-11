"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { DanceWorkspaceNav } from "../../../../components/dance-workspace-nav";
import { StudioModal } from "../../../../components/studio-modal";
import { apiRequest } from "../../../../lib/api";

type Customer = {
  id: string;
  displayName: string;
};

type Resource = {
  id: string;
  name: string;
  type: string;
  capacity: number;
};

type Zone = {
  id: string;
  resource_id: string;
  name: string;
  capacity_units: number;
};

type Service = {
  id: string;
  name: string;
};

type Plan = {
  id: string;
  trainer_resource_id: string;
  trainer_name: string;
  lesson_type: string | null;
  service_id: string | null;
  service_name: string | null;
  calculation_type: string;
  fixed_minor: string;
  hourly_minor: string;
  percent_bps: number;
  per_attendee_minor: string;
  threshold_count: number;
  threshold_extra_minor: string;
  revenue_basis: string;
  priority: number;
  minimum_guarantee_minor: string;
  components: Array<{
    id: string;
    componentType: string;
    amountMinor: string;
    percentBps: number;
    thresholdCount: number;
    revenueBasis: string;
  }>;
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
  capacity_units: number;
  zone_id: string | null;
  zone_name: string | null;
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

type TrainerStatement = {
  id: string;
  trainer_resource_id: string;
  trainer_name: string;
  period_from: string;
  period_to: string;
  lesson_accrual_minor: string;
  base_minor: string;
  guarantee_adjustment_minor: string;
  total_minor: string;
  currency: string;
  status: string;
  payroll_batch_id: string | null;
};

function money(value: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

function compensationLabel(value: string) {
  return ({
    FIXED: "За занятие",
    HOURLY: "За часы",
    PERCENT: "Процент",
    ATTENDEE: "База + ученик",
    TIERED: "По порогу посещаемости",
    COMPOSITE: "Составная схема"
  } as Record<string, string>)[value] ?? value;
}

function revenueBasisLabel(value: string) {
  return ({
    LIST: "По прайсу",
    BILLED: "По начислениям",
    PAID: "По фактической оплате",
    EARNED: "По оказанным услугам"
  } as Record<string, string>)[value] ?? value;
}

function rentLabel(value: string) {
  return ({
    HOURLY: "Почасовая",
    FIXED_MONTHLY: "Фикс в месяц",
    FIXED_SLOT: "Фикс за слот"
  } as Record<string, string>)[value] ?? value;
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
  const [services, setServices] = useState<Service[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [accruals, setAccruals] = useState<Accrual[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [roomStatements, setRoomStatements] = useState<RoomStatement[]>([]);
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [payroll, setPayroll] = useState<PayrollBatch[]>([]);
  const [trainerStatements, setTrainerStatements] = useState<TrainerStatement[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [zones, setZones] = useState<Record<string, Zone[]>>({});
  const [roomModal, setRoomModal] = useState(false);
  const [roomId, setRoomId] = useState("");
  const [roomZoneId, setRoomZoneId] = useState("");
  const [roomCapacityUnits, setRoomCapacityUnits] = useState("1");
  const [roomLandlordId, setRoomLandlordId] = useState("");
  const [roomPricingType, setRoomPricingType] = useState<
    "HOURLY" | "FIXED_MONTHLY" | "FIXED_SLOT"
  >("HOURLY");
  const [roomAmountRub, setRoomAmountRub] = useState("1000");
  const [roomMinimumMinutes, setRoomMinimumMinutes] = useState("60");
  const [roomCancelPercent, setRoomCancelPercent] = useState("0");
  const [roomPaymentTermDays, setRoomPaymentTermDays] = useState("5");
  const [planModal, setPlanModal] = useState(false);
  const [planTrainerId, setPlanTrainerId] = useState("");
  const [planScheme, setPlanScheme] = useState<
    "FIXED" | "HOURLY" | "PERCENT" | "ATTENDEE" | "COMPOSITE"
  >("FIXED");
  const [planLessonType, setPlanLessonType] = useState("");
  const [planServiceId, setPlanServiceId] = useState("");
  const [planBaseRub, setPlanBaseRub] = useState("1500");
  const [planPercent, setPlanPercent] = useState("40");
  const [planPerAttendeeRub, setPlanPerAttendeeRub] = useState("100");
  const [planGuaranteeRub, setPlanGuaranteeRub] = useState("0");
  const [planRevenueBasis, setPlanRevenueBasis] = useState<
    "EARNED" | "PAID" | "BILLED" | "LIST"
  >("EARNED");
  const [planBasePeriod, setPlanBasePeriod] = useState<"MONTH" | "DAY">("MONTH");
  const [planVariableType, setPlanVariableType] = useState<
    "PERCENT" | "HOURLY" | "PER_ATTENDEE" | "FIXED_PER_LESSON"
  >("PERCENT");
  const [planVariableRub, setPlanVariableRub] = useState("500");

  const load = useCallback(async () => {
    setError("");
    const range = monthRange();
    try {
      const currentMonth = new Date().toISOString().slice(0, 7);
      const [
        customerRows,
        resourceRows,
        serviceRows,
        planRows,
        accrualRows,
        trainerStatementRows,
        contractRows,
        statementRows,
        organization
      ] = await Promise.all([
          apiRequest<Customer[]>("/crm/customers"),
          apiRequest<Resource[]>("/service/resources"),
          apiRequest<Service[]>("/service/catalog"),
          apiRequest<Plan[]>("/dance/compensation-plans"),
          apiRequest<Accrual[]>(
            "/dance/compensation-accruals?from=" +
              encodeURIComponent(range.from) +
              "&to=" +
              encodeURIComponent(range.to)
          ),
          apiRequest<TrainerStatement[]>(
            "/dance/payroll-statements?from=" +
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
      setServices(serviceRows);
      const roomRows = resourceRows.filter((item) =>
        ["ROOM", "HALL", "WORKPLACE"].includes(item.type)
      );
      const zoneRows = await Promise.all(
        roomRows.map(async (room) => [
          room.id,
          await apiRequest<Zone[]>("/service/resources/" + room.id + "/zones")
        ] as const)
      );
      setZones(Object.fromEntries(zoneRows));
      setPlans(planRows);
      setAccruals(accrualRows);
      setTrainerStatements(trainerStatementRows);
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

  function openPlanModal() {
    setPlanTrainerId((current) => current || trainers[0]?.id || "");
    setPlanServiceId("");
    setPlanLessonType("");
    setPlanRevenueBasis("EARNED");
    setPlanBasePeriod("MONTH");
    setPlanVariableType("PERCENT");
    setPlanVariableRub("500");
    setPlanModal(true);
  }

  async function createPlan() {
    if (!planTrainerId) {
      setError("Выберите тренера");
      return;
    }

    const baseRub = Number(planBaseRub.replace(",", "."));
    const percent = Number(planPercent.replace(",", "."));
    const perAttendeeRub = Number(planPerAttendeeRub.replace(",", "."));
    const guaranteeRub = Number(planGuaranteeRub.replace(",", "."));
    const variableRub = Number(planVariableRub.replace(",", "."));
    if (
      !Number.isFinite(baseRub) || baseRub < 0 ||
      !Number.isFinite(percent) || percent < 0 || percent > 100 ||
      !Number.isFinite(perAttendeeRub) || perAttendeeRub < 0 ||
      !Number.isFinite(guaranteeRub) || guaranteeRub < 0 ||
      !Number.isFinite(variableRub) || variableRub < 0
    ) {
      setError("Проверьте денежные условия правила");
      return;
    }

    const baseMinor = String(Math.round(baseRub * 100));
    const components =
      planScheme === "COMPOSITE"
        ? [
            {
              componentType:
                planBasePeriod === "DAY" ? "DAILY_BASE" : "MONTHLY_BASE",
              amountMinor: baseMinor,
              priority: 100
            },
            {
              componentType: planVariableType,
              amountMinor:
                planVariableType === "PERCENT"
                  ? "0"
                  : String(Math.round(variableRub * 100)),
              percentBps:
                planVariableType === "PERCENT"
                  ? Math.round(percent * 100)
                  : 0,
              revenueBasis: planRevenueBasis,
              priority: 110
            }
          ]
        : undefined;

    setPending(true);
    setError("");
    try {
      await apiRequest("/dance/compensation-plans", {
        method: "POST",
        body: JSON.stringify({
          trainerResourceId: planTrainerId,
          serviceId: planServiceId || undefined,
          lessonType: planLessonType || undefined,
          calculationType: planScheme,
          fixedMinor:
            planScheme === "FIXED" || planScheme === "ATTENDEE"
              ? baseMinor
              : "0",
          hourlyMinor: planScheme === "HOURLY" ? baseMinor : "0",
          percentBps:
            planScheme === "PERCENT" ? Math.round(percent * 100) : 0,
          perAttendeeMinor:
            planScheme === "ATTENDEE"
              ? String(Math.round(perAttendeeRub * 100))
              : "0",
          revenueBasis: planRevenueBasis,
          minimumGuaranteeMinor: String(Math.round(guaranteeRub * 100)),
          guaranteePeriod: "MONTH",
          components
        })
      });
      setPlanModal(false);
      setNotice("Правило зарплаты сохранено.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить правило зарплаты"
      );
    } finally {
      setPending(false);
    }
  }

  function openRoomModal() {
    const firstRoom = rooms[0];
    setRoomId((current) => current || firstRoom?.id || "");
    setRoomZoneId("");
    setRoomCapacityUnits("1");
    setRoomLandlordId("");
    setRoomPricingType("HOURLY");
    setRoomAmountRub("1000");
    setRoomMinimumMinutes("60");
    setRoomCancelPercent("0");
    setRoomPaymentTermDays("5");
    setRoomModal(true);
  }

  async function createRoomContract() {
    if (!roomId) {
      setError("Выберите зал");
      return;
    }
    const amountRub = Number(roomAmountRub.replace(",", "."));
    const capacityUnits = Number(roomCapacityUnits);
    const minimum = Number(roomMinimumMinutes);
    const cancelPercent = Number(roomCancelPercent.replace(",", "."));
    const paymentTermDays = Number(roomPaymentTermDays);

    if (
      !Number.isFinite(amountRub) || amountRub < 0 ||
      !Number.isSafeInteger(capacityUnits) || capacityUnits < 1 ||
      !Number.isSafeInteger(minimum) || minimum < 0 || minimum > 1440 ||
      !Number.isFinite(cancelPercent) || cancelPercent < 0 || cancelPercent > 100 ||
      !Number.isSafeInteger(paymentTermDays) || paymentTermDays < 0
    ) {
      setError("Проверьте условия аренды");
      return;
    }

    setPending(true);
    setError("");
    try {
      await apiRequest("/dance/room-contracts", {
        method: "POST",
        body: JSON.stringify({
          roomResourceId: roomId,
          zoneId: roomZoneId || undefined,
          capacityUnits,
          counterpartyPartyId: roomLandlordId || undefined,
          pricingType: roomPricingType,
          hourlyRateMinor:
            roomPricingType === "HOURLY"
              ? String(Math.round(amountRub * 100))
              : "0",
          monthlyMinor:
            roomPricingType === "FIXED_MONTHLY"
              ? String(Math.round(amountRub * 100))
              : "0",
          slotMinor:
            roomPricingType === "FIXED_SLOT"
              ? String(Math.round(amountRub * 100))
              : "0",
          minimumBillableMinutes:
            roomPricingType === "HOURLY" ? minimum : 0,
          cancellationChargeBps: Math.round(cancelPercent * 100),
          paymentTermDays
        })
      });
      setRoomModal(false);
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать договор аренды"
      );
    } finally {
      setPending(false);
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
      const result = await apiRequest<{
        approved: number;
        statements: TrainerStatement[];
      }>("/dance/compensation/approve", {
        method: "POST",
        body: JSON.stringify(range)
      });
      setNotice(
        "Месяц рассчитан: " +
          result.statements.length +
          " ведомостей, новых начислений утверждено " +
          result.approved +
          "."
      );
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
      const result = await apiRequest<{ trainers: number; accruals: number; statements: number }>(
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
      setNotice(
        `В payroll передано: ${result.statements} ведомостей, ${result.trainers} тренеров.`
      );
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
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero compact">
          <div>
            <span className="studio-eyebrow">Команда и себестоимость</span>
            <h1>Зарплата и залы</h1>
            <p>
              Правила оплаты тренеров, итоговые ведомости, payroll и аренда
              пространства собраны в одном контуре.
            </p>
          </div>
          <div className="studio-hero-actions">
            <button className="secondary-button" onClick={openPlanModal} type="button">+ Правило зарплаты</button>
            <button className="secondary-button" onClick={openRoomModal} type="button">+ Аренда зала</button>
            <button className="secondary-button" disabled={pending} onClick={() => void finalizeRoomMonth()} type="button">Закрыть аренду месяца</button>
            <button disabled={pending} onClick={() => void approveMonth()} type="button">Утвердить месяц</button>
            <button disabled={pending} onClick={() => void exportPayroll()} type="button">В payroll</button>
          </div>
        </header>

        <DanceWorkspaceNav active="team" />

        {error ? <div className="studio-message error"><strong>Тренеры и залы</strong><span>{error}</span></div> : null}
        {notice ? <div className="studio-message success"><strong>Готово</strong><span>{notice}</span></div> : null}

        <div className="owner-kpi-grid studio-kpi-grid">
          {trainerTotals.map(([id, total]) => (
            <article className="owner-kpi studio-kpi" key={id}>
              <span>{total.name}</span>
              <strong>{money(total.amount.toString())}</strong>
              <small>{total.lessons} уроков · {total.attended} посещений</small>
            </article>
          ))}
          {!trainerTotals.length ? (
            <article className="owner-kpi studio-kpi">
              <span>Начисления месяца</span>
              <strong>0 ₽</strong>
              <small>Появятся после закрытия уроков</small>
            </article>
          ) : null}
        </div>

        <section className="section-block studio-section">
          <div className="section-heading"><div><p className="muted">Правила</p><h2>Оплата тренеров</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Тренер</th><th>Для чего</th><th>Схема</th><th>Условия</th><th>База</th></tr></thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td><strong>{plan.trainer_name}</strong></td>
                    <td>
                      {plan.service_name ?? "Любая услуга"}
                      <small>{plan.lesson_type ?? "любой формат"}</small>
                    </td>
                    <td>{compensationLabel(plan.calculation_type)}</td>
                    <td>
                      {plan.calculation_type === "FIXED" ? money(plan.fixed_minor) : null}
                      {plan.calculation_type === "HOURLY" ? money(plan.hourly_minor) + "/ч" : null}
                      {plan.calculation_type === "PERCENT" ? plan.percent_bps / 100 + "%" : null}
                      {plan.calculation_type === "ATTENDEE" ? money(plan.fixed_minor) + " + " + money(plan.per_attendee_minor) + "/уч." : null}
                      {plan.calculation_type === "TIERED" ? money(plan.fixed_minor) + " + " + money(plan.threshold_extra_minor) + " после " + plan.threshold_count : null}
                      {plan.calculation_type === "COMPOSITE"
                        ? plan.components.map((component) =>
                            component.componentType === "PERCENT"
                              ? component.percentBps / 100 + "%"
                              : component.componentType === "MONTHLY_BASE"
                                ? money(component.amountMinor) + "/мес"
                                : component.componentType === "DAILY_BASE"
                                  ? money(component.amountMinor) + "/день"
                                  : money(component.amountMinor) + " · " + component.componentType
                          ).join(" + ")
                        : null}
                      {BigInt(plan.minimum_guarantee_minor ?? "0") > 0n
                        ? " · гарантия " + money(plan.minimum_guarantee_minor)
                        : ""}
                    </td>
                    <td>{revenueBasisLabel(plan.revenue_basis)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block studio-section">
          <div className="section-heading">
            <div>
              <p className="muted">Итог месяца</p>
              <h2>Ведомости тренеров</h2>
            </div>
            <span className="studio-helper">
              Оклад и гарантия добавляются здесь, а не в каждый урок.
            </span>
          </div>
          <div className="trainer-statement-grid">
            {trainerStatements.map((statement) => (
              <article key={statement.id}>
                <header>
                  <div>
                    <span>Тренер</span>
                    <h3>{statement.trainer_name}</h3>
                  </div>
                  <span className="status-pill">{statement.status}</span>
                </header>
                <strong>{money(statement.total_minor)}</strong>
                <div>
                  <span>За занятия <b>{money(statement.lesson_accrual_minor)}</b></span>
                  <span>База <b>{money(statement.base_minor)}</b></span>
                  <span>Гарантия <b>{money(statement.guarantee_adjustment_minor)}</b></span>
                </div>
              </article>
            ))}
            {!trainerStatements.length ? (
              <div className="studio-empty">
                <span>₽</span>
                <strong>Месяц ещё не утверждён</strong>
                <p>Закройте занятия и нажмите «Утвердить месяц». Система соберёт итоговую зарплату автоматически.</p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="section-block studio-section">
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

        <section className="section-block studio-section">
          <div className="section-heading"><div><p className="muted">Залы</p><h2>Договоры и себестоимость</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Зал</th><th>Тип</th><th>Ставка</th><th>Минимум</th><th>Отмена</th><th>Оплата</th><th>Зона / доля</th><th>Период</th></tr></thead>
              <tbody>
                {contracts.map((item) => (
                  <tr key={item.id}>
                    <td><strong>{item.room_name}</strong><small>{item.counterparty_name ?? "собственный / без контрагента"}</small></td>
                    <td>{rentLabel(item.pricing_type)}</td>
                    <td>
                      {item.pricing_type === "HOURLY" ? money(item.hourly_rate_minor) + "/ч" : item.pricing_type === "FIXED_MONTHLY" ? money(item.monthly_minor) + "/мес" : money(item.slot_minor) + "/слот"}
                    </td>
                    <td>{item.minimum_billable_minutes} мин</td>
                    <td>{item.cancellation_charge_bps / 100}%</td>
                    <td>{item.payment_term_days} дн.</td>
                    <td>
                      {item.zone_name ? item.zone_name + " · " : ""}
                      {item.capacity_units} ед.
                    </td>
                    <td>{item.valid_from}{item.valid_to ? " — " + item.valid_to : " — ∞"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block studio-section">
          <div className="section-heading">
            <div>
              <p className="muted">Финансы</p>
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
                    <td>{rentLabel(item.pricing_type)}</td>
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
                        <span>После закрытия появится итог аренды и сумма к оплате арендодателю.</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
        {roomModal ? (
          <StudioModal
            eyebrow="Аренда пространства"
            title="Условия аренды зала"
            description="Можно арендовать весь зал, конкретную зону или только часть вместимости. Остаток останется доступен для других занятий и арендаторов."
            onClose={() => setRoomModal(false)}
            footer={
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setRoomModal(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void createRoomContract()}
                >
                  {pending ? "Сохраняем…" : "Сохранить договор"}
                </button>
              </>
            }
          >
            <div className="studio-form-section">
              <header>
                <strong>Что арендуем</strong>
                <span>Выберите зал, зону и сколько единиц вместимости занимает договор.</span>
              </header>
              <div className="studio-form-grid">
                <label>
                  <span>Зал</span>
                  <select
                    value={roomId}
                    onChange={(event) => {
                      setRoomId(event.target.value);
                      setRoomZoneId("");
                    }}
                  >
                    <option value="">Выберите зал</option>
                    {rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name} · {room.capacity} ед.
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Зона</span>
                  <select
                    value={roomZoneId}
                    onChange={(event) => setRoomZoneId(event.target.value)}
                  >
                    <option value="">Весь ресурс / без зоны</option>
                    {(zones[roomId] ?? []).map((zone) => (
                      <option key={zone.id} value={zone.id}>
                        {zone.name} · {zone.capacity_units} ед.
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="studio-form-grid">
                <label>
                  <span>Занимаемая вместимость</span>
                  <input
                    type="number"
                    min="1"
                    value={roomCapacityUnits}
                    onChange={(event) => setRoomCapacityUnits(event.target.value)}
                  />
                  <small>Например, 40 из 100 единиц большого зала.</small>
                </label>
                <label>
                  <span>Арендодатель</span>
                  <select
                    value={roomLandlordId}
                    onChange={(event) => setRoomLandlordId(event.target.value)}
                  >
                    <option value="">Без контрагента</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="studio-form-section">
              <header>
                <strong>Как считать аренду</strong>
                <span>Ставка попадёт в себестоимость занятий и P&L студии.</span>
              </header>
              <div className="studio-choice-grid">
                {[
                  ["HOURLY", "За час", "Фактическое время использования"],
                  ["FIXED_MONTHLY", "За месяц", "Фиксированная месячная аренда"],
                  ["FIXED_SLOT", "За слот", "Фикс за каждое занятие / слот"]
                ].map(([value,label,hint]) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      "studio-choice " +
                      (roomPricingType === value ? "active" : "")
                    }
                    onClick={() =>
                      setRoomPricingType(
                        value as "HOURLY" | "FIXED_MONTHLY" | "FIXED_SLOT"
                      )
                    }
                  >
                    <strong>{label}</strong>
                    <span>{hint}</span>
                  </button>
                ))}
              </div>
              <div className="studio-form-grid">
                <label>
                  <span>
                    {roomPricingType === "HOURLY"
                      ? "Стоимость часа, ₽"
                      : roomPricingType === "FIXED_MONTHLY"
                        ? "Стоимость месяца, ₽"
                        : "Стоимость слота, ₽"}
                  </span>
                  <input
                    inputMode="decimal"
                    value={roomAmountRub}
                    onChange={(event) => setRoomAmountRub(event.target.value)}
                  />
                </label>
                {roomPricingType === "HOURLY" ? (
                  <label>
                    <span>Минимально оплачиваемых минут</span>
                    <input
                      type="number"
                      min="0"
                      max="1440"
                      value={roomMinimumMinutes}
                      onChange={(event) =>
                        setRoomMinimumMinutes(event.target.value)
                      }
                    />
                  </label>
                ) : (
                  <label>
                    <span>Срок оплаты после месяца, дней</span>
                    <input
                      type="number"
                      min="0"
                      value={roomPaymentTermDays}
                      onChange={(event) =>
                        setRoomPaymentTermDays(event.target.value)
                      }
                    />
                  </label>
                )}
              </div>
              <div className="studio-form-grid">
                <label>
                  <span>Штраф при отмене, %</span>
                  <input
                    inputMode="decimal"
                    value={roomCancelPercent}
                    onChange={(event) =>
                      setRoomCancelPercent(event.target.value)
                    }
                  />
                </label>
                {roomPricingType === "HOURLY" ? (
                  <label>
                    <span>Срок оплаты после месяца, дней</span>
                    <input
                      type="number"
                      min="0"
                      value={roomPaymentTermDays}
                      onChange={(event) =>
                        setRoomPaymentTermDays(event.target.value)
                      }
                    />
                  </label>
                ) : null}
              </div>
            </div>
          </StudioModal>
        ) : null}

        {planModal ? (
          <StudioModal
            eyebrow="Зарплата тренера"
            title="Новое правило начисления"
            description="Настройте понятную схему. CoreBiz сам применит её к подходящим занятиям и сохранит расчёт в закрытом уроке."
            onClose={() => setPlanModal(false)}
            footer={
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setPlanModal(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void createPlan()}
                >
                  {pending ? "Сохраняем…" : "Сохранить правило"}
                </button>
              </>
            }
          >
            <div className="studio-form-section">
              <header>
                <strong>Кому и когда действует</strong>
                <span>Можно ограничить правило конкретным типом занятия.</span>
              </header>
              <div className="studio-form-grid">
                <label>
                  <span>Услуга</span>
                  <select
                    value={planServiceId}
                    onChange={(event) => setPlanServiceId(event.target.value)}
                  >
                    <option value="">Все услуги</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>{service.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Тренер</span>
                  <select
                    value={planTrainerId}
                    onChange={(event) => setPlanTrainerId(event.target.value)}
                  >
                    <option value="">Выберите тренера</option>
                    {trainers.map((trainer) => (
                      <option key={trainer.id} value={trainer.id}>
                        {trainer.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Тип занятия</span>
                  <select
                    value={planLessonType}
                    onChange={(event) => setPlanLessonType(event.target.value)}
                  >
                    <option value="">Все занятия</option>
                    <option value="GROUP">Групповые</option>
                    <option value="INDIVIDUAL">Индивидуальные</option>
                    <option value="TRIAL">Пробные</option>
                    <option value="MASTER_CLASS">Мастер-классы</option>
                    <option value="SELF_PRACTICE">Самостоятельная практика</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="studio-form-section">
              <header>
                <strong>Как считать зарплату</strong>
                <span>Выберите привычную бизнес-схему, без технических кодов.</span>
              </header>
              <div className="studio-choice-grid">
                {[
                  ["FIXED", "За занятие", "Фиксированная сумма за проведённый урок"],
                  ["HOURLY", "За часы", "Ставка зависит от длительности занятия"],
                  ["PERCENT", "Процент", "Доля от реализации занятия"],
                  ["ATTENDEE", "База + ученик", "Фикс плюс доплата за пришедшего"],
                  ["COMPOSITE", "Оклад + процент", "Месячная база и процент от реализации"]
                ].map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      "studio-choice " + (planScheme === value ? "active" : "")
                    }
                    onClick={() => setPlanScheme(value as typeof planScheme)}
                  >
                    <strong>{label}</strong>
                    <span>{hint}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="studio-divider" />

            {(planScheme === "PERCENT" || planScheme === "COMPOSITE") ? (
              <label>
                <span>База для процента</span>
                <select
                  value={planRevenueBasis}
                  onChange={(event) =>
                    setPlanRevenueBasis(event.target.value as typeof planRevenueBasis)
                  }
                >
                  <option value="EARNED">Оказанные услуги</option>
                  <option value="PAID">Фактически оплачено</option>
                  <option value="BILLED">Начислено клиентам</option>
                  <option value="LIST">Цена по прайсу</option>
                </select>
              </label>
            ) : null}

            {planScheme === "COMPOSITE" ? (
              <div className="studio-form-section">
                <header>
                  <strong>Составная схема</strong>
                  <span>База начисляется один раз за месяц или рабочий день; переменная часть — по каждому занятию.</span>
                </header>
                <div className="studio-form-grid">
                  <label>
                    <span>Период базы</span>
                    <select
                      value={planBasePeriod}
                      onChange={(event) => setPlanBasePeriod(event.target.value as "MONTH" | "DAY")}
                    >
                      <option value="MONTH">Оклад в месяц</option>
                      <option value="DAY">Фикс за рабочий день</option>
                    </select>
                  </label>
                  <label>
                    <span>Переменная часть</span>
                    <select
                      value={planVariableType}
                      onChange={(event) => setPlanVariableType(event.target.value as typeof planVariableType)}
                    >
                      <option value="PERCENT">Процент от реализации</option>
                      <option value="HOURLY">Ставка за часы</option>
                      <option value="PER_ATTENDEE">За каждого ученика</option>
                      <option value="FIXED_PER_LESSON">Фикс за занятие</option>
                    </select>
                  </label>
                </div>
                {planVariableType !== "PERCENT" ? (
                  <label>
                    <span>
                      {planVariableType === "HOURLY"
                        ? "Переменная ставка за час, ₽"
                        : planVariableType === "PER_ATTENDEE"
                          ? "За каждого пришедшего, ₽"
                          : "Доплата за занятие, ₽"}
                    </span>
                    <input
                      inputMode="decimal"
                      value={planVariableRub}
                      onChange={(event) => setPlanVariableRub(event.target.value)}
                    />
                  </label>
                ) : null}
              </div>
            ) : null}

            <div className="studio-form-grid">
              <label>
                <span>
                  {planScheme === "HOURLY"
                    ? "Ставка за час, ₽"
                    : planScheme === "COMPOSITE"
                      ? "Оклад в месяц, ₽"
                      : planScheme === "PERCENT"
                        ? "Фиксированная часть, ₽"
                        : "Базовая сумма, ₽"}
                </span>
                <input
                  inputMode="decimal"
                  value={planBaseRub}
                  onChange={(event) => setPlanBaseRub(event.target.value)}
                />
              </label>

              {(planScheme === "PERCENT" || planScheme === "COMPOSITE") ? (
                <label>
                  <span>Процент от реализации, %</span>
                  <input
                    inputMode="decimal"
                    value={planPercent}
                    onChange={(event) => setPlanPercent(event.target.value)}
                  />
                </label>
              ) : null}

              {planScheme === "ATTENDEE" ? (
                <label>
                  <span>Доплата за пришедшего, ₽</span>
                  <input
                    inputMode="decimal"
                    value={planPerAttendeeRub}
                    onChange={(event) => setPlanPerAttendeeRub(event.target.value)}
                  />
                </label>
              ) : null}

              <label>
                <span>Минимальная гарантия в месяц, ₽</span>
                <input
                  inputMode="decimal"
                  value={planGuaranteeRub}
                  onChange={(event) => setPlanGuaranteeRub(event.target.value)}
                />
              </label>
            </div>
          </StudioModal>
        ) : null}

      </section>
    </main>
  );
}
