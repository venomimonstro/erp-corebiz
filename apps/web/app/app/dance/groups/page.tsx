"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Program = {
  id: string;
  name: string;
  service_id: string;
  service_name: string | null;
  min_age: number | null;
  max_age: number | null;
  default_duration_minutes: number;
};

type Group = {
  id: string;
  name: string;
  program_id: string;
  program_name: string;
  service_id: string;
  trainer_resource_id: string;
  trainer_name: string | null;
  room_resource_id: string | null;
  room_name: string | null;
  capacity: number;
  break_even_members: number;
  members: number;
  waitlist: number;
  status: string;
};

type Lesson = {
  id: string;
  group_id: string | null;
  group_name: string | null;
  program_name: string | null;
  lesson_type: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: string;
  trainer_name: string | null;
  room_name: string | null;
  booked_count: number;
  attended_count: number;
  waitlist: number;
  version: number;
  earned_revenue_minor: string | null;
  trainer_cost_minor: string | null;
  room_cost_minor: string | null;
  contribution_margin_minor: string | null;
};

type Student = {
  id: string;
  party_id: string;
  display_name: string;
  status: string;
};

type Resource = {
  id: string;
  name: string;
  type: string;
};

type Service = {
  id: string;
  name: string;
  duration_minutes: number;
};

type Participant = {
  id: string;
  student_id: string;
  student_name: string;
  package_id: string | null;
  status: string;
  price_source: string;
  charge_minor: string;
  currency: string;
  version: number;
  package_name: string | null;
};

type Roster = {
  members: Array<{
    id: string;
    student_id: string;
    student_name: string;
    status: string;
    payer_name: string | null;
    discount_bps?: number;
    reserved_place?: boolean;
  }>;
  waitlist: Array<{
    id: string;
    student_id: string;
    student_name: string;
    status: string;
    enrollment_status?: string;
    discount_bps?: number;
  }>;
};

type MakeupCredit = {
  id: string;
  student_id: string;
  student_name: string;
  expires_at: string;
  program_name: string | null;
  group_name: string | null;
  status: string;
};

type Pack = {
  id: string;
  party_id: string;
  beneficiary_party_ids?: string[];
  plan_name: string;
  available_visits: number | null;
  expires_at: string;
  status: string;
};

function money(value: string | null) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value ?? "0") / 100);
}

function dateInput(daysFromNow = 0) {
  const date = new Date(Date.now() + daysFromNow * 86400000);
  return date.toISOString().slice(0, 10);
}

export default function DanceGroupsPage() {
  const [programs, setPrograms] = useState<Program[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [packages, setPackages] = useState<Pack[]>([]);
  const [makeupCredits, setMakeupCredits] = useState<MakeupCredit[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedLessonId, setSelectedLessonId] = useState("");
  const [roster, setRoster] = useState<Roster | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const from = new Date(Date.now() - 7 * 86400000).toISOString();
    const to = new Date(Date.now() + 45 * 86400000).toISOString();
    try {
      const [programRows, groupRows, lessonRows, studentRows, resourceRows, serviceRows, packageRows, makeupRows] =
        await Promise.all([
          apiRequest<Program[]>("/dance/programs"),
          apiRequest<Group[]>("/dance/groups"),
          apiRequest<Lesson[]>(
            "/dance/lessons?from=" + encodeURIComponent(from) + "&to=" + encodeURIComponent(to)
          ),
          apiRequest<Student[]>("/dance/students"),
          apiRequest<Resource[]>("/service/resources"),
          apiRequest<Service[]>("/service/catalog"),
          apiRequest<Pack[]>("/service/packages"),
          apiRequest<MakeupCredit[]>("/dance/makeup-credits")
        ]);
      setPrograms(programRows);
      setGroups(groupRows);
      setLessons(lessonRows);
      setStudents(studentRows);
      setResources(resourceRows);
      setServices(serviceRows);
      setPackages(packageRows);
      setMakeupCredits(makeupRows);
      setSelectedGroupId((current) =>
        groupRows.some((item) => item.id === current) ? current : groupRows[0]?.id ?? ""
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить группы");
    }
  }, []);

  const loadRoster = useCallback(async (groupId: string) => {
    if (!groupId) {
      setRoster(null);
      return;
    }
    try {
      setRoster(await apiRequest<Roster>(`/dance/groups/${groupId}/members`));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить состав группы");
    }
  }, []);

  const loadParticipants = useCallback(async (lessonId: string) => {
    if (!lessonId) {
      setParticipants([]);
      return;
    }
    try {
      setParticipants(
        await apiRequest<Participant[]>(`/dance/lessons/${lessonId}/participants`)
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить журнал");
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadRoster(selectedGroupId); }, [selectedGroupId, loadRoster]);
  useEffect(() => { void loadParticipants(selectedLessonId); }, [selectedLessonId, loadParticipants]);

  const selectedGroup = groups.find((item) => item.id === selectedGroupId) ?? null;
  const selectedLesson = lessons.find((item) => item.id === selectedLessonId) ?? null;
  const trainers = resources.filter((item) => item.type === "EMPLOYEE");
  const rooms = resources.filter((item) => ["ROOM", "HALL", "WORKPLACE"].includes(item.type));
  const upcoming = useMemo(
    () => lessons.filter((lesson) => new Date(lesson.ends_at).getTime() >= Date.now()),
    [lessons]
  );

  async function createProgram() {
    if (!services.length) {
      setError("Сначала создайте услугу занятия");
      return;
    }
    const name = window.prompt("Направление", "Hip-Hop");
    if (!name?.trim()) return;
    const serviceList = services.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const serviceIndex = Number(window.prompt("Услуга для направления:\n" + serviceList, "1")) - 1;
    const service = services[serviceIndex];
    if (!service) return;
    const minAge = Number(window.prompt("Возраст от", "6") ?? "6");
    const maxAge = Number(window.prompt("Возраст до", "17") ?? "17");

    try {
      await apiRequest("/dance/programs", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          serviceId: service.id,
          minAge,
          maxAge,
          defaultDurationMinutes: service.duration_minutes
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать направление");
    }
  }

  async function createGroup() {
    if (!programs.length || !trainers.length) {
      setError("Нужны направление и тренер");
      return;
    }
    const programList = programs.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const program = programs[Number(window.prompt("Направление:\n" + programList, "1")) - 1];
    if (!program) return;

    const trainerList = trainers.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const trainer = trainers[Number(window.prompt("Тренер:\n" + trainerList, "1")) - 1];
    if (!trainer) return;

    const roomList = rooms.map((item, index) => `${index + 1}. ${item.name}`).join("\n");
    const roomRaw = roomList ? window.prompt("Зал:\n" + roomList, "1") : null;
    const room = roomRaw ? rooms[Number(roomRaw) - 1] : undefined;

    const name = window.prompt("Название группы", program.name + " · группа")?.trim();
    if (!name) return;
    const capacity = Number(window.prompt("Вместимость", "14") ?? "14");
    const breakEven = Number(window.prompt("Точка безубыточности, учеников", "5") ?? "5");
    const scheduleRaw =
      window.prompt(
        "Расписание через запятую: день=HH:MM. 1=Пн ... 7=Вс",
        "1=18:00,3=18:00"
      ) ?? "";
    const schedule = scheduleRaw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [weekdayRaw, timeRaw] = item.split("=");
        const weekday = Number(weekdayRaw);
        const [hours, minutes] = String(timeRaw ?? "").split(":").map(Number);
        return {
          weekday,
          startMinute: hours * 60 + minutes,
          durationMinutes: program.default_duration_minutes
        };
      });
    if (
      !schedule.length ||
      schedule.some(
        (slot) =>
          !Number.isInteger(slot.weekday) ||
          slot.weekday < 1 ||
          slot.weekday > 7 ||
          !Number.isFinite(slot.startMinute) ||
          slot.startMinute < 0 ||
          slot.startMinute > 1439
      )
    ) {
      setError("Некорректное недельное расписание");
      return;
    }

    try {
      await apiRequest("/dance/groups", {
        method: "POST",
        body: JSON.stringify({
          programId: program.id,
          name,
          trainerResourceId: trainer.id,
          roomResourceId: room?.id,
          capacity,
          breakEvenMembers: breakEven,
          schedule
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать группу");
    }
  }

  async function createGroupPackage() {
    if (!selectedGroup) return;
    const name =
      window.prompt(
        "Название тарифа",
        "Абонемент · " + selectedGroup.name
      )?.trim();
    if (!name) return;

    const scope = (
      window.prompt(
        "Ограничение: GROUP = только эта группа, PROGRAM = всё направление",
        "GROUP"
      ) ?? "GROUP"
    ).trim().toUpperCase();
    if (!["GROUP", "PROGRAM"].includes(scope)) {
      setError("Неизвестное ограничение тарифа");
      return;
    }

    const kind = (
      window.prompt("Тип: VISITS, PERIOD или UNLIMITED", "VISITS") ?? "VISITS"
    ).trim().toUpperCase();
    if (!["VISITS", "PERIOD", "UNLIMITED"].includes(kind)) {
      setError("Неизвестный тип тарифа");
      return;
    }

    const visits =
      kind === "UNLIMITED"
        ? undefined
        : Number(window.prompt("Количество занятий", "8") ?? "8");
    const days = Number(window.prompt("Срок, дней", "30") ?? "30");
    const priceRub = Number(
      (window.prompt("Цена, ₽", "6000") ?? "0").replace(",", ".")
    );
    const visitValueRub = Number(
      (
        window.prompt(
          "Управленческая реализация одного посещения, ₽",
          kind === "UNLIMITED"
            ? "700"
            : String(priceRub / Math.max(visits ?? 1, 1))
        ) ?? "0"
      ).replace(",", ".")
    );

    if (
      (kind !== "UNLIMITED" &&
        (!Number.isSafeInteger(visits) || Number(visits) < 1)) ||
      !Number.isSafeInteger(days) ||
      days < 1 ||
      !Number.isFinite(priceRub) ||
      priceRub < 0 ||
      !Number.isFinite(visitValueRub) ||
      visitValueRub < 0
    ) {
      setError("Некорректные параметры тарифа");
      return;
    }

    try {
      await apiRequest("/service/package-plans", {
        method: "POST",
        body: JSON.stringify({
          name,
          packageKind: kind,
          visitLimit: visits,
          durationDays: days,
          priceMinor: String(Math.round(priceRub * 100)),
          managementVisitValueMinor: String(
            Math.round(visitValueRub * 100)
          ),
          applicableServiceId: selectedGroup.service_id,
          danceProgramId: selectedGroup.program_id,
          danceGroupId:
            scope === "GROUP" ? selectedGroup.id : undefined,
          noShowPolicy: "CONSUME",
          activationPolicy: "FULL_PAYMENT",
          freezeDaysAllowed: 7,
          makeupDaysValid: 14,
          allowMakeup: true
        })
      });
      window.alert("Тариф создан");
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось создать тариф"
      );
    }
  }

  async function addMember() {
    if (!selectedGroup || !students.length) return;
    const list = students.map((item, index) => `${index + 1}. ${item.display_name}`).join("\n");
    const student = students[Number(window.prompt("Ученик:\n" + list, "1")) - 1];
    if (!student) return;
    const allowWaitlist = window.confirm("Если группа заполнена — поставить в лист ожидания?");
    const discountPercent = Number(
      (window.prompt("Персональная/семейная скидка, %", "0") ?? "0")
        .replace(",", ".")
    );
    if (
      !Number.isFinite(discountPercent) ||
      discountPercent < 0 ||
      discountPercent > 100
    ) {
      setError("Скидка должна быть от 0 до 100%");
      return;
    }

    try {
      await apiRequest(`/dance/groups/${selectedGroup.id}/members`, {
        method: "POST",
        body: JSON.stringify({
          studentId: student.id,
          status: "ACTIVE",
          discountBps: Math.round(discountPercent * 100),
          allowWaitlist
        })
      });
      await load();
      await loadRoster(selectedGroup.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось добавить ученика");
    }
  }

  async function syncRoster() {
    if (!selectedGroup) return;
    setPending(true);
    try {
      const result = await apiRequest<{
        lessons: number;
        enrolled: number;
        already: number;
        waitlisted: number;
      }>(`/dance/groups/${selectedGroup.id}/sync-roster`, {
        method: "POST"
      });
      window.alert(
        `Синхронизировано уроков: ${result.lessons}. Новых записей: ${result.enrolled}, waitlist: ${result.waitlisted}.`
      );
      await load();
      await loadRoster(selectedGroup.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось синхронизировать состав"
      );
    } finally {
      setPending(false);
    }
  }

  async function changeMember(
    member: Roster["members"][number],
    status: "ACTIVE" | "PAUSED" | "LEFT"
  ) {
    if (!selectedGroup) return;
    let keepPlace: boolean | undefined;
    if (status === "PAUSED") {
      keepPlace = window.confirm(
        "Сохранить место в группе на время паузы? OK = сохранить, Отмена = освободить."
      );
    }
    if (
      status === "LEFT" &&
      !window.confirm("Вывести ученика из группы и снять будущие записи?")
    ) {
      return;
    }

    try {
      const result = await apiRequest<{
        promoted?: { student_id?: string } | null;
      }>(
        `/dance/groups/${selectedGroup.id}/members/${member.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ status, keepPlace })
        }
      );
      if (result.promoted) {
        window.alert("Свободное место передано первому ученику из листа ожидания.");
      }
      await load();
      await loadRoster(selectedGroup.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось изменить участие"
      );
    }
  }

  async function generateLessons() {
    if (!selectedGroup) return;
    const from = window.prompt("Создать занятия с", dateInput(0));
    if (!from) return;
    const to = window.prompt("По", dateInput(35));
    if (!to) return;

    setPending(true);
    try {
      const result = await apiRequest<{ created: unknown[]; skipped: unknown[] }>(
        `/dance/groups/${selectedGroup.id}/lessons/generate`,
        { method: "POST", body: JSON.stringify({ from, to }) }
      );
      window.alert(`Создано: ${result.created.length}, пропущено: ${result.skipped.length}`);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать серию занятий");
    } finally {
      setPending(false);
    }
  }

  async function createIndividualLesson() {
    if (!services.length || !trainers.length || !students.length) return;
    const service = services[
      Number(window.prompt(
        "Услуга:\n" + services.map((item, i) => `${i + 1}. ${item.name}`).join("\n"),
        "1"
      )) - 1
    ];
    const trainer = trainers[
      Number(window.prompt(
        "Тренер:\n" + trainers.map((item, i) => `${i + 1}. ${item.name}`).join("\n"),
        "1"
      )) - 1
    ];
    const student = students[
      Number(window.prompt(
        "Ученик:\n" + students.map((item, i) => `${i + 1}. ${item.display_name}`).join("\n"),
        "1"
      )) - 1
    ];
    if (!service || !trainer || !student) return;

    const startsAt = window.prompt(
      "Начало ISO или YYYY-MM-DDTHH:MM",
      new Date(Date.now() + 86400000).toISOString().slice(0, 16)
    );
    if (!startsAt) return;
    const room = rooms.length
      ? rooms[Number(window.prompt(
          "Зал:\n" + rooms.map((item, i) => `${i + 1}. ${item.name}`).join("\n"),
          "1"
        )) - 1]
      : undefined;
    const chargeRub = Number((window.prompt("Стоимость урока, ₽", "2500") ?? "0").replace(",", "."));

    try {
      const lesson = await apiRequest<{ id: string }>("/dance/lessons", {
        method: "POST",
        body: JSON.stringify({
          lessonType: "INDIVIDUAL",
          serviceId: service.id,
          trainerResourceId: trainer.id,
          roomResourceId: room?.id,
          startsAt: new Date(startsAt).toISOString(),
          durationMinutes: service.duration_minutes,
          capacity: 1,
          idempotencyKey: crypto.randomUUID()
        })
      });
      const studentPackages = packages.filter(
        (pack) =>
          pack.status === "ACTIVE" &&
          (
            pack.party_id === student.party_id ||
            pack.beneficiary_party_ids?.includes(student.party_id)
          )
      );
      const studentMakeups = makeupCredits.filter(
        (credit) =>
          credit.student_id === student.id &&
          credit.status === "AVAILABLE" &&
          new Date(credit.expires_at).getTime() >=
            new Date(startsAt).getTime()
      );
      let makeupCreditId: string | undefined;
      if (
        studentMakeups.length &&
        window.confirm("Использовать доступную отработку?")
      ) {
        const credit = studentMakeups[
          Number(
            window.prompt(
              "Отработка:\n" +
                studentMakeups
                  .map(
                    (item, i) =>
                      `${i + 1}. до ${new Date(item.expires_at).toLocaleDateString("ru-RU")} · ${item.program_name ?? "любое направление"}`
                  )
                  .join("\n"),
              "1"
            )
          ) - 1
        ];
        makeupCreditId = credit?.id;
      }

      let packageId: string | undefined;
      if (
        !makeupCreditId &&
        studentPackages.length &&
        window.confirm("Использовать абонемент ученика?")
      ) {
        const pack = studentPackages[
          Number(window.prompt(
            "Абонемент:\n" + studentPackages.map((item, i) =>
              `${i + 1}. ${item.plan_name} · осталось ${item.available_visits === null ? "∞" : item.available_visits}`
            ).join("\n"),
            "1"
          )) - 1
        ];
        packageId = pack?.id;
      }
      await apiRequest(`/dance/lessons/${lesson.id}/participants`, {
        method: "POST",
        body: JSON.stringify({
          studentId: student.id,
          packageId,
          makeupCreditId,
          chargeMinor:
            packageId || makeupCreditId
              ? "0"
              : String(Math.round(chargeRub * 100))
        })
      });
      await load();
      setSelectedLessonId(lesson.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать индивидуальный урок");
    }
  }

  async function addParticipant() {
    if (!selectedLesson || !students.length) return;
    const student = students[
      Number(window.prompt(
        "Ученик:\n" + students.map((item, i) => `${i + 1}. ${item.display_name}`).join("\n"),
        "1"
      )) - 1
    ];
    if (!student) return;

    const studentMakeups = makeupCredits.filter(
      (credit) =>
        credit.student_id === student.id &&
        credit.status === "AVAILABLE" &&
        new Date(credit.expires_at).getTime() >=
          new Date(selectedLesson.starts_at).getTime()
    );
    let makeupCreditId: string | undefined;
    if (
      studentMakeups.length &&
      window.confirm("Использовать отработку?")
    ) {
      const credit = studentMakeups[
        Number(
          window.prompt(
            "Отработка:\n" +
              studentMakeups
                .map(
                  (item, i) =>
                    `${i + 1}. до ${new Date(item.expires_at).toLocaleDateString("ru-RU")} · ${item.program_name ?? "любое направление"}`
                )
                .join("\n"),
            "1"
          )
        ) - 1
      ];
      makeupCreditId = credit?.id;
    }

    const studentPackages = packages.filter(
      (pack) => pack.party_id === student.party_id && pack.status === "ACTIVE"
    );
    let packageId: string | undefined;
    if (
      !makeupCreditId &&
      studentPackages.length &&
      window.confirm("Списать занятие из абонемента?")
    ) {
      const pack = studentPackages[
        Number(window.prompt(
          "Абонемент:\n" + studentPackages.map((item, i) =>
            `${i + 1}. ${item.plan_name} · ${item.available_visits === null ? "∞" : item.available_visits}`
          ).join("\n"),
          "1"
        )) - 1
      ];
      packageId = pack?.id;
    }
    const chargeRub = packageId || makeupCreditId
      ? 0
      : Number((window.prompt("Стоимость разового занятия, ₽", "0") ?? "0").replace(",", "."));

    try {
      await apiRequest(`/dance/lessons/${selectedLesson.id}/participants`, {
        method: "POST",
        body: JSON.stringify({
          studentId: student.id,
          packageId,
          makeupCreditId,
          chargeMinor: String(Math.round(chargeRub * 100)),
          allowWaitlist: true
        })
      });
      await loadParticipants(selectedLesson.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось записать ученика");
    }
  }

  async function attendance(participant: Participant, status: string) {
    if (!selectedLesson) return;
    try {
      await apiRequest(
        `/dance/lessons/${selectedLesson.id}/participants/${participant.id}/attendance`,
        {
          method: "PATCH",
          body: JSON.stringify({ status, version: participant.version })
        }
      );
      await loadParticipants(selectedLesson.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отметить посещение");
    }
  }

  async function editLesson() {
    if (!selectedLesson) return;

    const currentStart = new Date(selectedLesson.starts_at)
      .toISOString()
      .slice(0, 16);
    const startsAtRaw = window.prompt(
      "Новое начало YYYY-MM-DDTHH:MM",
      currentStart
    );
    if (!startsAtRaw) return;

    const trainer = trainers[
      Number(
        window.prompt(
          "Тренер:\n" +
            trainers.map((item, i) => `${i + 1}. ${item.name}`).join("\n"),
          String(
            Math.max(
              1,
              trainers.findIndex((item) => item.name === selectedLesson.trainer_name) + 1
            )
          )
        )
      ) - 1
    ];
    if (!trainer) return;

    let roomId: string | null | undefined;
    if (rooms.length) {
      const roomChoice = window.prompt(
        "Зал (0 = без зала):\n0. Без зала\n" +
          rooms.map((item, i) => `${i + 1}. ${item.name}`).join("\n"),
        String(
          Math.max(
            0,
            rooms.findIndex((item) => item.name === selectedLesson.room_name) + 1
          )
        )
      );
      if (roomChoice === null) return;
      const roomIndex = Number(roomChoice);
      roomId = roomIndex === 0 ? null : rooms[roomIndex - 1]?.id;
    }

    const capacity = Number(
      window.prompt("Вместимость", String(selectedLesson.capacity)) ??
        String(selectedLesson.capacity)
    );
    const durationMinutes = Math.max(
      5,
      Math.round(
        (new Date(selectedLesson.ends_at).getTime() -
          new Date(selectedLesson.starts_at).getTime()) /
          60000
      )
    );

    try {
      const updated = await apiRequest<{ version: number }>(
        `/dance/lessons/${selectedLesson.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            startsAt: new Date(startsAtRaw).toISOString(),
            durationMinutes,
            trainerResourceId: trainer.id,
            roomResourceId: roomId,
            capacity,
            version: selectedLesson.version
          })
        }
      );
      await load();
      setSelectedLessonId(selectedLesson.id);
      if (updated.version) {
        await loadParticipants(selectedLesson.id);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось изменить занятие"
      );
    }
  }

  async function completeLesson() {
    if (!selectedLesson) return;
    try {
      await apiRequest(`/dance/lessons/${selectedLesson.id}/complete`, {
        method: "POST"
      });
      await load();
      await loadParticipants(selectedLesson.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось закрыть занятие");
    }
  }

  async function cancelLesson() {
    if (!selectedLesson) return;
    const reason = window.prompt("Причина отмены", "Отмена студией");
    if (!reason) return;
    try {
      await apiRequest(`/dance/lessons/${selectedLesson.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отменить занятие");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="dance-groups" />
      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Студия / Операции</p>
            <h1>Группы и уроки</h1>
            <p className="workspace-summary">
              Постоянные группы, серии занятий, вместимость, waitlist и журнал посещаемости.
            </p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={() => void createProgram()} type="button">+ Направление</button>
            <button className="secondary-button" onClick={() => void createGroup()} type="button">+ Группа</button>
            <button onClick={() => void createIndividualLesson()} type="button">+ Индивидуальный урок</button>
          </div>
        </header>

        {error ? <div className="inline-error"><strong>Группы</strong><span>{error}</span></div> : null}

        <section className="section-block">
          <div className="section-heading"><div><p className="muted">Постоянные группы</p><h2>Загрузка</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Группа</th><th>Тренер</th><th>Зал</th><th>Участники</th><th>Break-even</th><th>Waitlist</th><th></th></tr></thead>
              <tbody>
                {groups.map((group) => (
                  <tr key={group.id}>
                    <td><strong>{group.name}</strong><small>{group.program_name}</small></td>
                    <td>{group.trainer_name ?? "—"}</td>
                    <td>{group.room_name ?? "—"}</td>
                    <td>{group.members}/{group.capacity}</td>
                    <td>{group.break_even_members}</td>
                    <td>{group.waitlist}</td>
                    <td><button className="secondary-button" onClick={() => setSelectedGroupId(group.id)} type="button">Открыть</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {selectedGroup ? (
          <section className="settings-card">
            <div className="section-heading">
              <div><p className="muted">Состав группы</p><h2>{selectedGroup.name}</h2></div>
              <div className="header-actions">
                <button className="secondary-button" onClick={() => void addMember()} type="button">+ Ученик</button>
                <button className="secondary-button" onClick={() => void createGroupPackage()} type="button">+ Тариф группы</button>
                <button className="secondary-button" disabled={pending} onClick={() => void syncRoster()} type="button">Синхронизировать состав</button>
                <button disabled={pending} onClick={() => void generateLessons()} type="button">Создать занятия</button>
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Ученик</th><th>Статус</th><th>Плательщик</th><th>Скидка</th><th></th></tr></thead>
                <tbody>
                  {roster?.members.map((member) => (
                    <tr key={member.id}>
                      <td><strong>{member.student_name}</strong></td>
                      <td>{member.status}</td>
                      <td>{member.payer_name ?? "—"}</td>
                      <td>{((member.discount_bps ?? 0) / 100).toLocaleString("ru-RU")}%</td>
                      <td className="table-actions">
                        {member.status !== "ACTIVE" ? (
                          <button onClick={() => void changeMember(member, "ACTIVE")} type="button">Вернуть</button>
                        ) : null}
                        {member.status === "ACTIVE" ? (
                          <button className="secondary-button" onClick={() => void changeMember(member, "PAUSED")} type="button">Пауза</button>
                        ) : null}
                        {member.status !== "LEFT" ? (
                          <button className="secondary-button" onClick={() => void changeMember(member, "LEFT")} type="button">Вывести</button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {roster?.waitlist.map((member) => (
                    <tr key={"w-" + member.id}>
                      <td><strong>{member.student_name}</strong></td>
                      <td>WAITLIST → {member.enrollment_status ?? "ACTIVE"}</td>
                      <td>ожидает место</td>
                      <td>{((member.discount_bps ?? 0) / 100).toLocaleString("ru-RU")}%</td>
                      <td>Автопереход при освобождении места</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className="section-block">
          <div className="section-heading"><div><p className="muted">Календарь</p><h2>Предстоящие занятия</h2></div></div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Дата</th><th>Занятие</th><th>Тренер / зал</th><th>Запись</th><th>Экономика</th><th></th></tr></thead>
              <tbody>
                {upcoming.map((lesson) => (
                  <tr key={lesson.id}>
                    <td><strong>{new Date(lesson.starts_at).toLocaleString("ru-RU")}</strong></td>
                    <td>{lesson.group_name ?? lesson.lesson_type}<small>{lesson.status}</small></td>
                    <td>{lesson.trainer_name ?? "—"}<small>{lesson.room_name ?? "без зала"}</small></td>
                    <td>{lesson.booked_count}/{lesson.capacity}<small>пришло {lesson.attended_count} · wait {lesson.waitlist}</small></td>
                    <td>{lesson.contribution_margin_minor !== null ? money(lesson.contribution_margin_minor) : "После закрытия"}</td>
                    <td><button className="secondary-button" onClick={() => setSelectedLessonId(lesson.id)} type="button">Журнал</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {selectedLesson ? (
          <section className="settings-card">
            <div className="section-heading">
              <div>
                <p className="muted">Журнал занятия</p>
                <h2>{selectedLesson.group_name ?? selectedLesson.lesson_type} · {new Date(selectedLesson.starts_at).toLocaleString("ru-RU")}</h2>
              </div>
              <div className="header-actions">
                <button className="secondary-button" onClick={() => void addParticipant()} type="button">+ Ученик</button>
                {!["COMPLETED","CANCELLED_BY_STUDIO","CANCELLED_BY_TRAINER"].includes(selectedLesson.status) ? (
                  <>
                    <button className="secondary-button" onClick={() => void editLesson()} type="button">Перенести / заменить</button>
                    <button className="secondary-button" onClick={() => void cancelLesson()} type="button">Отменить</button>
                    <button onClick={() => void completeLesson()} type="button">Закрыть урок</button>
                  </>
                ) : null}
              </div>
            </div>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead><tr><th>Ученик</th><th>Оплата</th><th>Статус</th><th>Отметить</th></tr></thead>
                <tbody>
                  {participants.map((participant) => (
                    <tr key={participant.id}>
                      <td><strong>{participant.student_name}</strong></td>
                      <td>{participant.package_name ?? money(participant.charge_minor)}<small>{participant.price_source}</small></td>
                      <td><span className="status-pill">{participant.status}</span></td>
                      <td className="table-actions">
                        {selectedLesson.status !== "COMPLETED" ? (
                          <>
                            <button onClick={() => void attendance(participant, "ATTENDED")} type="button">Пришёл</button>
                            <button className="secondary-button" onClick={() => void attendance(participant, "NO_SHOW")} type="button">No-show</button>
                            <button className="secondary-button" onClick={() => void attendance(participant, "EXCUSED_ABSENCE")} type="button">Уважит.</button>
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {!participants.length ? <tr><td colSpan={4}><div className="table-empty"><strong>Никто не записан</strong></div></td></tr> : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
