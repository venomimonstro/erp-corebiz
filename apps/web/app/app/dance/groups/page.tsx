"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { DanceWorkspaceNav } from "../../../../components/dance-workspace-nav";
import { StudioModal } from "../../../../components/studio-modal";
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
  room_zone_id: string | null;
  room_zone_name: string | null;
  room_capacity_units: number;
  capacity: number;
  break_even_members: number;
  members: number;
  waitlist: number;
  status: string;
  version: number;
  schedule: Array<{weekday:number;startMinute:number;durationMinutes?:number;}>;
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
  trainer_resource_id: string | null;
  trainer_name: string | null;
  room_resource_id: string | null;
  room_name: string | null;
  room_zone_id: string | null;
  room_zone_name: string | null;
  room_capacity_units: number;
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
  const [zones, setZones] = useState<Record<string, Zone[]>>({});
  const zoneRequests=useRef(new Set<string>());
  const [groupSearch,setGroupSearch]=useState("");
  const [lessonFilter,setLessonFilter]=useState<"OPEN"|"TODAY"|"WEEK"|"ALL">("OPEN");
  const [services, setServices] = useState<Service[]>([]);
  const [packages, setPackages] = useState<Pack[]>([]);
  const [makeupCredits, setMakeupCredits] = useState<MakeupCredit[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedLessonId, setSelectedLessonId] = useState("");
  const [roster, setRoster] = useState<Roster | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [programModal, setProgramModal] = useState(false);
  const [programName, setProgramName] = useState("Hip-Hop");
  const [programServiceId, setProgramServiceId] = useState("");
  const [programMinAge, setProgramMinAge] = useState("6");
  const [programMaxAge, setProgramMaxAge] = useState("17");
  const [groupModal, setGroupModal] = useState(false);
  const [editingGroupId, setEditingGroupId] = useState("");
  const [groupProgramId, setGroupProgramId] = useState("");
  const [groupTrainerId, setGroupTrainerId] = useState("");
  const [groupRoomId, setGroupRoomId] = useState("");
  const [groupRoomZoneId, setGroupRoomZoneId] = useState("");
  const [groupRoomCapacityUnits, setGroupRoomCapacityUnits] = useState("1");
  const [groupName, setGroupName] = useState("");
  const [groupCapacity, setGroupCapacity] = useState("14");
  const [groupBreakEven, setGroupBreakEven] = useState("5");
  const [groupDays, setGroupDays] = useState<number[]>([1,3]);
  const [groupTime, setGroupTime] = useState("18:00");
  const [memberModal, setMemberModal] = useState(false);
  const [memberStudentId, setMemberStudentId] = useState("");
  const [memberDiscount, setMemberDiscount] = useState("0");
  const [memberWaitlist, setMemberWaitlist] = useState(true);
  const [generateModal, setGenerateModal] = useState(false);
  const [generateFrom, setGenerateFrom] = useState(dateInput(0));
  const [generateTo, setGenerateTo] = useState(dateInput(35));
  const [groupPackageModal, setGroupPackageModal] = useState(false);
  const [groupPackageName, setGroupPackageName] = useState("");
  const [groupPackageScope, setGroupPackageScope] = useState<"GROUP"|"PROGRAM">("GROUP");
  const [groupPackageKind, setGroupPackageKind] = useState<"VISITS"|"PERIOD"|"UNLIMITED">("VISITS");
  const [groupPackageVisits, setGroupPackageVisits] = useState("8");
  const [groupPackageDays, setGroupPackageDays] = useState("30");
  const [groupPackagePrice, setGroupPackagePrice] = useState("6000");
  const [groupPackageVisitValue, setGroupPackageVisitValue] = useState("750");

  const [participantModal, setParticipantModal] = useState(false);
  const [participantStudentId, setParticipantStudentId] = useState("");
  const [participantPaymentMode, setParticipantPaymentMode] = useState<"DIRECT"|"PACKAGE"|"MAKEUP">("DIRECT");
  const [participantPackageId, setParticipantPackageId] = useState("");
  const [participantMakeupId, setParticipantMakeupId] = useState("");
  const [participantChargeRub, setParticipantChargeRub] = useState("0");

  const [editLessonModal, setEditLessonModal] = useState(false);
  const [editStartsAt, setEditStartsAt] = useState("");
  const [editTrainerId, setEditTrainerId] = useState("");
  const [editRoomId, setEditRoomId] = useState("");
  const [editRoomZoneId, setEditRoomZoneId] = useState("");
  const [editRoomCapacityUnits, setEditRoomCapacityUnits] = useState("1");
  const [editCapacity, setEditCapacity] = useState("1");

  const [cancelLessonModal, setCancelLessonModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("Отмена студией");
  const [lessonModal, setLessonModal] = useState<
    "INDIVIDUAL" | "SELF_PRACTICE" | null
  >(null);
  const [lessonStudentId, setLessonStudentId] = useState("");
  const [lessonServiceId, setLessonServiceId] = useState("");
  const [lessonTrainerId, setLessonTrainerId] = useState("");
  const [lessonRoomId, setLessonRoomId] = useState("");
  const [lessonRoomZoneId, setLessonRoomZoneId] = useState("");
  const [lessonRoomCapacityUnits, setLessonRoomCapacityUnits] = useState("1");
  const [lessonStartsAt, setLessonStartsAt] = useState(new Date(Date.now() + 86400000).toISOString().slice(0, 16));
  const [lessonChargeRub, setLessonChargeRub] = useState("");
  const [lessonPackageId, setLessonPackageId] = useState("");

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

  // Room zones are only requested when an editor actually needs them.
  // A studio with 150 rooms should not create 150 network calls on page open.
  useEffect(()=>{
    const ids=[
      groupModal?groupRoomId:"",
      lessonModal?lessonRoomId:"",
      editLessonModal?editRoomId:""
    ].filter(Boolean);
    for(const roomId of new Set(ids)){
      if(zoneRequests.current.has(roomId))continue;
      zoneRequests.current.add(roomId);
      void apiRequest<Zone[]>("/service/resources/"+roomId+"/zones")
        .then(items=>setZones(current=>({...current,[roomId]:items})))
        .catch(e=>{
          zoneRequests.current.delete(roomId);
          setError(e instanceof Error?e.message:"Не удалось загрузить зоны зала");
        });
    }
  },[groupModal,groupRoomId,lessonModal,lessonRoomId,editLessonModal,editRoomId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadRoster(selectedGroupId); }, [selectedGroupId, loadRoster]);
  useEffect(() => { void loadParticipants(selectedLessonId); }, [selectedLessonId, loadParticipants]);

  const selectedGroup = groups.find((item) => item.id === selectedGroupId) ?? null;
  const selectedLesson = lessons.find((item) => item.id === selectedLessonId) ?? null;
  const trainers = resources.filter((item) => item.type === "EMPLOYEE");
  const rooms = resources.filter((item) => ["ROOM", "HALL", "WORKPLACE"].includes(item.type));
  const filteredGroups=useMemo(()=>{
    const query=groupSearch.trim().toLocaleLowerCase("ru-RU");
    return query?groups.filter(group=>
      [group.name,group.program_name,group.trainer_name??"",group.room_name??""]
        .some(value=>value.toLocaleLowerCase("ru-RU").includes(query))):groups;
  },[groups,groupSearch]);
  const upcoming=useMemo(()=>{
    const now=Date.now();
    const day=new Date().toDateString();
    const weekEnd=now+7*86400000;
    return lessons.filter(lesson=>{
      const start=new Date(lesson.starts_at).getTime();
      const end=new Date(lesson.ends_at).getTime();
      const closed=["COMPLETED","CANCELLED_BY_STUDIO","CANCELLED_BY_TRAINER"]
        .includes(lesson.status);
      if(lessonFilter==="OPEN")return !closed&&end<now;
      if(lessonFilter==="TODAY")return new Date(start).toDateString()===day;
      if(lessonFilter==="WEEK")return start>=now&&start<weekEnd;
      return true;
    }).sort((a,b)=>Date.parse(a.starts_at)-Date.parse(b.starts_at));
  },[lessons,lessonFilter]);

  function openProgramModal() {
    if (!services.length) {
      setError("Сначала создайте услугу занятия");
      return;
    }
    setProgramName("Hip-Hop");
    setProgramServiceId(services[0]?.id ?? "");
    setProgramMinAge("6");
    setProgramMaxAge("17");
    setProgramModal(true);
  }

  async function createProgram() {
    const service=services.find((item)=>item.id===programServiceId);
    const minAge=Number(programMinAge);
    const maxAge=Number(programMaxAge);
    if(!programName.trim()||!service){
      setError("Укажите название и услугу направления");
      return;
    }
    if(
      !Number.isSafeInteger(minAge)||!Number.isSafeInteger(maxAge)||
      minAge<0||maxAge<minAge||maxAge>120
    ){
      setError("Проверьте возраст участников");
      return;
    }
    setPending(true);setError("");setNotice("");
    try{
      await apiRequest("/dance/programs",{
        method:"POST",
        body:JSON.stringify({
          name:programName.trim(),
          serviceId:service.id,
          minAge,maxAge,
          defaultDurationMinutes:service.duration_minutes
        })
      });
      setProgramModal(false);
      setNotice("Направление создано.");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать направление");
    }finally{setPending(false);}
  }

  function openGroupModal() {
    if(!programs.length||!trainers.length){
      setError("Сначала создайте направление и добавьте тренера");
      return;
    }
    const program=programs[0]!;
    setEditingGroupId("");
    setGroupProgramId(program.id);
    setGroupTrainerId(trainers[0]?.id??"");
    setGroupRoomId(rooms[0]?.id??"");
    setGroupRoomZoneId("");
    setGroupRoomCapacityUnits("1");
    setGroupName(program.name+" · группа");
    setGroupCapacity("14");
    setGroupBreakEven("5");
    setGroupDays([1,3]);
    setGroupTime("18:00");
    setGroupModal(true);
  }

  function openEditGroupModal() {
    if(!selectedGroup)return;
    const firstSlot=selectedGroup.schedule?.[0];
    const minutes=firstSlot?.startMinute??18*60;
    setEditingGroupId(selectedGroup.id);
    setGroupProgramId(selectedGroup.program_id);
    setGroupTrainerId(selectedGroup.trainer_resource_id);
    setGroupRoomId(selectedGroup.room_resource_id??"");
    setGroupRoomZoneId(selectedGroup.room_zone_id??"");
    setGroupRoomCapacityUnits(String(selectedGroup.room_capacity_units??1));
    setGroupName(selectedGroup.name);
    setGroupCapacity(String(selectedGroup.capacity));
    setGroupBreakEven(String(selectedGroup.break_even_members));
    setGroupDays(
      selectedGroup.schedule?.length
        ?Array.from(new Set(selectedGroup.schedule.map(item=>item.weekday))).sort((a,b)=>a-b)
        :[1,3]
    );
    setGroupTime(
      String(Math.floor(minutes/60)).padStart(2,"0")+":"+
      String(minutes%60).padStart(2,"0")
    );
    setGroupModal(true);
  }

  function toggleGroupDay(day:number){
    setGroupDays((current)=>
      current.includes(day)
        ?current.filter((item)=>item!==day)
        :[...current,day].sort((x,y)=>x-y)
    );
  }

  async function createGroup() {
    const program=programs.find((item)=>item.id===groupProgramId);
    const trainer=trainers.find((item)=>item.id===groupTrainerId);
    const capacity=Number(groupCapacity);
    const breakEven=Number(groupBreakEven);
    const roomUnits=Number(groupRoomCapacityUnits);
    const [hours,minutes]=groupTime.split(":").map(Number);
    const startMinute=hours*60+minutes;
    if(!program||!trainer||!groupName.trim()){
      setError("Выберите направление, тренера и название группы");
      return;
    }
    if(
      !Number.isSafeInteger(capacity)||capacity<1||capacity>500||
      !Number.isSafeInteger(breakEven)||breakEven<1||breakEven>capacity||
      !Number.isSafeInteger(roomUnits)||roomUnits<1||
      !groupDays.length||!Number.isFinite(startMinute)||startMinute<0||startMinute>1439
    ){
      setError("Проверьте вместимость, break-even и расписание");
      return;
    }
    setPending(true);setError("");setNotice("");
    try{
      const payload={
        name:groupName.trim(),
        trainerResourceId:trainer.id,
        roomResourceId:groupRoomId||null,
        roomZoneId:groupRoomZoneId||null,
        roomCapacityUnits:groupRoomId?roomUnits:1,
        capacity,
        breakEvenMembers:breakEven,
        schedule:groupDays.map((weekday)=>({
          weekday,
          startMinute,
          durationMinutes:program.default_duration_minutes
        }))
      };
      if(editingGroupId){
        const current=groups.find(item=>item.id===editingGroupId);
        if(!current) throw new Error("Группа для изменения не найдена");
        const result=await apiRequest<{future_lessons_unchanged:number}>(
          `/dance/groups/${editingGroupId}`,
          {method:"PATCH",body:JSON.stringify({...payload,version:current.version})}
        );
        setNotice(
          "Шаблон группы обновлён. Уже созданные будущие занятия не изменены: "+
          result.future_lessons_unchanged+
          ". Новые серии используют новые настройки."
        );
      }else{
        await apiRequest("/dance/groups",{
          method:"POST",
          body:JSON.stringify({
            programId:program.id,...payload,
            roomResourceId:groupRoomId||undefined,
            roomZoneId:groupRoomZoneId||undefined,
            roomCapacityUnits:groupRoomId?roomUnits:undefined
          })
        });
        setNotice("Группа создана. Добавьте учеников и создайте занятия.");
      }
      setGroupModal(false);
      setEditingGroupId("");
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать группу");
    }finally{setPending(false);}
  }

  function openGroupPackageModal() {
    if(!selectedGroup)return;
    setGroupPackageName("Абонемент · "+selectedGroup.name);
    setGroupPackageScope("GROUP");
    setGroupPackageKind("VISITS");
    setGroupPackageVisits("8");
    setGroupPackageDays("30");
    setGroupPackagePrice("6000");
    setGroupPackageVisitValue("750");
    setGroupPackageModal(true);
  }

  async function createGroupPackage() {
    if(!selectedGroup)return;
    const visits=
      groupPackageKind==="UNLIMITED"
        ?undefined
        :Number(groupPackageVisits);
    const days=Number(groupPackageDays);
    const priceRub=Number(groupPackagePrice.replace(",","."));
    const visitValueRub=Number(groupPackageVisitValue.replace(",","."));
    if(
      !groupPackageName.trim()||
      (groupPackageKind!=="UNLIMITED"&&(!Number.isSafeInteger(visits)||Number(visits)<1))||
      !Number.isSafeInteger(days)||days<1||
      !Number.isFinite(priceRub)||priceRub<0||
      !Number.isFinite(visitValueRub)||visitValueRub<0
    ){
      setError("Проверьте параметры тарифа");
      return;
    }
    setPending(true);setError("");setNotice("");
    try{
      await apiRequest("/service/package-plans",{
        method:"POST",
        body:JSON.stringify({
          name:groupPackageName.trim(),
          packageKind:groupPackageKind,
          visitLimit:visits,
          durationDays:days,
          priceMinor:String(Math.round(priceRub*100)),
          managementVisitValueMinor:String(Math.round(visitValueRub*100)),
          applicableServiceId:selectedGroup.service_id,
          danceProgramId:selectedGroup.program_id,
          danceGroupId:groupPackageScope==="GROUP"?selectedGroup.id:undefined,
          noShowPolicy:"CONSUME",
          activationPolicy:"FULL_PAYMENT",
          freezeDaysAllowed:7,
          makeupDaysValid:14,
          allowMakeup:true
        })
      });
      setGroupPackageModal(false);
      setNotice("Тариф группы создан.");
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать тариф");
    }finally{setPending(false);}
  }

  function openMemberModal() {
    if(!selectedGroup||!students.length){
      setError("Нет выбранной группы или учеников");
      return;
    }
    setMemberStudentId(students[0]?.id??"");
    setMemberDiscount("0");
    setMemberWaitlist(true);
    setMemberModal(true);
  }

  async function addMember() {
    if(!selectedGroup||!memberStudentId)return;
    const discountPercent=Number(memberDiscount.replace(",","."));
    if(!Number.isFinite(discountPercent)||discountPercent<0||discountPercent>100){
      setError("Скидка должна быть от 0 до 100%");
      return;
    }
    setPending(true);setError("");setNotice("");
    try{
      await apiRequest(`/dance/groups/${selectedGroup.id}/members`,{
        method:"POST",
        body:JSON.stringify({
          studentId:memberStudentId,
          status:"ACTIVE",
          discountBps:Math.round(discountPercent*100),
          allowWaitlist:memberWaitlist
        })
      });
      setMemberModal(false);
      setNotice("Ученик добавлен в группу.");
      await load();
      await loadRoster(selectedGroup.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось добавить ученика");
    }finally{setPending(false);}
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
      setNotice(
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
        setNotice("Свободное место передано первому ученику из листа ожидания.");
      }
      await load();
      await loadRoster(selectedGroup.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось изменить участие"
      );
    }
  }

  function openGenerateModal() {
    if(!selectedGroup)return;
    setGenerateFrom(dateInput(0));
    setGenerateTo(dateInput(35));
    setGenerateModal(true);
  }

  async function generateLessons() {
    if(!selectedGroup)return;
    if(!generateFrom||!generateTo||generateTo<generateFrom){
      setError("Проверьте период создания занятий");
      return;
    }
    setPending(true);setError("");setNotice("");
    try{
      const result=await apiRequest<{created:unknown[];skipped:unknown[]}>(
        `/dance/groups/${selectedGroup.id}/lessons/generate`,
        {method:"POST",body:JSON.stringify({from:generateFrom,to:generateTo})}
      );
      setGenerateModal(false);
      setNotice(
        `Создано занятий: ${result.created.length}. Уже существовало/пропущено: ${result.skipped.length}.`
      );
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось создать серию занятий");
    }finally{setPending(false);}
  }

  function openLessonModal(
    type: "INDIVIDUAL" | "SELF_PRACTICE"
  ) {
    setLessonModal(type);
    setLessonStudentId((current) => current || students[0]?.id || "");
    setLessonServiceId((current) => current || services[0]?.id || "");
    setLessonTrainerId(
      type === "SELF_PRACTICE"
        ? ""
        : (current) => current || trainers[0]?.id || ""
    );
    setLessonRoomId((current) => current || rooms[0]?.id || "");
    setLessonRoomZoneId("");
    setLessonRoomCapacityUnits("1");
    setLessonPackageId("");
    setLessonChargeRub("");
  }

  async function createStandaloneLesson() {
    const student=students.find((item)=>item.id===lessonStudentId);
    const service=services.find((item)=>item.id===lessonServiceId);
    const trainer=trainers.find((item)=>item.id===lessonTrainerId);
    const room=rooms.find((item)=>item.id===lessonRoomId);
    const roomCapacityUnits=Number(lessonRoomCapacityUnits);
    if(!lessonModal||!student||!service){
      setError("Выберите ученика и услугу");
      return;
    }
    if(lessonModal==="INDIVIDUAL"&&!trainer){
      setError("Для индивидуального занятия выберите тренера");
      return;
    }
    if(lessonModal==="SELF_PRACTICE"&&!room){
      setError("Для самостоятельной практики выберите зал");
      return;
    }
    if(
      room &&
      (
        !Number.isSafeInteger(roomCapacityUnits)||
        roomCapacityUnits<1||
        roomCapacityUnits>room.capacity
      )
    ){
      setError("Проверьте занимаемую вместимость зала");
      return;
    }
    const selectedZone=(zones[lessonRoomId]??[]).find(
      (zone)=>zone.id===lessonRoomZoneId
    );
    if(
      selectedZone &&
      roomCapacityUnits>selectedZone.capacity_units
    ){
      setError("Занимаемая вместимость больше выбранной зоны");
      return;
    }
    const startDate=new Date(lessonStartsAt);
    if(Number.isNaN(startDate.getTime())){
      setError("Проверьте дату и время");
      return;
    }
    const manualCharge=lessonChargeRub.trim();
    const chargeRub=manualCharge
      ? Number(manualCharge.replace(",","."))
      : null;
    if(chargeRub!==null&&(!Number.isFinite(chargeRub)||chargeRub<0)){
      setError("Проверьте стоимость занятия");
      return;
    }

    setPending(true);
    setError("");
    try{
      const lesson=await apiRequest<{id:string}>("/dance/lessons",{
        method:"POST",
        body:JSON.stringify({
          lessonType:lessonModal,
          serviceId:service.id,
          trainerResourceId:lessonModal==="INDIVIDUAL"?trainer?.id:undefined,
          roomResourceId:room?.id,
          roomZoneId:lessonRoomZoneId||undefined,
          roomCapacityUnits:room?roomCapacityUnits:undefined,
          startsAt:startDate.toISOString(),
          durationMinutes:service.duration_minutes,
          capacity:1,
          idempotencyKey:crypto.randomUUID()
        })
      });

      await apiRequest(`/dance/lessons/${lesson.id}/participants`,{
        method:"POST",
        body:JSON.stringify({
          studentId:student.id,
          packageId:lessonPackageId||undefined,
          chargeMinor:lessonPackageId
            ?"0"
            :chargeRub===null
              ?undefined
              :String(Math.round(chargeRub*100))
        })
      });

      setLessonModal(null);
      await load();
      setSelectedLessonId(lesson.id);
    }catch(cause){
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать занятие"
      );
    }finally{
      setPending(false);
    }
  }

  function openParticipantModal() {
    if(!selectedLesson||!students.length)return;
    const first=students[0];
    setParticipantStudentId(first?.id??"");
    setParticipantPaymentMode("DIRECT");
    setParticipantPackageId("");
    setParticipantMakeupId("");
    setParticipantChargeRub("0");
    setParticipantModal(true);
  }

  async function addParticipant() {
    if(!selectedLesson||!participantStudentId)return;
    const chargeRub=Number(participantChargeRub.replace(",","."));
    if(
      participantPaymentMode==="DIRECT" &&
      (!Number.isFinite(chargeRub)||chargeRub<0)
    ){
      setError("Проверьте стоимость разового занятия");
      return;
    }

    setPending(true);setError("");setNotice("");
    try{
      await apiRequest(`/dance/lessons/${selectedLesson.id}/participants`,{
        method:"POST",
        body:JSON.stringify({
          studentId:participantStudentId,
          packageId:
            participantPaymentMode==="PACKAGE"
              ?participantPackageId||undefined
              :undefined,
          makeupCreditId:
            participantPaymentMode==="MAKEUP"
              ?participantMakeupId||undefined
              :undefined,
          chargeMinor:
            participantPaymentMode==="DIRECT"
              ?String(Math.round(chargeRub*100))
              :"0",
          allowWaitlist:true
        })
      });
      setParticipantModal(false);
      setNotice("Ученик записан на занятие.");
      await loadParticipants(selectedLesson.id);
      await load();
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось записать ученика");
    }finally{setPending(false);}
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

  function openEditLessonModal() {
    if(!selectedLesson)return;
    setEditStartsAt(
      new Date(selectedLesson.starts_at).toISOString().slice(0,16)
    );
    setEditTrainerId(selectedLesson.trainer_resource_id??"");
    setEditRoomId(selectedLesson.room_resource_id??"");
    setEditRoomZoneId(selectedLesson.room_zone_id??"");
    setEditRoomCapacityUnits(
      String(selectedLesson.room_capacity_units??1)
    );
    setEditCapacity(String(selectedLesson.capacity));
    setEditLessonModal(true);
  }

  async function editLesson() {
    if(!selectedLesson)return;
    const start=new Date(editStartsAt);
    const capacity=Number(editCapacity);
    const roomCapacityUnits=Number(editRoomCapacityUnits);
    const room=rooms.find((item)=>item.id===editRoomId);
    const zone=(zones[editRoomId]??[]).find(
      (item)=>item.id===editRoomZoneId
    );
    if(Number.isNaN(start.getTime())||!Number.isSafeInteger(capacity)||capacity<1){
      setError("Проверьте дату, время и вместимость");
      return;
    }
    if(
      room &&
      (
        !Number.isSafeInteger(roomCapacityUnits)||
        roomCapacityUnits<1||
        roomCapacityUnits>room.capacity||
        (zone&&roomCapacityUnits>zone.capacity_units)
      )
    ){
      setError("Проверьте долю или зону зала");
      return;
    }
    const durationMinutes=Math.max(
      5,
      Math.round(
        (new Date(selectedLesson.ends_at).getTime()-
          new Date(selectedLesson.starts_at).getTime())/60000
      )
    );
    setPending(true);setError("");setNotice("");
    try{
      const updated=await apiRequest<{version:number}>(
        `/dance/lessons/${selectedLesson.id}`,
        {
          method:"PATCH",
          body:JSON.stringify({
            startsAt:start.toISOString(),
            durationMinutes,
            trainerResourceId:
              selectedLesson.lesson_type==="SELF_PRACTICE"
                ? null
                : editTrainerId||null,
            roomResourceId:editRoomId||null,
            roomZoneId:editRoomId ? editRoomZoneId||null : null,
            roomCapacityUnits:editRoomId ? roomCapacityUnits : undefined,
            capacity,
            version:selectedLesson.version
          })
        }
      );
      setEditLessonModal(false);
      setNotice("Занятие обновлено.");
      await load();
      setSelectedLessonId(selectedLesson.id);
      if(updated.version)await loadParticipants(selectedLesson.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось изменить занятие");
    }finally{setPending(false);}
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

  function openCancelLessonModal() {
    if(!selectedLesson)return;
    setCancelReason("Отмена студией");
    setCancelLessonModal(true);
  }

  async function cancelLesson() {
    if(!selectedLesson)return;
    if(cancelReason.trim().length<5){
      setError("Укажите причину отмены");
      return;
    }
    setPending(true);setError("");setNotice("");
    try{
      await apiRequest(`/dance/lessons/${selectedLesson.id}/cancel`,{
        method:"POST",
        body:JSON.stringify({reason:cancelReason.trim()})
      });
      setCancelLessonModal(false);
      setNotice("Занятие отменено. Резервы и открытые начисления обработаны автоматически.");
      await load();
      await loadParticipants(selectedLesson.id);
    }catch(cause){
      setError(cause instanceof Error?cause.message:"Не удалось отменить занятие");
    }finally{setPending(false);}
  }

  return (
    <main className="app-shell">
      <AppSidebar active="dance-groups" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero compact">
          <div>
            <span className="studio-eyebrow">Расписание и посещаемость</span>
            <h1>Группы и занятия</h1>
            <p>
              Недельные группы, индивидуальные занятия, самостоятельная практика,
              waitlist и журнал посещаемости.
            </p>
          </div>
          <div className="studio-hero-actions">
            <button className="secondary-button" onClick={openProgramModal} type="button">+ Направление</button>
            <button className="secondary-button" onClick={openGroupModal} type="button">+ Группа</button>
            <button className="secondary-button" onClick={() => openLessonModal("SELF_PRACTICE")} type="button">+ Практика</button>
            <button onClick={() => openLessonModal("INDIVIDUAL")} type="button">+ Индивидуально</button>
          </div>
        </header>

        <DanceWorkspaceNav active="groups" />

        {error ? <div className="studio-message error"><strong>Группы</strong><span>{error}</span></div> : null}
        {notice ? <div className="studio-message success"><strong>Готово</strong><span>{notice}</span></div> : null}

        <section className="section-block">
          <div className="section-heading">
            <div><p className="muted">Постоянные группы</p><h2>Группы студии</h2></div>
            <input className="dance-list-filter" type="search" aria-label="Найти группу"
              placeholder="Название, направление, тренер…" value={groupSearch}
              onChange={event=>setGroupSearch(event.target.value)}/>
          </div>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead><tr><th>Группа</th><th>Тренер</th><th>Зал</th><th>Участники</th><th>Break-even</th><th>Waitlist</th><th></th></tr></thead>
              <tbody>
                {filteredGroups.map((group) => (
                  <tr key={group.id}>
                    <td><strong>{group.name}</strong><small>{group.program_name}</small></td>
                    <td>{group.trainer_name ?? "—"}</td>
                    <td>
                      {group.room_name ?? "—"}
                      <small>
                        {group.room_zone_name ? group.room_zone_name+" · " : ""}
                        {group.room_resource_id ? group.room_capacity_units+" ед." : ""}
                      </small>
                    </td>
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
                <button className="secondary-button" onClick={openEditGroupModal} type="button">Настройки группы</button>
                <button className="secondary-button" onClick={openMemberModal} type="button">+ Ученик</button>
                <button className="secondary-button" onClick={openGroupPackageModal} type="button">+ Тариф группы</button>
                <button className="secondary-button" disabled={pending} onClick={() => void syncRoster()} type="button">Синхронизировать состав</button>
                <button disabled={pending} onClick={openGenerateModal} type="button">Создать занятия</button>
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
          <div className="section-heading">
            <div><p className="muted">Работа с занятиями</p><h2>Расписание и журналы</h2></div>
            <div className="dance-list-tabs" role="group" aria-label="Фильтр занятий">
              {[
                ["OPEN","Нужно закрыть"],["TODAY","Сегодня"],
                ["WEEK","7 дней"],["ALL","Все"]
              ].map(([key,label])=>
                <button key={key} type="button" aria-pressed={lessonFilter===key}
                  className={lessonFilter===key?"active":""}
                  onClick={()=>setLessonFilter(key as typeof lessonFilter)}>{label}</button>)}
            </div>
          </div>
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
                {!upcoming.length?<tr><td colSpan={6}>
                  <div className="table-empty"><strong>Занятий по этому фильтру нет</strong>
                    <span>Попробуйте вкладку «Сегодня» или «Все».</span></div>
                </td></tr>:null}
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
                <button className="secondary-button" onClick={openParticipantModal} type="button">+ Ученик</button>
                {!["COMPLETED","CANCELLED_BY_STUDIO","CANCELLED_BY_TRAINER"].includes(selectedLesson.status) ? (
                  <>
                    <button className="secondary-button" onClick={openEditLessonModal} type="button">Перенести / заменить</button>
                    <button className="secondary-button" onClick={openCancelLessonModal} type="button">Отменить</button>
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
        {groupPackageModal && selectedGroup ? (
          <StudioModal
            eyebrow="Тариф группы"
            title={"Абонемент · " + selectedGroup.name}
            description="Быстрый тариф уже будет привязан к услуге и направлению выбранной группы."
            onClose={() => setGroupPackageModal(false)}
            footer={
              <>
                <a className="secondary-button" href="/app/service/packages">Расширенный конструктор</a>
                <button disabled={pending} type="button" onClick={() => void createGroupPackage()}>{pending ? "Сохраняем…" : "Создать тариф"}</button>
              </>
            }
          >
            <label><span>Название</span><input value={groupPackageName} onChange={(event)=>setGroupPackageName(event.target.value)} /></label>
            <div className="studio-form-grid">
              <label>
                <span>Действует</span>
                <select value={groupPackageScope} onChange={(event)=>setGroupPackageScope(event.target.value as "GROUP"|"PROGRAM")}>
                  <option value="GROUP">Только эта группа</option>
                  <option value="PROGRAM">Всё направление</option>
                </select>
              </label>
              <label>
                <span>Тип</span>
                <select value={groupPackageKind} onChange={(event)=>setGroupPackageKind(event.target.value as "VISITS"|"PERIOD"|"UNLIMITED")}>
                  <option value="VISITS">Пакет посещений</option>
                  <option value="PERIOD">На период</option>
                  <option value="UNLIMITED">Безлимит</option>
                </select>
              </label>
            </div>
            <div className="studio-form-grid">
              {groupPackageKind!=="UNLIMITED" ? (
                <label><span>Посещений</span><input type="number" min="1" value={groupPackageVisits} onChange={(event)=>setGroupPackageVisits(event.target.value)} /></label>
              ) : (
                <div className="package-unlimited-note"><strong>Безлимит</strong><span>Общий счётчик посещений не ограничивается.</span></div>
              )}
              <label><span>Срок, дней</span><input type="number" min="1" value={groupPackageDays} onChange={(event)=>setGroupPackageDays(event.target.value)} /></label>
            </div>
            <div className="studio-form-grid">
              <label><span>Цена, ₽</span><input inputMode="decimal" value={groupPackagePrice} onChange={(event)=>setGroupPackagePrice(event.target.value)} /></label>
              <label><span>Реализация посещения, ₽</span><input inputMode="decimal" value={groupPackageVisitValue} onChange={(event)=>setGroupPackageVisitValue(event.target.value)} /></label>
            </div>
          </StudioModal>
        ) : null}

        {participantModal && selectedLesson ? (
          <StudioModal
            eyebrow="Журнал занятия"
            title="Записать ученика"
            description="Выберите ученика и источник оплаты. Абонемент и отработка будут дополнительно проверены backend."
            onClose={() => setParticipantModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setParticipantModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void addParticipant()}>{pending ? "Записываем…" : "Записать"}</button>
              </>
            }
          >
            <label>
              <span>Ученик</span>
              <select
                value={participantStudentId}
                onChange={(event)=>{
                  setParticipantStudentId(event.target.value);
                  setParticipantPackageId("");
                  setParticipantMakeupId("");
                }}
              >
                {students.map((student)=><option key={student.id} value={student.id}>{student.display_name}</option>)}
              </select>
            </label>
            <div className="studio-choice-grid">
              {[
                ["DIRECT","Разовая оплата","Отдельная стоимость занятия"],
                ["PACKAGE","Абонемент","Списать подходящее посещение"],
                ["MAKEUP","Отработка","Использовать доступную компенсацию"]
              ].map(([value,label,hint])=>(
                <button
                  key={value}
                  type="button"
                  className={"studio-choice "+(participantPaymentMode===value?"active":"")}
                  onClick={()=>setParticipantPaymentMode(value as typeof participantPaymentMode)}
                >
                  <strong>{label}</strong><span>{hint}</span>
                </button>
              ))}
            </div>
            {participantPaymentMode==="DIRECT" ? (
              <label><span>Стоимость, ₽</span><input inputMode="decimal" value={participantChargeRub} onChange={(event)=>setParticipantChargeRub(event.target.value)} /></label>
            ) : null}
            {participantPaymentMode==="PACKAGE" ? (
              <label>
                <span>Абонемент</span>
                <select value={participantPackageId} onChange={(event)=>setParticipantPackageId(event.target.value)}>
                  <option value="">Выберите абонемент</option>
                  {packages.filter((pack)=>{
                    const student=students.find((item)=>item.id===participantStudentId);
                    return student&&pack.status==="ACTIVE"&&(
                      pack.party_id===student.party_id||
                      pack.beneficiary_party_ids?.includes(student.party_id)
                    );
                  }).map((pack)=>(
                    <option key={pack.id} value={pack.id}>
                      {pack.plan_name} · осталось {pack.available_visits===null?"∞":pack.available_visits}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {participantPaymentMode==="MAKEUP" ? (
              <label>
                <span>Отработка</span>
                <select value={participantMakeupId} onChange={(event)=>setParticipantMakeupId(event.target.value)}>
                  <option value="">Выберите отработку</option>
                  {makeupCredits.filter((credit)=>
                    credit.student_id===participantStudentId&&
                    credit.status==="AVAILABLE"&&
                    new Date(credit.expires_at).getTime()>=new Date(selectedLesson.starts_at).getTime()
                  ).map((credit)=>(
                    <option key={credit.id} value={credit.id}>
                      до {new Date(credit.expires_at).toLocaleDateString("ru-RU")} · {credit.program_name??"любое направление"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </StudioModal>
        ) : null}

        {editLessonModal && selectedLesson ? (
          <StudioModal
            eyebrow="Занятие"
            title="Перенести или заменить ресурсы"
            description="Backend повторно проверит расписание, вместимость, абонементы, заморозки и конфликты ресурсов."
            onClose={() => setEditLessonModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setEditLessonModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void editLesson()}>{pending ? "Сохраняем…" : "Сохранить"}</button>
              </>
            }
          >
            <div className="studio-form-grid">
              <label><span>Дата и время</span><input type="datetime-local" value={editStartsAt} onChange={(event)=>setEditStartsAt(event.target.value)} /></label>
              <label><span>Вместимость</span><input type="number" min="1" max="500" value={editCapacity} onChange={(event)=>setEditCapacity(event.target.value)} /></label>
            </div>
            <div className="studio-form-grid">
              <label><span>Тренер</span><select value={editTrainerId} onChange={(event)=>setEditTrainerId(event.target.value)} disabled={selectedLesson.lesson_type==="SELF_PRACTICE"}><option value="">Без тренера</option>{trainers.map((trainer)=><option key={trainer.id} value={trainer.id}>{trainer.name}</option>)}</select></label>
              <label>
                <span>Зал</span>
                <select
                  value={editRoomId}
                  onChange={(event)=>{
                    setEditRoomId(event.target.value);
                    setEditRoomZoneId("");
                    setEditRoomCapacityUnits("1");
                  }}
                >
                  <option value="">Без зала</option>
                  {rooms.map((room)=><option key={room.id} value={room.id}>{room.name} · {room.capacity} ед.</option>)}
                </select>
              </label>
            </div>
            {editRoomId ? (
              <div className="studio-form-grid">
                <label>
                  <span>Зона</span>
                  <select
                    value={editRoomZoneId}
                    onChange={(event)=>setEditRoomZoneId(event.target.value)}
                  >
                    <option value="">Без зоны / общий зал</option>
                    {(zones[editRoomId]??[]).map((zone)=>(
                      <option key={zone.id} value={zone.id}>
                        {zone.name} · {zone.capacity_units} ед.
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Занимаемая вместимость</span>
                  <input
                    type="number"
                    min="1"
                    value={editRoomCapacityUnits}
                    onChange={(event)=>setEditRoomCapacityUnits(event.target.value)}
                  />
                </label>
              </div>
            ) : null}
          </StudioModal>
        ) : null}

        {cancelLessonModal && selectedLesson ? (
          <StudioModal
            eyebrow="Отмена занятия"
            title="Отменить занятие"
            description="Резервы абонементов и отработок будут возвращены; открытые разовые начисления будут отменены."
            onClose={() => setCancelLessonModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setCancelLessonModal(false)}>Назад</button>
                <button disabled={pending} type="button" onClick={() => void cancelLesson()}>{pending ? "Отменяем…" : "Отменить занятие"}</button>
              </>
            }
          >
            <label><span>Причина</span><input autoFocus value={cancelReason} onChange={(event)=>setCancelReason(event.target.value)} /></label>
          </StudioModal>
        ) : null}

        {programModal ? (
          <StudioModal
            eyebrow="Направление"
            title="Новое направление"
            description="Направление связывает услугу, длительность и возраст. Затем внутри него создаются группы."
            onClose={() => setProgramModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setProgramModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void createProgram()}>{pending ? "Сохраняем…" : "Создать"}</button>
              </>
            }
          >
            <label><span>Название</span><input autoFocus value={programName} onChange={(event)=>setProgramName(event.target.value)} /></label>
            <label>
              <span>Базовая услуга</span>
              <select value={programServiceId} onChange={(event)=>setProgramServiceId(event.target.value)}>
                <option value="">Выберите услугу</option>
                {services.map((service)=><option key={service.id} value={service.id}>{service.name} · {service.duration_minutes} мин.</option>)}
              </select>
            </label>
            <div className="studio-form-grid">
              <label><span>Возраст от</span><input type="number" min="0" max="120" value={programMinAge} onChange={(event)=>setProgramMinAge(event.target.value)} /></label>
              <label><span>Возраст до</span><input type="number" min="0" max="120" value={programMaxAge} onChange={(event)=>setProgramMaxAge(event.target.value)} /></label>
            </div>
          </StudioModal>
        ) : null}

        {groupModal ? (
          <StudioModal
            eyebrow={editingGroupId ? "Настройки группы" : "Постоянная группа"}
            title={editingGroupId ? "Изменить группу" : "Собрать группу"}
            description={
              editingGroupId
                ? "Меняется шаблон новых серий. Уже созданные занятия не переписываются."
                : "Задайте тренера, зал, вместимость и обычные дни занятий. Серия уроков создаётся отдельно."
            }
            onClose={() => {
              setGroupModal(false);
              setEditingGroupId("");
            }}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => {
                  setGroupModal(false);
                  setEditingGroupId("");
                }}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void createGroup()}>
                  {pending ? "Сохраняем…" : editingGroupId ? "Сохранить настройки" : "Создать группу"}
                </button>
              </>
            }
          >
            <div className="studio-form-grid">
              <label>
                <span>Направление</span>
                <select
                  value={groupProgramId}
                  disabled={Boolean(editingGroupId)}
                  onChange={(event)=>{
                    const id=event.target.value;
                    setGroupProgramId(id);
                    const program=programs.find((item)=>item.id===id);
                    if(program)setGroupName(program.name+" · группа");
                  }}
                >
                  {programs.map((program)=><option key={program.id} value={program.id}>{program.name}</option>)}
                </select>
              </label>
              <label><span>Название группы</span><input value={groupName} onChange={(event)=>setGroupName(event.target.value)} /></label>
            </div>
            <div className="studio-form-grid">
              <label><span>Тренер</span><select value={groupTrainerId} onChange={(event)=>setGroupTrainerId(event.target.value)}>{trainers.map((trainer)=><option key={trainer.id} value={trainer.id}>{trainer.name}</option>)}</select></label>
              <label>
                <span>Зал</span>
                <select
                  value={groupRoomId}
                  onChange={(event)=>{
                    setGroupRoomId(event.target.value);
                    setGroupRoomZoneId("");
                    setGroupRoomCapacityUnits("1");
                  }}
                >
                  <option value="">Без зала</option>
                  {rooms.map((room)=><option key={room.id} value={room.id}>{room.name} · {room.capacity} ед.</option>)}
                </select>
              </label>
            </div>
            {groupRoomId ? (
              <div className="studio-form-grid">
                <label>
                  <span>Зона зала</span>
                  <select
                    value={groupRoomZoneId}
                    onChange={(event)=>{
                      setGroupRoomZoneId(event.target.value);
                      setGroupRoomCapacityUnits("1");
                    }}
                  >
                    <option value="">Общий зал / без зоны</option>
                    {(zones[groupRoomId]??[]).map((zone)=>(
                      <option key={zone.id} value={zone.id}>
                        {zone.name} · {zone.capacity_units} ед.
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Сколько пространства закрепить</span>
                  <input
                    type="number"
                    min="1"
                    max={
                      (zones[groupRoomId]??[]).find(
                        (zone)=>zone.id===groupRoomZoneId
                      )?.capacity_units ??
                      rooms.find((room)=>room.id===groupRoomId)?.capacity ??
                      1
                    }
                    value={groupRoomCapacityUnits}
                    onChange={(event)=>setGroupRoomCapacityUnits(event.target.value)}
                  />
                  <small>Остальная часть зала останется доступна другим занятиям и арендаторам.</small>
                </label>
              </div>
            ) : null}
            <div className="studio-form-grid">
              <label><span>Вместимость группы</span><input type="number" min="1" max="500" value={groupCapacity} onChange={(event)=>setGroupCapacity(event.target.value)} /></label>
              <label><span>Break-even, учеников</span><input type="number" min="1" value={groupBreakEven} onChange={(event)=>setGroupBreakEven(event.target.value)} /></label>
            </div>
            <div className="studio-form-section">
              <header><strong>Недельное расписание</strong><span>Выберите дни и обычное время начала.</span></header>
              <fieldset className="studio-weekdays">
                <legend>Дни недели</legend>
                {[["1","Пн"],["2","Вт"],["3","Ср"],["4","Чт"],["5","Пт"],["6","Сб"],["7","Вс"]].map(([day,label]) => (
                  <button
                    key={day}
                    type="button"
                    className={groupDays.includes(Number(day)) ? "active" : ""}
                    onClick={() => toggleGroupDay(Number(day))}
                  >{label}</button>
                ))}
              </fieldset>
              <label><span>Время начала</span><input type="time" value={groupTime} onChange={(event)=>setGroupTime(event.target.value)} /></label>
            </div>
          </StudioModal>
        ) : null}

        {memberModal && selectedGroup ? (
          <StudioModal
            eyebrow="Состав группы"
            title="Добавить ученика"
            description="Если мест не останется, ученик автоматически попадёт в waitlist с сохранением скидки."
            onClose={() => setMemberModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setMemberModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void addMember()}>{pending ? "Добавляем…" : "Добавить"}</button>
              </>
            }
          >
            <label><span>Ученик</span><select value={memberStudentId} onChange={(event)=>setMemberStudentId(event.target.value)}>{students.map((student)=><option key={student.id} value={student.id}>{student.display_name}</option>)}</select></label>
            <div className="studio-form-grid">
              <label><span>Персональная скидка, %</span><input inputMode="decimal" value={memberDiscount} onChange={(event)=>setMemberDiscount(event.target.value)} /></label>
              <label className="studio-check-row">
                <input type="checkbox" checked={memberWaitlist} onChange={(event)=>setMemberWaitlist(event.target.checked)} />
                <span>Если группа заполнена — поставить в лист ожидания</span>
              </label>
            </div>
          </StudioModal>
        ) : null}

        {generateModal && selectedGroup ? (
          <StudioModal
            eyebrow="Серия занятий"
            title={"Создать уроки · " + selectedGroup.name}
            description="CoreBiz создаст занятия только по недельному расписанию группы и пропустит уже существующие даты."
            onClose={() => setGenerateModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setGenerateModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void generateLessons()}>{pending ? "Создаём…" : "Создать занятия"}</button>
              </>
            }
          >
            <div className="studio-form-grid">
              <label><span>С даты</span><input type="date" value={generateFrom} onChange={(event)=>setGenerateFrom(event.target.value)} /></label>
              <label><span>По дату</span><input type="date" value={generateTo} onChange={(event)=>setGenerateTo(event.target.value)} /></label>
            </div>
          </StudioModal>
        ) : null}

        {lessonModal ? (
          <StudioModal
            eyebrow={lessonModal === "SELF_PRACTICE" ? "Зал без тренера" : "Персональное занятие"}
            title={
              lessonModal === "SELF_PRACTICE"
                ? "Самостоятельная практика"
                : "Индивидуальное занятие"
            }
            description={
              lessonModal === "SELF_PRACTICE"
                ? "Ученик оплачивает время в зале отдельно или использует подходящий абонемент."
                : "Цена и длительность будут уточнены правилами выбранного тренера, если они настроены."
            }
            onClose={() => setLessonModal(null)}
            footer={
              <>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => setLessonModal(null)}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => void createStandaloneLesson()}
                >
                  {pending ? "Создаём…" : "Создать занятие"}
                </button>
              </>
            }
          >
            <div className="studio-form-section">
              <header>
                <strong>Кто и что бронирует</strong>
                <span>Показываем только понятные бизнес-поля.</span>
              </header>
              <div className="studio-form-grid">
                <label>
                  <span>Ученик</span>
                  <select
                    value={lessonStudentId}
                    onChange={(event) => {
                      setLessonStudentId(event.target.value);
                      setLessonPackageId("");
                    }}
                  >
                    <option value="">Выберите ученика</option>
                    {students.map((student) => (
                      <option key={student.id} value={student.id}>
                        {student.display_name}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>Услуга</span>
                  <select
                    value={lessonServiceId}
                    onChange={(event) => setLessonServiceId(event.target.value)}
                  >
                    <option value="">Выберите услугу</option>
                    {services.map((service) => (
                      <option key={service.id} value={service.id}>
                        {service.name}
                      </option>
                    ))}
                  </select>
                </label>

                {lessonModal === "INDIVIDUAL" ? (
                  <label>
                    <span>Тренер</span>
                    <select
                      value={lessonTrainerId}
                      onChange={(event) => setLessonTrainerId(event.target.value)}
                    >
                      <option value="">Выберите тренера</option>
                      {trainers.map((trainer) => (
                        <option key={trainer.id} value={trainer.id}>
                          {trainer.name}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <label>
                  <span>Зал</span>
                  <select
                    value={lessonRoomId}
                    onChange={(event) => {
                      setLessonRoomId(event.target.value);
                      setLessonRoomZoneId("");
                      setLessonRoomCapacityUnits("1");
                    }}
                  >
                    <option value="">Без зала</option>
                    {rooms.map((room) => (
                      <option key={room.id} value={room.id}>
                        {room.name} · {room.capacity} ед.
                      </option>
                    ))}
                  </select>
                </label>

                {lessonRoomId ? (
                  <label>
                    <span>Зона зала</span>
                    <select
                      value={lessonRoomZoneId}
                      onChange={(event) =>
                        setLessonRoomZoneId(event.target.value)
                      }
                    >
                      <option value="">Без зоны / общий зал</option>
                      {(zones[lessonRoomId] ?? []).map((zone) => (
                        <option key={zone.id} value={zone.id}>
                          {zone.name} · {zone.capacity_units} ед.
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {lessonRoomId ? (
                  <label>
                    <span>Сколько пространства занимает</span>
                    <input
                      type="number"
                      min="1"
                      max={
                        (zones[lessonRoomId] ?? []).find(
                          (zone) => zone.id === lessonRoomZoneId
                        )?.capacity_units ??
                        rooms.find((room) => room.id === lessonRoomId)?.capacity ??
                        1
                      }
                      value={lessonRoomCapacityUnits}
                      onChange={(event) =>
                        setLessonRoomCapacityUnits(event.target.value)
                      }
                    />
                    <small>
                      Остальная вместимость останется доступна для другой
                      группы, арендатора или самостоятельной практики.
                    </small>
                  </label>
                ) : null}

                <label>
                  <span>Дата и время</span>
                  <input
                    type="datetime-local"
                    value={lessonStartsAt}
                    onChange={(event) => setLessonStartsAt(event.target.value)}
                  />
                </label>
              </div>
            </div>

            <div className="studio-form-section">
              <header>
                <strong>Как оплатить</strong>
                <span>
                  Если выбран абонемент, CoreBiz сам проверит услугу, тренера,
                  день и время.
                </span>
              </header>
              <div className="studio-form-grid">
                <label>
                  <span>Источник оплаты</span>
                  <select
                    value={lessonPackageId}
                    onChange={(event) => setLessonPackageId(event.target.value)}
                  >
                    <option value="">Разовое занятие</option>
                    {packages
                      .filter((pack) => {
                        const student=students.find(
                          (item)=>item.id===lessonStudentId
                        );
                        return Boolean(
                          student &&
                          pack.status==="ACTIVE" &&
                          (
                            pack.party_id===student.party_id ||
                            pack.beneficiary_party_ids?.includes(student.party_id)
                          )
                        );
                      })
                      .map((pack) => (
                        <option key={pack.id} value={pack.id}>
                          {pack.plan_name} · осталось {
                            pack.available_visits===null
                              ? "∞"
                              : pack.available_visits
                          }
                        </option>
                      ))}
                  </select>
                </label>

                {!lessonPackageId ? (
                  <label>
                    <span>Цена разового занятия, ₽ · необязательно</span>
                    <input
                      inputMode="decimal"
                      value={lessonChargeRub}
                      placeholder="Авто по услуге и тренеру"
                      onChange={(event) => setLessonChargeRub(event.target.value)}
                    />
                  </label>
                ) : null}
              </div>
              <span className="studio-helper">
                Оставьте цену пустой — CoreBiz возьмёт рассчитанную цену занятия.
                Введите сумму только для разового ручного исключения.
              </span>
            </div>
          </StudioModal>
        ) : null}

      </section>
    </main>
  );
}
