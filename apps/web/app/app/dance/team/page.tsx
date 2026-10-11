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
  membership_id?: string | null;
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
  dance_program_id: string | null;
  program_name: string | null;
  dance_group_id: string | null;
  group_name: string | null;
  branch_id: string | null;
  branch_name: string | null;
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
type Branch = { id: string; name: string; legalEntityId: string | null };
type Organization = { legalEntities: LegalEntity[]; branches: Branch[] };
type Program = { id: string; name: string };
type Group = { id: string; name: string; program_id: string; program_name: string };
type PayrollBatch = {
  id: string;
  period_from: string;
  period_to: string;
  status: "DRAFT" | "APPROVED" | "PAID";
  paid_at?: string | null;
  payment_reference?: string | null;
  payment_note?: string | null;
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
  adjustment_minor: string;
  total_minor: string;
  currency: string;
  status: string;
  payroll_batch_id: string | null;
  review_id: string | null;
  review_status: "PENDING" | "ACKNOWLEDGED" | "DISPUTED" | "RESOLVED" | "WAIVED";
  employee_comment: string | null;
  manager_comment: string | null;
  adjustments: Array<{
    id: string;
    adjustmentType: string;
    amountMinor: string;
    reason: string;
    createdAt: string;
  }>;
};

type StatementDetail = {
  statement: TrainerStatement & {
    calculation_snapshot?: {
      profileId?: string | null;
      planIds?: string[];
      lessonAccrualMinor?: string;
      baseComponents?: Array<{
        source?: string;
        componentType?: string;
        units?: number;
        rateMinor?: string;
        amountMinor?: string;
      }>;
      minimumGuaranteeMinor?: string;
      monthlyGuaranteeMinor?: string;
      dailyGuaranteeMinor?: string;
      effectiveGuaranteeMinor?: string;
    };
  };
  lessons: Array<{
    accrual_id: string;
    lesson_id: string;
    starts_at: string;
    ends_at: string;
    lesson_type: string;
    lesson_name: string;
    program_name: string | null;
    service_name: string | null;
    attended_count: number;
    eligible_revenue_minor: string;
    amount_minor: string;
    currency: string;
    status: string;
    calculation_type: string | null;
    revenue_basis: string | null;
  }>;
  adjustments: Array<{
    id: string;
    adjustment_type: string;
    amount_minor: string;
    reason: string;
    created_at: string;
  }>;
  payrollSources: Array<{
    id: string;
    source_type: string;
    source_key: string;
    gross_minor: string;
    deduction_minor: string;
    metadata: Record<string, unknown>;
  }>;
};

type TrainerPayrollProfile = {
  id: string;
  trainer_resource_id: string;
  trainer_name: string;
  monthly_base_minor: string;
  daily_base_minor: string;
  minimum_guarantee_minor: string;
  currency: string;
  valid_from: string;
  valid_to: string | null;
  membership_id: string | null;
  note: string | null;
};

function money(value: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

function payrollReviewLabel(value: TrainerStatement["review_status"]) {
  return ({
    PENDING: "Ждёт подтверждения",
    ACKNOWLEDGED: "Согласовано",
    DISPUTED: "Есть спор",
    RESOLVED: "Спор решён",
    WAIVED: "Подтверждение не требуется"
  } as Record<string, string>)[value] ?? value;
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
  const [access,setAccess]=useState<{
    canViewFinance:boolean;canManageFinance:boolean;canManageDance:boolean
  }|null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [accruals, setAccruals] = useState<Accrual[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [roomStatements, setRoomStatements] = useState<RoomStatement[]>([]);
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [programs, setPrograms] = useState<Program[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [payroll, setPayroll] = useState<PayrollBatch[]>([]);
  const [trainerStatements, setTrainerStatements] = useState<TrainerStatement[]>([]);
  const [payrollProfiles, setPayrollProfiles] = useState<TrainerPayrollProfile[]>([]);
  const [area,setArea]=useState<"PAYROLL"|"TRAINERS"|"ROOMS">("PAYROLL");
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
  const [planProgramId, setPlanProgramId] = useState("");
  const [planGroupId, setPlanGroupId] = useState("");
  const [planBranchId, setPlanBranchId] = useState("");
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
  const [profileModal, setProfileModal] = useState(false);
  const [profileTrainerId, setProfileTrainerId] = useState("");
  const [profileMonthlyRub, setProfileMonthlyRub] = useState("0");
  const [profileDailyRub, setProfileDailyRub] = useState("0");
  const [profileGuaranteeRub, setProfileGuaranteeRub] = useState("0");
  const [profileNote, setProfileNote] = useState("");
  const [paymentModal,setPaymentModal]=useState(false);
  const [paymentDate,setPaymentDate]=useState(
    new Date().toISOString().slice(0,10)
  );
  const [paymentReference,setPaymentReference]=useState("");
  const [paymentNote,setPaymentNote]=useState("");
  const [statementDetail, setStatementDetail] =
    useState<StatementDetail | null>(null);
  const [statementDetailLoading, setStatementDetailLoading] = useState(false);
  const [adjustmentModal, setAdjustmentModal] = useState(false);
  const [adjustmentStatement, setAdjustmentStatement] =
    useState<TrainerStatement | null>(null);
  const [adjustmentType, setAdjustmentType] = useState<
    "BONUS" | "DEDUCTION" | "CORRECTION" | "OTHER"
  >("BONUS");
  const [adjustmentRub, setAdjustmentRub] = useState("1000");
  const [adjustmentReason, setAdjustmentReason] = useState("");

  const load = useCallback(async () => {
    setError("");
    const range = monthRange();
    try {
      const rights=await apiRequest<{
        canViewFinance:boolean;canManageFinance:boolean;canManageDance:boolean
      }>("/dance/access");
      setAccess(rights);
      if(!rights.canManageFinance){
        // Instructor self-service or a finance read-only manager.
        // Never request rents, all employee profiles or account-wide payroll.
        const [ownStatements,ownAccruals]=await Promise.all([
          apiRequest<TrainerStatement[]>(
            "/dance/payroll-statements?from="+encodeURIComponent(range.from)+
              "&to="+encodeURIComponent(range.to)),
          apiRequest<Accrual[]>(
            "/dance/compensation-accruals?from="+encodeURIComponent(range.from)+
              "&to="+encodeURIComponent(range.to))
        ]);
        setTrainerStatements(ownStatements);setAccruals(ownAccruals);
        return;
      }
      const currentMonth = new Date().toISOString().slice(0, 7);
      const [
        customerRows,
        resourceRows,
        serviceRows,
        planRows,
        profileRows,
        accrualRows,
        trainerStatementRows,
        contractRows,
        statementRows,
        organization,
        programRows,
        groupRows
      ] = await Promise.all([
          apiRequest<Customer[]>("/crm/customers"),
          apiRequest<Resource[]>("/service/resources"),
          apiRequest<Service[]>("/service/catalog"),
          apiRequest<Plan[]>("/dance/compensation-plans"),
          apiRequest<TrainerPayrollProfile[]>("/dance/payroll-profiles"),
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
          apiRequest<Organization>("/organization"),
          apiRequest<Program[]>("/dance/programs"),
          apiRequest<Group[]>("/dance/groups")
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
      setPayrollProfiles(profileRows);
      setAccruals(accrualRows);
      setTrainerStatements(trainerStatementRows);
      setContracts(contractRows);
      setRoomStatements(statementRows);
      setEntities(organization.legalEntities);
      setBranches(organization.branches ?? []);
      setPrograms(programRows);
      setGroups(groupRows);

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

  const currentPayrollBatch = useMemo(() => {
    const range=monthRange();
    const from=range.from.slice(0,10);
    const to=new Date(
      new Date(range.to).getTime()-86400000
    ).toISOString().slice(0,10);
    return payroll.find(
      (item)=>item.period_from===from&&item.period_to===to
    )??null;
  },[payroll]);

  const profileByTrainer = useMemo(
    () =>
      new Map(
        payrollProfiles.map((profile) => [
          profile.trainer_resource_id,
          profile
        ])
      ),
    [payrollProfiles]
  );

  function openProfileModal(trainerId?: string) {
    const id=trainerId || trainers[0]?.id || "";
    const existing=profileByTrainer.get(id);
    setProfileTrainerId(id);
    setProfileMonthlyRub(
      existing ? String(Number(existing.monthly_base_minor) / 100) : "0"
    );
    setProfileDailyRub(
      existing ? String(Number(existing.daily_base_minor) / 100) : "0"
    );
    setProfileGuaranteeRub(
      existing ? String(Number(existing.minimum_guarantee_minor) / 100) : "0"
    );
    setProfileNote(existing?.note ?? "");
    setProfileModal(true);
  }

  async function saveProfile() {
    if(!profileTrainerId){
      setError("Выберите тренера");
      return;
    }
    const monthly=Number(profileMonthlyRub.replace(",", "."));
    const daily=Number(profileDailyRub.replace(",", "."));
    const guarantee=Number(profileGuaranteeRub.replace(",", "."));
    if(
      !Number.isFinite(monthly)||monthly<0||
      !Number.isFinite(daily)||daily<0||
      !Number.isFinite(guarantee)||guarantee<0
    ){
      setError("Проверьте постоянные условия зарплаты");
      return;
    }

    setPending(true);
    setError("");
    try{
      await apiRequest("/dance/payroll-profiles",{
        method:"POST",
        body:JSON.stringify({
          trainerResourceId:profileTrainerId,
          monthlyBaseMinor:String(Math.round(monthly*100)),
          dailyBaseMinor:String(Math.round(daily*100)),
          minimumGuaranteeMinor:String(Math.round(guarantee*100)),
          note:profileNote.trim()||undefined
        })
      });
      setProfileModal(false);
      setNotice("Постоянные условия тренера сохранены.");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить условия тренера"
      );
    }finally{
      setPending(false);
    }
  }

  function openPlanModal() {
    setPlanTrainerId((current) => current || trainers[0]?.id || "");
    setPlanServiceId("");
    setPlanLessonType("");
    setPlanProgramId("");
    setPlanGroupId("");
    setPlanBranchId("");
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
    const variableMinor = String(Math.round(variableRub * 100));
    const compositeCalculation =
      planVariableType === "PERCENT"
        ? "PERCENT"
        : planVariableType === "HOURLY"
          ? "HOURLY"
          : planVariableType === "PER_ATTENDEE"
            ? "ATTENDEE"
            : "FIXED";

    setPending(true);
    setError("");
    try {
      if (planScheme === "COMPOSITE") {
        await apiRequest("/dance/payroll-profiles", {
          method: "POST",
          body: JSON.stringify({
            trainerResourceId: planTrainerId,
            monthlyBaseMinor:
              planBasePeriod === "MONTH" ? baseMinor : "0",
            dailyBaseMinor:
              planBasePeriod === "DAY" ? baseMinor : "0",
            minimumGuaranteeMinor:
              String(Math.round(guaranteeRub * 100))
          })
        });
      }

      const calculationType =
        planScheme === "COMPOSITE"
          ? compositeCalculation
          : planScheme;

      await apiRequest("/dance/compensation-plans", {
        method: "POST",
        body: JSON.stringify({
          trainerResourceId: planTrainerId,
          serviceId: planServiceId || undefined,
          lessonType: planLessonType || undefined,
          danceProgramId: planProgramId || undefined,
          danceGroupId: planGroupId || undefined,
          branchId: planBranchId || undefined,
          calculationType,
          fixedMinor:
            calculationType === "FIXED"
              ? (planScheme === "COMPOSITE" ? variableMinor : baseMinor)
              : calculationType === "ATTENDEE" && planScheme !== "COMPOSITE"
                ? baseMinor
                : "0",
          hourlyMinor:
            calculationType === "HOURLY"
              ? (planScheme === "COMPOSITE" ? variableMinor : baseMinor)
              : "0",
          percentBps:
            calculationType === "PERCENT" ? Math.round(percent * 100) : 0,
          perAttendeeMinor:
            calculationType === "ATTENDEE"
              ? (
                  planScheme === "COMPOSITE"
                    ? variableMinor
                    : String(Math.round(perAttendeeRub * 100))
                )
              : "0",
          revenueBasis: planRevenueBasis,
          minimumGuaranteeMinor:
            planScheme === "COMPOSITE"
              ? "0"
              : "0",
          guaranteePeriod: "MONTH"
        })
      });
      setPlanModal(false);
      setNotice(
        planScheme === "COMPOSITE"
          ? "Оклад и переменное правило тренера сохранены."
          : "Правило начисления сохранено."
      );
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

  async function archivePlan(plan: Plan) {
    if (
      !window.confirm(
        "Отключить правило для " +
          plan.trainer_name +
          "? Уже рассчитанные занятия не изменятся."
      )
    ) {
      return;
    }
    setPending(true);
    setError("");
    try {
      await apiRequest(
        "/dance/compensation-plans/" + plan.id + "/archive",
        { method: "POST" }
      );
      setNotice("Правило доплаты отключено.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось отключить правило"
      );
    } finally {
      setPending(false);
    }
  }

  async function reviewStatement(
    statement: TrainerStatement,
    status: "ACKNOWLEDGED" | "DISPUTED"
  ) {
    let comment = "";
    if (status === "DISPUTED") {
      comment =
        window.prompt("Коротко опишите, с чем не согласны в расчёте")?.trim() ??
        "";
      if (comment.length < 3) return;
    } else if (
      !window.confirm(
        "Подтвердить расчёт " +
          statement.trainer_name +
          " на сумму " +
          money(statement.total_minor) +
          "?"
      )
    ) {
      return;
    }

    setPending(true);
    setError("");
    try {
      await apiRequest(
        "/dance/payroll-statements/" + statement.id + "/review",
        {
          method: "POST",
          body: JSON.stringify({
            status,
            comment: comment || undefined
          })
        }
      );
      setNotice(
        status === "ACKNOWLEDGED"
          ? "Ведомость подтверждена."
          : "Спор по ведомости зафиксирован."
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить согласование"
      );
    } finally {
      setPending(false);
    }
  }

  async function resolveStatementReview(statement: TrainerStatement) {
    if (!statement.review_id) return;
    const comment =
      window.prompt("Опишите решение по спорной ведомости")?.trim() ?? "";
    if (comment.length < 3) return;

    setPending(true);
    setError("");
    try {
      await apiRequest(
        "/dance/payroll-reviews/" + statement.review_id + "/resolve",
        {
          method: "POST",
          body: JSON.stringify({
            status: "RESOLVED",
            comment
          })
        }
      );
      setNotice("Спор по ведомости закрыт.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось закрыть спор"
      );
    } finally {
      setPending(false);
    }
  }

  async function openStatementDetails(statementId: string) {
    setStatementDetailLoading(true);
    setError("");
    try {
      const result=await apiRequest<StatementDetail>(
        "/dance/payroll-statements/" + encodeURIComponent(statementId)
      );
      setStatementDetail(result);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось разобрать ведомость"
      );
    } finally {
      setStatementDetailLoading(false);
    }
  }

  function openAdjustment(statement: TrainerStatement) {
    setAdjustmentStatement(statement);
    setAdjustmentType("BONUS");
    setAdjustmentRub("1000");
    setAdjustmentReason("");
    setAdjustmentModal(true);
  }

  async function saveAdjustment() {
    if (!adjustmentStatement) return;
    const rub = Number(adjustmentRub.replace(",", "."));
    if (!Number.isFinite(rub) || rub <= 0) {
      setError("Введите сумму больше нуля");
      return;
    }
    if (adjustmentReason.trim().length < 3) {
      setError("Укажите понятную причину корректировки");
      return;
    }

    setPending(true);
    setError("");
    try {
      await apiRequest(
        "/dance/payroll-statements/" +
          adjustmentStatement.id +
          "/adjustments",
        {
          method: "POST",
          body: JSON.stringify({
            type: adjustmentType,
            amountMinor: String(Math.round(rub * 100)),
            reason: adjustmentReason.trim()
          })
        }
      );
      setAdjustmentModal(false);
      setAdjustmentStatement(null);
      setNotice("Корректировка ведомости сохранена.");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить корректировку"
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

  async function approvePayrollBatch() {
    if(!currentPayrollBatch){
      setError("Сначала передайте ведомости в payroll");
      return;
    }
    if(currentPayrollBatch.status!=="DRAFT") return;
    setPending(true);
    setError("");
    try{
      await apiRequest(
        "/accounting/payroll/batches/"+
          currentPayrollBatch.id+
          "/approve",
        {method:"POST"}
      );
      setNotice("Payroll утверждён. Теперь можно зарегистрировать выплату.");
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось утвердить payroll"
      );
    }finally{
      setPending(false);
    }
  }

  function openPaymentModal(){
    if(!currentPayrollBatch||currentPayrollBatch.status!=="APPROVED"){
      setError("Сначала утвердите payroll");
      return;
    }
    setPaymentDate(new Date().toISOString().slice(0,10));
    setPaymentReference("");
    setPaymentNote("");
    setPaymentModal(true);
  }

  async function registerPayrollPayment(){
    if(!currentPayrollBatch) return;
    const paidAt=new Date(paymentDate+"T12:00:00");
    if(Number.isNaN(paidAt.getTime())){
      setError("Проверьте дату выплаты");
      return;
    }
    setPending(true);
    setError("");
    try{
      await apiRequest(
        "/accounting/payroll/batches/"+
          currentPayrollBatch.id+
          "/paid",
        {
          method:"POST",
          body:JSON.stringify({
            paidAt:paidAt.toISOString(),
            reference:paymentReference.trim()||undefined,
            note:paymentNote.trim()||undefined
          })
        }
      );
      setPaymentModal(false);
      setNotice(
        "Выплата зарегистрирована. Связанные ведомости тренеров отмечены как оплаченные."
      );
      await load();
    }catch(cause){
      setError(
        cause instanceof Error?cause.message:"Не удалось зарегистрировать выплату"
      );
    }finally{
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

  if(access&&!access.canManageFinance)return (
    <main className="app-shell">
      <AppSidebar active="dance-team" />
      <section className="workspace workspace-wide studio-premium dance-detail">
        <header className="studio-hero compact">
          <div><span className="studio-eyebrow">Ведомости и начисления</span>
            <h1>{access.canViewFinance?"Просмотр зарплаты":"Мои начисления"}</h1>
            <p>Проверьте расчёт по проведённым занятиям. При расхождениях
              отметьте ведомость как спорную с пояснением.</p>
          </div>
          <button type="button" className="secondary-button" disabled={pending}
            onClick={()=>void load()}>Обновить</button>
        </header>
        <DanceWorkspaceNav active="team" />
        {error?<div className="studio-message error" role="alert">{error}</div>:null}
        {notice?<div className="studio-message success" role="status">{notice}</div>:null}
        <section className="settings-card">
          <div className="section-heading"><div><h2>Зарплатные ведомости</h2>
            <p className="muted">Расчёт и статус подтверждения</p></div></div>
          <div className="data-table-wrap"><table className="data-table">
            <thead><tr><th>Тренер</th><th>Период</th><th>Сумма</th><th>Статус</th>
              <th>Действие</th></tr></thead>
            <tbody>
              {trainerStatements.map(statement=><tr key={statement.id}>
                <td><strong>{statement.trainer_name}</strong></td>
                <td>{statement.period_from} — {statement.period_to}</td>
                <td>{money(statement.total_minor)}</td>
                <td>{payrollReviewLabel(statement.review_status)}</td>
                <td className="table-actions">
                  <button type="button" className="secondary-button" disabled={pending}
                    onClick={()=>void openStatementDetails(statement.id)}>
                    Детали
                  </button>
                  {!access.canViewFinance&&statement.review_status==="PENDING"?<>
                    <button type="button" disabled={pending}
                      onClick={()=>void reviewStatement(statement,"ACKNOWLEDGED")}>
                      Подтвердить
                    </button>
                    <button type="button" className="secondary-button" disabled={pending}
                      onClick={()=>void reviewStatement(statement,"DISPUTED")}>
                      Оспорить
                    </button>
                  </>:null}
                </td>
              </tr>)}
              {!trainerStatements.length?<tr><td colSpan={5}>
                Пока нет ведомостей за этот период. Уточните у администратора,
                закрыты ли занятия и сформирована ли зарплата.
              </td></tr>:null}
            </tbody>
          </table></div>
        </section>
        <section className="settings-card">
          <h2>Начисления по занятиям</h2>
          <div className="data-table-wrap"><table className="data-table">
            <thead><tr><th>Дата</th><th>Тренер</th><th>Учеников</th>
              <th>Начислено</th><th>Статус</th></tr></thead>
            <tbody>
              {accruals.map(item=><tr key={item.id}>
                <td>{new Date(item.starts_at).toLocaleDateString("ru-RU")}</td>
                <td>{item.trainer_name}</td>
                <td>{item.attended_count}</td>
                <td>{money(item.amount_minor)}</td>
                <td>{item.status}</td>
              </tr>)}
              {!accruals.length?<tr><td colSpan={5}>
                Начисления появятся после закрытия занятий.
              </td></tr>:null}
            </tbody>
          </table></div>
        </section>
        {statementDetail?<StudioModal eyebrow="Моя ведомость"
          title={statementDetail.statement.trainer_name}
          description={statementDetail.statement.period_from+" — "+
            statementDetail.statement.period_to}
          onClose={()=>setStatementDetail(null)}
          footer={<button type="button" onClick={()=>setStatementDetail(null)}>Закрыть</button>}>
          <p>Итог: <strong>{money(statementDetail.statement.total_minor)}</strong></p>
          <div className="data-table-wrap"><table className="data-table">
            <thead><tr><th>Занятие</th><th>Заработано</th></tr></thead>
            <tbody>{statementDetail.lessons.map(lesson=><tr key={lesson.accrual_id}>
              <td>{lesson.lesson_name} · {new Date(lesson.starts_at).toLocaleDateString("ru-RU")}</td>
              <td>{money(lesson.amount_minor)}</td>
            </tr>)}</tbody>
          </table></div>
        </StudioModal>:null}
      </section>
    </main>
  );

  return (
    <main className="app-shell">
      <AppSidebar active="dance-team" />
      <section className="workspace workspace-wide studio-premium dance-detail">
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
            {area==="TRAINERS"?<>
              <button type="button" className="secondary-button" onClick={()=>openProfileModal()}>Условия тренера</button>
              <button type="button" onClick={openPlanModal}>Правило доплаты</button>
            </>:null}
            {area==="ROOMS"?<>
              <button type="button" className="secondary-button" onClick={openRoomModal}>Договор аренды</button>
              <button type="button" disabled={pending} onClick={()=>void finalizeRoomMonth()}>Закрыть аренду</button>
            </>:null}
            {area==="PAYROLL"?<>
              <button type="button" disabled={pending} onClick={()=>void approveMonth()}>Рассчитать месяц</button>
              <button type="button" className="secondary-button"
                disabled={pending||trainerStatements.some(s=>s.review_status==="DISPUTED")}
                onClick={()=>void exportPayroll()}>Передать в зарплату</button>
              {currentPayrollBatch?.status==="DRAFT"?
                <button type="button" disabled={pending} onClick={()=>void approvePayrollBatch()}>Утвердить ведомость</button>:null}
              {currentPayrollBatch?.status==="APPROVED"?
                <button type="button" disabled={pending} onClick={openPaymentModal}>Зарегистрировать выплату</button>:null}
              {currentPayrollBatch?.status==="PAID"?<span className="status-pill">Выплачено</span>:null}
            </>:null}
          </div>
        </header>

        <DanceWorkspaceNav active="team" />
        <nav className="dance-segment-nav" aria-label="Рабочие режимы команды">
          {([
            ["PAYROLL","Зарплата и выплаты"],
            ["TRAINERS","Условия тренеров"],
            ["ROOMS","Аренда залов"]
          ] as const).map(([key,label])=>
            <button key={key} type="button" className={area===key?"active":""}
              aria-pressed={area===key} onClick={()=>setArea(key)}>{label}</button>
          )}
        </nav>

        <section style={{display:area==="PAYROLL"?"":"none"}} className="payroll-pipeline" aria-label="Статус зарплаты месяца">
          {[
            {
              key:"CALCULATED",
              title:"1. Месяц рассчитан",
              hint:"Ведомости тренеров сформированы",
              done:trainerStatements.some((item)=>
                ["FINALIZED","EXPORTED","PAID"].includes(item.status)
              )
            },
            {
              key:"EXPORTED",
              title:"2. Передано в payroll",
              hint:"Начисления собраны в общий payroll",
              done:Boolean(currentPayrollBatch)
            },
            {
              key:"APPROVED",
              title:"3. Payroll утверждён",
              hint:"Суммы зафиксированы для выплаты",
              done:Boolean(
                currentPayrollBatch &&
                ["APPROVED","PAID"].includes(currentPayrollBatch.status)
              )
            },
            {
              key:"PAID",
              title:"4. Выплачено",
              hint:currentPayrollBatch?.paid_at
                ? new Date(currentPayrollBatch.paid_at).toLocaleDateString("ru-RU")
                : "После фактической выплаты",
              done:currentPayrollBatch?.status==="PAID"
            }
          ].map((step,index)=>(
            <article
              key={step.key}
              className={
                "payroll-pipeline-step "+
                (step.done?"done":
                  index===0||
                  (index===1&&trainerStatements.length)||
                  (index===2&&currentPayrollBatch?.status==="DRAFT")||
                  (index===3&&currentPayrollBatch?.status==="APPROVED")
                    ?"current":"")
              }
            >
              <span>{step.done?"✓":String(index+1).padStart(2,"0")}</span>
              <div>
                <strong>{step.title}</strong>
                <small>{step.hint}</small>
              </div>
            </article>
          ))}
        </section>

        {error ? <div className="studio-message error"><strong>Тренеры и залы</strong><span>{error}</span></div> : null}
        {notice ? <div className="studio-message success"><strong>Готово</strong><span>{notice}</span></div> : null}

        <div className="owner-kpi-grid studio-kpi-grid" style={{display:area==="PAYROLL"?"":"none"}}>
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

        <section className="section-block studio-section" style={{display:area==="TRAINERS"?"":"none"}}>
          <div className="section-heading">
            <div>
              <p className="muted">Договорённости</p>
              <h2>Постоянные условия тренеров</h2>
            </div>
            <span className="studio-helper">
              Оклад и гарантия задаются один раз. Правила по услугам ниже
              отвечают только за переменную часть.
            </span>
          </div>
          <div className="trainer-condition-grid">
            {trainers.map((trainer) => {
              const profile=profileByTrainer.get(trainer.id);
              return (
                <article className="trainer-condition-card" key={trainer.id}>
                  <header>
                    <div>
                      <span>Тренер</span>
                      <h3>{trainer.name}</h3>
                    </div>
                    <span className={"status-pill " + (profile ? "" : "muted")}>
                      {profile ? "НАСТРОЕНО" : "БЕЗ ОКЛАДА"}
                    </span>
                  </header>
                  <div className="trainer-condition-money">
                    <strong>
                      {profile && BigInt(profile.monthly_base_minor)>0n
                        ? money(profile.monthly_base_minor)
                        : "Переменная оплата"}
                    </strong>
                    <small>
                      {profile && BigInt(profile.monthly_base_minor)>0n
                        ? "фикс в месяц"
                        : "без месячного оклада"}
                    </small>
                  </div>
                  <div className="trainer-condition-facts">
                    <span>
                      За день
                      <b>
                        {profile ? money(profile.daily_base_minor) : "0 ₽"}
                      </b>
                    </span>
                    <span>
                      Минимум
                      <b>
                        {profile
                          ? money(profile.minimum_guarantee_minor)
                          : "0 ₽"}
                      </b>
                    </span>
                    <span>
                      Payroll
                      <b>
                        {trainer.membership_id || profile?.membership_id
                          ? "готов"
                          : "нужна привязка"}
                      </b>
                    </span>
                  </div>
                  {profile?.note ? (
                    <p className="trainer-condition-note">{profile.note}</p>
                  ) : null}
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => openProfileModal(trainer.id)}
                  >
                    {profile ? "Изменить условия" : "Настроить условия"}
                  </button>
                </article>
              );
            })}
            {!trainers.length ? (
              <div className="studio-empty">
                <span>人</span>
                <strong>Тренеры ещё не добавлены</strong>
                <p>
                  Создайте ресурсы сотрудников, затем настройте оплату и
                  расписание.
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="section-block studio-section" style={{display:area==="TRAINERS"?"":"none"}}>
          <div className="section-heading">
            <div>
              <p className="muted">Переменная часть</p>
              <h2>Правила доплат за работу</h2>
            </div>
            <span className="studio-helper">
              Процент, часы, занятие или доплата за ученика с точным
              ограничением по услуге, направлению, группе и филиалу.
            </span>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Тренер</th><th>Где действует</th><th>Схема</th><th>Условия</th><th>Расчёт</th><th></th></tr></thead>
              <tbody>
                {plans.map((plan) => (
                  <tr key={plan.id}>
                    <td><strong>{plan.trainer_name}</strong></td>
                    <td>
                      <strong>{plan.service_name ?? "Все услуги"}</strong>
                      <small>
                        {[
                          plan.lesson_type
                            ? plan.lesson_type
                            : "любой формат",
                          plan.program_name
                            ? "направление: " + plan.program_name
                            : null,
                          plan.group_name
                            ? "группа: " + plan.group_name
                            : null,
                          plan.branch_name
                            ? "филиал: " + plan.branch_name
                            : null
                        ].filter(Boolean).join(" · ")}
                      </small>
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
                    <td>
                      <button
                        className="table-action"
                        type="button"
                        disabled={pending}
                        onClick={() => void archivePlan(plan)}
                      >
                        Отключить
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section-block studio-section" style={{display:area==="PAYROLL"?"":"none"}}>
          <div className="section-heading">
            <div>
              <p className="muted">Итог месяца</p>
              <h2>Ведомости тренеров</h2>
            </div>
            <span className="studio-helper">
              Оклад и гарантия добавляются здесь, а не в каждый урок.
            </span>
          </div>
          <div className="studio-score-grid compact">
            <article>
              <span>К выплате</span>
              <strong>
                {money(
                  trainerStatements
                    .reduce(
                      (sum, item) => sum + BigInt(item.total_minor ?? "0"),
                      0n
                    )
                    .toString()
                )}
              </strong>
              <p>{trainerStatements.length} ведомостей в выбранном месяце.</p>
            </article>
            <article>
              <span>Согласовано</span>
              <strong>
                {
                  trainerStatements.filter((item) =>
                    ["ACKNOWLEDGED", "RESOLVED", "WAIVED"].includes(
                      item.review_status
                    )
                  ).length
                }
              </strong>
              <p>Расчёт подтверждён или спор закрыт.</p>
            </article>
            <article>
              <span>Ожидают</span>
              <strong>
                {
                  trainerStatements.filter(
                    (item) => item.review_status === "PENDING"
                  ).length
                }
              </strong>
              <p>Сотрудник ещё не подтвердил сумму.</p>
            </article>
            <article>
              <span>Споры</span>
              <strong>
                {
                  trainerStatements.filter(
                    (item) => item.review_status === "DISPUTED"
                  ).length
                }
              </strong>
              <p>Payroll не будет экспортирован до решения.</p>
            </article>
          </div>
          <div className="trainer-statement-grid">
            {trainerStatements.map((statement) => (
              <article key={statement.id}>
                <header>
                  <div>
                    <span>Тренер</span>
                    <h3>{statement.trainer_name}</h3>
                  </div>
                  <div className="statement-status-stack">
                    <span className="status-pill">{statement.status}</span>
                    <span
                      className={
                        "status-pill " +
                        (statement.review_status === "DISPUTED" ? "danger" : "")
                      }
                    >
                      {payrollReviewLabel(statement.review_status)}
                    </span>
                  </div>
                </header>
                <strong>{money(statement.total_minor)}</strong>
                <div>
                  <span>За занятия <b>{money(statement.lesson_accrual_minor)}</b></span>
                  <span>База <b>{money(statement.base_minor)}</b></span>
                  <span>Гарантия <b>{money(statement.guarantee_adjustment_minor)}</b></span>
                  <span>
                    Корректировки{" "}
                    <b>{money(statement.adjustment_minor ?? "0")}</b>
                  </span>
                </div>
                {statement.employee_comment ? (
                  <div className="statement-adjustments">
                    <small>Комментарий сотрудника: {statement.employee_comment}</small>
                  </div>
                ) : null}
                {statement.manager_comment ? (
                  <div className="statement-adjustments">
                    <small>Решение руководителя: {statement.manager_comment}</small>
                  </div>
                ) : null}
                {statement.adjustments?.length ? (
                  <div className="statement-adjustments">
                    {statement.adjustments.map((item) => (
                      <small key={item.id}>
                        {item.amountMinor.startsWith("-") ? "−" : "+"}
                        {money(item.amountMinor.replace("-", ""))} · {item.reason}
                      </small>
                    ))}
                  </div>
                ) : null}
                <button
                  className="secondary-button"
                  type="button"
                  disabled={statementDetailLoading}
                  onClick={() => void openStatementDetails(statement.id)}
                >
                  {statementDetailLoading ? "Открываем…" : "Разобрать сумму"}
                </button>
                {statement.status === "FINALIZED" ? (
                  <button
                    className="secondary-button"
                    type="button"
                    onClick={() => openAdjustment(statement)}
                  >
                    + Премия / удержание
                  </button>
                ) : null}
                {statement.status === "FINALIZED" &&
                statement.review_status === "PENDING" ? (
                  <span className="muted">
                    Ждём подтверждения тренера в его личном кабинете
                  </span>
                ) : null}
                {statement.review_status === "DISPUTED" ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void resolveStatementReview(statement)}
                  >
                    Закрыть спор
                  </button>
                ) : null}
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

        <section className="section-block studio-section" style={{display:area==="PAYROLL"?"":"none"}}>
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

        <section className="section-block studio-section" style={{display:area==="ROOMS"?"":"none"}}>
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

        <section className="section-block studio-section" style={{display:area==="ROOMS"?"":"none"}}>
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
        {statementDetail ? (
          <StudioModal
            eyebrow="Расшифровка ведомости"
            title={statementDetail.statement.trainer_name}
            description={
              statementDetail.statement.period_from +
              " — " +
              statementDetail.statement.period_to
            }
            onClose={() => setStatementDetail(null)}
            footer={
              <button
                type="button"
                onClick={() => setStatementDetail(null)}
              >
                Закрыть
              </button>
            }
          >
            <div className="studio-kpi-grid compact">
              <article>
                <span>Занятия</span>
                <strong>
                  {money(statementDetail.statement.lesson_accrual_minor)}
                </strong>
                <small>{statementDetail.lessons.length} начислений</small>
              </article>
              <article>
                <span>Постоянная часть</span>
                <strong>{money(statementDetail.statement.base_minor)}</strong>
                <small>Оклад / дневная ставка</small>
              </article>
              <article>
                <span>Гарантия</span>
                <strong>
                  {money(
                    statementDetail.statement.guarantee_adjustment_minor
                  )}
                </strong>
                <small>Доплата до минимума</small>
              </article>
              <article>
                <span>Итого</span>
                <strong>{money(statementDetail.statement.total_minor)}</strong>
                <small>
                  Корректировки{" "}
                  {money(statementDetail.statement.adjustment_minor)}
                </small>
              </article>
            </div>

            {statementDetail.statement.calculation_snapshot?.baseComponents
              ?.length ? (
              <div className="studio-form-section">
                <header>
                  <strong>Постоянная часть</strong>
                  <span>
                    Применяется к периоду отдельно от ставок за занятия.
                  </span>
                </header>
                <div className="payroll-breakdown-grid">
                  {statementDetail.statement.calculation_snapshot.baseComponents.map(
                    (component, index) => (
                      <article key={index}>
                        <span>
                          {component.componentType === "MONTHLY_BASE"
                            ? "Оклад за месяц"
                            : "Ставка за рабочий день"}
                        </span>
                        <strong>
                          {money(
                            component.amountMinor ??
                              String(
                                BigInt(component.rateMinor ?? "0") *
                                  BigInt(component.units ?? 0)
                              )
                          )}
                        </strong>
                        <small>
                          {component.units && component.units > 1
                            ? component.units + " дн."
                            : component.source ?? "Профиль тренера"}
                        </small>
                      </article>
                    )
                  )}
                </div>
              </div>
            ) : null}

            {statementDetail.payrollSources?.length ? (
              <div className="studio-form-section">
                <header>
                  <strong>Экспорт в payroll</strong>
                  <span>
                    Источники хранятся отдельно, поэтому ведомость студии не
                    перезаписывает ручные или другие начисления сотрудника.
                  </span>
                </header>
                <div className="payroll-breakdown-grid">
                  {statementDetail.payrollSources.map((source) => (
                    <article key={source.id}>
                      <span>
                        {source.source_type === "DANCE_TRAINER_STATEMENT"
                          ? "Ведомость студии"
                          : source.source_type === "MANUAL"
                            ? "Ручное начисление"
                            : source.source_type}
                      </span>
                      <strong>{money(source.gross_minor)}</strong>
                      <small>
                        {source.source_key === statementDetail.statement.id
                          ? "эта ведомость"
                          : "отдельный источник"}
                      </small>
                    </article>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="studio-form-section">
              <header>
                <strong>Начисления за занятия</strong>
                <span>
                  Каждая строка привязана к реальному закрытому занятию.
                </span>
              </header>
              <div className="payroll-lesson-list">
                {statementDetail.lessons.map((lesson) => (
                  <article key={lesson.accrual_id}>
                    <div>
                      <strong>{lesson.lesson_name}</strong>
                      <span>
                        {new Date(lesson.starts_at).toLocaleString("ru-RU")}
                        {lesson.program_name
                          ? " · " + lesson.program_name
                          : ""}
                      </span>
                    </div>
                    <div>
                      <span>{lesson.attended_count} чел.</span>
                      <small>
                        База {money(lesson.eligible_revenue_minor)}
                      </small>
                    </div>
                    <strong>{money(lesson.amount_minor)}</strong>
                  </article>
                ))}
                {!statementDetail.lessons.length ? (
                  <div className="studio-empty">
                    <strong>Нет построчных начислений</strong>
                    <p>
                      Ведомость могла состоять только из постоянной части или
                      гарантии.
                    </p>
                  </div>
                ) : null}
              </div>
            </div>

            {statementDetail.adjustments.length ? (
              <div className="studio-form-section">
                <header>
                  <strong>Ручные корректировки</strong>
                  <span>Сохраняются отдельно от формулы.</span>
                </header>
                <div className="statement-adjustments">
                  {statementDetail.adjustments.map((item) => (
                    <small key={item.id}>
                      {money(item.amount_minor)} · {item.reason}
                    </small>
                  ))}
                </div>
              </div>
            ) : null}
          </StudioModal>
        ) : null}

        {paymentModal && currentPayrollBatch ? (
          <StudioModal
            eyebrow="Payroll"
            title="Зарегистрировать выплату"
            description="Это отдельный финансовый шаг после утверждения расчёта. Ведомости тренеров получат статус «Оплачено» только после регистрации выплаты."
            onClose={()=>setPaymentModal(false)}
            footer={
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={()=>setPaymentModal(false)}
                >
                  Отмена
                </button>
                <button
                  disabled={pending}
                  type="button"
                  onClick={()=>void registerPayrollPayment()}
                >
                  {pending?"Сохраняем…":"Подтвердить выплату"}
                </button>
              </>
            }
          >
            <div className="studio-form-grid">
              <label>
                <span>Дата выплаты</span>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={(event)=>setPaymentDate(event.target.value)}
                />
              </label>
              <label>
                <span>Номер платёжного поручения / референс</span>
                <input
                  value={paymentReference}
                  placeholder="Необязательно"
                  onChange={(event)=>setPaymentReference(event.target.value)}
                />
              </label>
            </div>
            <label>
              <span>Комментарий</span>
              <input
                value={paymentNote}
                placeholder="Например: выплачено на карты сотрудников"
                onChange={(event)=>setPaymentNote(event.target.value)}
              />
            </label>
          </StudioModal>
        ) : null}

        {profileModal ? (
          <StudioModal
            eyebrow="Условия тренера"
            title="Оклад и минимальная гарантия"
            description="Постоянная часть хранится отдельно от процентов и ставок по занятиям. Поэтому несколько услуг или групп не удваивают оклад."
            onClose={() => setProfileModal(false)}
            footer={
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setProfileModal(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void saveProfile()}
                >
                  {pending ? "Сохраняем…" : "Сохранить условия"}
                </button>
              </>
            }
          >
            <div className="studio-form-section">
              <header>
                <strong>Кому задаём условия</strong>
                <span>
                  Эти значения применяются один раз к итоговой ведомости
                  тренера за месяц.
                </span>
              </header>
              <label>
                <span>Тренер</span>
                <select
                  value={profileTrainerId}
                  onChange={(event) => {
                    const id=event.target.value;
                    const existing=profileByTrainer.get(id);
                    setProfileTrainerId(id);
                    setProfileMonthlyRub(
                      existing
                        ? String(Number(existing.monthly_base_minor)/100)
                        : "0"
                    );
                    setProfileDailyRub(
                      existing
                        ? String(Number(existing.daily_base_minor)/100)
                        : "0"
                    );
                    setProfileGuaranteeRub(
                      existing
                        ? String(
                            Number(existing.minimum_guarantee_minor)/100
                          )
                        : "0"
                    );
                    setProfileNote(existing?.note ?? "");
                  }}
                >
                  <option value="">Выберите тренера</option>
                  {trainers.map((trainer) => (
                    <option key={trainer.id} value={trainer.id}>
                      {trainer.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="studio-form-section">
              <header>
                <strong>Постоянная часть</strong>
                <span>
                  Можно использовать месячный оклад, дневную ставку или оба
                  варианта. Ноль означает, что компонент не используется.
                </span>
              </header>
              <div className="studio-form-grid">
                <label>
                  <span>Оклад в месяц, ₽</span>
                  <input
                    inputMode="decimal"
                    value={profileMonthlyRub}
                    onChange={(event) =>
                      setProfileMonthlyRub(event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Фикс за рабочий день, ₽</span>
                  <input
                    inputMode="decimal"
                    value={profileDailyRub}
                    onChange={(event) =>
                      setProfileDailyRub(event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Минимальная гарантия за месяц, ₽</span>
                  <input
                    inputMode="decimal"
                    value={profileGuaranteeRub}
                    onChange={(event) =>
                      setProfileGuaranteeRub(event.target.value)
                    }
                  />
                </label>
              </div>
              <label>
                <span>Комментарий</span>
                <input
                  value={profileNote}
                  onChange={(event) => setProfileNote(event.target.value)}
                  placeholder="Например: оклад администратора направления"
                />
              </label>
            </div>
          </StudioModal>
        ) : null}

        {adjustmentModal && adjustmentStatement ? (
          <StudioModal
            eyebrow="Корректировка зарплаты"
            title={adjustmentStatement.trainer_name}
            description={
              "Итог до корректировки: " +
              money(adjustmentStatement.total_minor) +
              ". Изменение попадёт в ведомость и затем в payroll."
            }
            onClose={() => setAdjustmentModal(false)}
            footer={
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setAdjustmentModal(false)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void saveAdjustment()}
                >
                  {pending ? "Сохраняем…" : "Применить"}
                </button>
              </>
            }
          >
            <div className="studio-form-section">
              <header>
                <strong>Что меняем</strong>
                <span>
                  Все ручные изменения сохраняются отдельно от автоматического
                  расчёта, поэтому исходная формула зарплаты остаётся прозрачной.
                </span>
              </header>
              <div className="studio-choice-grid">
                {[
                  ["BONUS", "Премия", "Добавить к зарплате"],
                  ["DEDUCTION", "Удержание", "Уменьшить итог"],
                  ["CORRECTION", "Корректировка", "Исправление расчёта"],
                  ["OTHER", "Другое", "Иная согласованная выплата"]
                ].map(([value, label, hint]) => (
                  <button
                    key={value}
                    type="button"
                    className={
                      "studio-choice " +
                      (adjustmentType === value ? "active" : "")
                    }
                    onClick={() =>
                      setAdjustmentType(
                        value as typeof adjustmentType
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
                  <span>Сумма, ₽</span>
                  <input
                    inputMode="decimal"
                    value={adjustmentRub}
                    onChange={(event) =>
                      setAdjustmentRub(event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>Причина</span>
                  <input
                    value={adjustmentReason}
                    onChange={(event) =>
                      setAdjustmentReason(event.target.value)
                    }
                    placeholder="Например: премия за мастер-класс"
                  />
                </label>
              </div>
            </div>
          </StudioModal>
        ) : null}

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
              <div className="studio-form-grid">
                <label>
                  <span>Направление</span>
                  <select
                    value={planProgramId}
                    onChange={(event) => {
                      setPlanProgramId(event.target.value);
                      setPlanGroupId("");
                    }}
                  >
                    <option value="">Все направления</option>
                    {programs.map((program) => (
                      <option key={program.id} value={program.id}>
                        {program.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Группа</span>
                  <select
                    value={planGroupId}
                    onChange={(event) => setPlanGroupId(event.target.value)}
                  >
                    <option value="">Все группы</option>
                    {groups
                      .filter((group) =>
                        !planProgramId || group.program_id === planProgramId
                      )
                      .map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  <span>Филиал</span>
                  <select
                    value={planBranchId}
                    onChange={(event) => setPlanBranchId(event.target.value)}
                  >
                    <option value="">Все филиалы</option>
                    {branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="studio-form-note">
                Чем точнее правило, тем выше его приоритет: группа → направление
                → услуга → тип занятия → общее правило тренера.
              </p>
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
              {["FIXED","HOURLY","ATTENDEE","COMPOSITE"].includes(planScheme) ? (
                <label>
                  <span>
                    {planScheme === "HOURLY"
                      ? "Ставка за час, ₽"
                      : planScheme === "COMPOSITE"
                        ? planBasePeriod === "DAY"
                          ? "Фикс за рабочий день, ₽"
                          : "Оклад в месяц, ₽"
                        : planScheme === "ATTENDEE"
                          ? "Фикс за занятие, ₽"
                          : "Сумма за занятие, ₽"}
                  </span>
                  <input
                    inputMode="decimal"
                    value={planBaseRub}
                    onChange={(event) => setPlanBaseRub(event.target.value)}
                  />
                </label>
              ) : null}

              {(planScheme === "PERCENT" ||
                (planScheme === "COMPOSITE" &&
                  planVariableType === "PERCENT")) ? (
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

              {planScheme === "COMPOSITE" ? (
                <label>
                  <span>Минимальная гарантия в месяц, ₽</span>
                  <input
                    inputMode="decimal"
                    value={planGuaranteeRub}
                    onChange={(event) => setPlanGuaranteeRub(event.target.value)}
                  />
                </label>
              ) : null}
            </div>
          </StudioModal>
        ) : null}

      </section>
    </main>
  );
}
