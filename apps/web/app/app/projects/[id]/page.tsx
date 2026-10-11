"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Deliverable={
  id:string;title:string;deliverable_type:string;status:string;version:number;
  due_at:string|null;client_approval_required:boolean;approval_note:string|null;
};
type ClientApproval={
  id:string;title:string;request_type:string;status:string;deliverable_id:string|null;
  response_note:string|null;due_at:string|null;evidence_reference:string|null;
  recorded_by_membership_id:string|null;
};


type AgencyTemplate={
  code:string;title:string;description:string;
  steps:Array<{code:string;title:string;offsetDays:number;checklist:string}>;
};
type ProjectStatus = "PLANNED" | "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED";

type ProjectDetail = {
  project: {
    id: string;
    business_number: string;
    name: string;
    status: ProjectStatus;
    billing_mode: string;
    currency: string;
    budget_minor: string;
    hourly_rate_minor: string;
    estimated_minutes: number;
    starts_on: string | null;
    due_on: string | null;
    party_name: string | null;
    notes: string | null;
    version: number;
  };
  milestones: Array<{
    id: string;
    name: string;
    status: "PLANNED" | "IN_PROGRESS" | "DONE" | "CANCELLED";
    due_at: string | null;
    amount_minor: string;
  }>;
  timeEntries: Array<{
    id: string;
    membership_name: string;
    work_date: string;
    minutes: number;
    billable: boolean;
    hourly_rate_minor_snapshot: string;
    note: string | null;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    state: string;
    priority: string;
    due_at: string | null;
  }>;
  metrics: {
    actualMinutes: number;
    billableValueMinor: string;
  };
};

function money(value: string, currency = "RUB"): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

function hours(minutes: number): string {
  return (minutes / 60).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + " ч";
}

export default function ProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const [data, setData] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [templates,setTemplates]=useState<AgencyTemplate[]>([]);
  const [selectedTemplate,setSelectedTemplate]=useState("");
  const [kickoffBusy,setKickoffBusy]=useState(false);
  const [kickoffNote,setKickoffNote]=useState("");
  const [deliverables,setDeliverables]=useState<Deliverable[]>([]);
  const [approvals,setApprovals]=useState<ClientApproval[]>([]);
  const [working,setWorking]=useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      const [details,results,decisions]=await Promise.all([
        apiRequest<ProjectDetail>("/projects/"+projectId),
        apiRequest<Deliverable[]>("/projects/"+projectId+"/deliverables"),
        apiRequest<ClientApproval[]>("/projects/"+projectId+"/approvals")
      ]);
      setData(details);setDeliverables(results);setApprovals(decisions);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить проект");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
    void apiRequest<AgencyTemplate[]>("/projects/agency/templates")
      .then(setTemplates).catch(()=>setTemplates([]));
  }, [load]);

  const progress = useMemo(() => {
    if (!data?.milestones.length) return 0;
    const done = data.milestones.filter((item) => item.status === "DONE").length;
    return Math.round((done / data.milestones.length) * 100);
  }, [data]);

  async function addMilestone() {
    if (!projectId) return;
    const name = window.prompt("Название этапа");
    if (!name?.trim()) return;

    const dueDays = Number(window.prompt("Срок этапа через сколько дней?", "7") ?? "7");
    const amountRub = Number((window.prompt("Стоимость этапа, ₽", "0") ?? "0").replace(",", "."));
    if (!Number.isFinite(dueDays) || !Number.isFinite(amountRub) || amountRub < 0) {
      setError("Некорректные параметры этапа");
      return;
    }

    const dueAt = new Date(Date.now() + Math.max(0, dueDays) * 86400000).toISOString();

    try {
      await apiRequest("/projects/" + projectId + "/milestones", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          dueAt,
          amountMinor: String(Math.round(amountRub * 100))
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать этап");
    }
  }

  async function milestoneStatus(id: string, status: "IN_PROGRESS" | "DONE" | "CANCELLED") {
    if (!projectId) return;
    try {
      await apiRequest("/projects/" + projectId + "/milestones/" + id + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить этап");
    }
  }

  async function addTime() {
    if (!projectId || !data) return;
    if (data.project.status !== "ACTIVE") {
      setError("Сначала переведите проект в ACTIVE");
      return;
    }

    const raw = window.prompt("Сколько часов списать?", "1");
    if (raw === null) return;
    const value = Number(raw.replace(",", "."));
    const minutes = Math.round(value * 60);
    if (!Number.isFinite(value) || minutes < 1 || minutes > 1440) {
      setError("За одну запись можно списать от 1 минуты до 24 часов");
      return;
    }

    const note = window.prompt("Комментарий к работе", "") ?? "";

    try {
      await apiRequest("/projects/" + projectId + "/time-entries", {
        method: "POST",
        body: JSON.stringify({
          minutes,
          billable: true,
          note: note.trim() || undefined,
          idempotencyKey: crypto.randomUUID()
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось списать время");
    }
  }

  async function changeStatus(status: ProjectStatus) {
    if (!projectId || !data) return;
    try {
      await apiRequest("/projects/" + projectId + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status, version: data.project.version })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить статус");
    }
  }


  async function applyTemplate(){
    if(!projectId||!selectedTemplate)return;
    setKickoffBusy(true);setError("");setKickoffNote("");
    try{
      const result=await apiRequest<{applied:boolean;milestones:number}>(
        "/projects/"+projectId+"/kickoff",{
          method:"POST",body:JSON.stringify({templateCode:selectedTemplate})
        }
      );
      setKickoffNote(result.applied
        ?"План работ создан: "+result.milestones+" этапов, результатов и задач."
        :"Этот шаблон уже применён. Дубли не созданы.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось применить шаблон");}
    finally{setKickoffBusy(false);}
  }

  async function addDeliverable(){
    if(!projectId)return;
    const title=window.prompt("Результат для клиента: макет, отчёт, сайт, рекламная кампания");
    if(!title?.trim())return;
    setWorking(true);setError("");
    try{
      await apiRequest("/projects/"+projectId+"/deliverables",{
        method:"POST",body:JSON.stringify({title:title.trim(),clientApprovalRequired:true})
      });
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось создать результат");}
    finally{setWorking(false);}
  }
  async function deliverableStatus(d:Deliverable,status:string){
    if(!projectId)return;
    setWorking(true);setError("");
    try{
      await apiRequest("/projects/"+projectId+"/deliverables/"+d.id+"/status",{
        method:"PATCH",body:JSON.stringify({status,version:d.version})
      });
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось изменить статус результата");}
    finally{setWorking(false);}
  }
  async function requestDeliverableApproval(d:Deliverable){
    if(!projectId)return;
    setWorking(true);setError("");
    try{
      await apiRequest("/projects/"+projectId+"/approvals",{
        method:"POST",body:JSON.stringify({
          title:"Согласовать результат: "+d.title,
          deliverableId:d.id,requestType:"DELIVERABLE"
        })
      });
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось запросить согласование");}
    finally{setWorking(false);}
  }
  async function decideClientApproval(a:ClientApproval,decision:"APPROVED"|"REJECTED"){
    if(!projectId)return;
    const responseNote=window.prompt(
      decision==="APPROVED"?"Как клиент подтвердил результат?":"Причина отказа / замечания клиента"
    );
    if(!responseNote?.trim())return;
    const evidenceReference=decision==="APPROVED"
      ?window.prompt("Ссылка или номер письма/акта с подтверждением клиента"):undefined;
    if(decision==="APPROVED"&&!evidenceReference?.trim())return;
    setWorking(true);setError("");
    try{
      await apiRequest("/projects/"+projectId+"/approvals/"+a.id+"/decision",{
        method:"PATCH",body:JSON.stringify({
          decision,responseNote:responseNote.trim(),
          evidenceReference:evidenceReference?.trim()
        })
      });
      await load();
    }catch(e){setError(e instanceof Error?e.message:"Не удалось записать решение");}
    finally{setWorking(false);}
  }

  return (
    <main className="app-shell">
      <AppSidebar active="projects" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Проекты / {data?.project.business_number ?? "Карточка"}</p>
            <h1>{data?.project.name ?? "Проект"}</h1>
            <p className="workspace-summary">
              {data?.project.party_name ?? "Внутренний проект"} · {data?.project.billing_mode ?? ""}
            </p>
          </div>
          <div className="header-actions">
            <a className="secondary-button" href="/app/projects">Все проекты</a>
            <button onClick={() => void addMilestone()} type="button">+ Этап</button>
            <button onClick={() => void addTime()} type="button">+ Время</button>
            <button onClick={() => void addDeliverable()} type="button">+ Результат</button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем проект…</div> : null}

        {!loading && data ? (
          <>
            <div className="metric-grid">
              <article className="metric-card">
                <span>Бюджет</span>
                <strong>{money(data.project.budget_minor, data.project.currency)}</strong>
                <small>{data.project.billing_mode}</small>
              </article>
              <article className="metric-card">
                <span>Фактическое время</span>
                <strong>{hours(data.metrics.actualMinutes)}</strong>
                <small>оценка {hours(data.project.estimated_minutes)}</small>
              </article>
              <article className="metric-card">
                <span>Биллабельная стоимость</span>
                <strong>{money(data.metrics.billableValueMinor, data.project.currency)}</strong>
                <small>по зафиксированной ставке</small>
              </article>
              <article className="metric-card">
                <span>Готовность этапов</span>
                <strong>{progress}%</strong>
                <small>{data.tasks.filter((task) => !["DONE", "CANCELLED"].includes(task.state)).length} открытых задач</small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Состояние</p>
                  <h2><span className="status-pill">{data.project.status}</span></h2>
                </div>
                <div className="header-actions">
                  {data.project.status === "PLANNED" ? (
                    <button onClick={() => void changeStatus("ACTIVE")} type="button">Начать проект</button>
                  ) : null}
                  {data.project.status === "ACTIVE" ? (
                    <>
                      <button className="secondary-button" onClick={() => void changeStatus("ON_HOLD")} type="button">Пауза</button>
                      <button onClick={() => void changeStatus("COMPLETED")} type="button">Завершить</button>
                    </>
                  ) : null}
                  {data.project.status === "ON_HOLD" ? (
                    <button onClick={() => void changeStatus("ACTIVE")} type="button">Возобновить</button>
                  ) : null}
                </div>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading"><div><p className="muted">Быстрый запуск</p>
                <h2>План проекта из шаблона</h2>
                <p>Этапы, задачи и результаты будут созданы один раз. Сроки отсчитываются от дня запуска и могут корректироваться в задачах.</p>
              </div></div>
              <div className="header-actions">
                <select aria-label="Сценарий проекта" value={selectedTemplate}
                  onChange={e=>{setSelectedTemplate(e.target.value);setKickoffNote("");}}>
                  <option value="">Выберите бизнес-сценарий</option>
                  {templates.map(t=><option key={t.code} value={t.code}>{t.title}</option>)}
                </select>
                <button disabled={!selectedTemplate||kickoffBusy}
                  onClick={()=>void applyTemplate()} type="button">
                  {kickoffBusy?"Создание…":"Создать этапы и задачи"}
                </button>
              </div>
              {kickoffNote?<p role="status">{kickoffNote}</p>:null}
              {templates.filter(t=>t.code===selectedTemplate).map(t=><div key={t.code}>
                <p>{t.description}</p>
                <ol>{t.steps.map(step=><li key={step.code}>
                  <strong>{step.title}</strong> — до {step.offsetDays} дней. {step.checklist}
                </li>)}</ol>
              </div>)}
            </section>
            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Delivery</p>
                  <h2>Этапы</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Этап</th>
                      <th>Сумма</th>
                      <th>Срок</th>
                      <th>Статус</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.milestones.map((item) => (
                      <tr key={item.id}>
                        <td><strong>{item.name}</strong></td>
                        <td>{money(item.amount_minor, data.project.currency)}</td>
                        <td>{item.due_at ? new Date(item.due_at).toLocaleDateString("ru-RU") : "Без срока"}</td>
                        <td><span className="status-pill">{item.status}</span></td>
                        <td className="table-actions">
                          {item.status === "PLANNED" ? (
                            <button className="secondary-button" onClick={() => void milestoneStatus(item.id, "IN_PROGRESS")} type="button">В работу</button>
                          ) : null}
                          {["PLANNED", "IN_PROGRESS"].includes(item.status) ? (
                            <button onClick={() => void milestoneStatus(item.id, "DONE")} type="button">Готово</button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                    {!data.milestones.length ? (
                      <tr><td colSpan={5}><div className="table-empty"><strong>Этапов пока нет</strong><span>Разбейте проект на контролируемые результаты.</span></div></td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading"><div><p className="muted">Сдача работ</p>
                <h2>Результаты и клиентское согласование</h2>
                <p>Подтверждения клиентов записываются менеджером с указанием источника. Это не электронная подпись клиента.</p>
              </div></div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Результат</th><th>Тип</th><th>Статус</th><th>Действие</th></tr></thead>
                  <tbody>
                    {deliverables.map(d=><tr key={d.id}>
                      <td><strong>{d.title}</strong></td><td>{d.deliverable_type}</td>
                      <td><span className="status-pill">{d.status}</span></td>
                      <td className="table-actions">
                        {d.status==="PLANNED"||d.status==="REWORK"?
                          <button disabled={working} onClick={()=>void deliverableStatus(d,"IN_PROGRESS")}>В работу</button>:null}
                        {d.status==="IN_PROGRESS"?
                          <button disabled={working} onClick={()=>void deliverableStatus(d,"INTERNAL_REVIEW")}>На проверку</button>:null}
                        {d.status==="INTERNAL_REVIEW"?
                          <button disabled={working} onClick={()=>void deliverableStatus(d,d.client_approval_required?"CLIENT_REVIEW":"APPROVED")}>
                            {d.client_approval_required?"На согласование":"Принять"}</button>:null}
                        {d.status==="CLIENT_REVIEW"&&!approvals.some(a=>a.deliverable_id===d.id&&a.status==="PENDING")?
                          <button disabled={working} onClick={()=>void requestDeliverableApproval(d)}>Запросить подтверждение</button>:null}
                      </td>
                    </tr>)}
                    {!deliverables.length?<tr><td colSpan={4}>Добавьте первый результат и его этапы сдачи.</td></tr>:null}
                  </tbody>
                </table>
              </div>
              <h3>История согласований</h3>
              <div className="data-table-wrap"><table className="data-table">
                <thead><tr><th>Запрос</th><th>Статус</th><th>Основание / комментарий</th><th>Решение</th></tr></thead>
                <tbody>{approvals.map(a=><tr key={a.id}>
                  <td>{a.title}</td><td><span className="status-pill">{a.status}</span></td>
                  <td>{a.evidence_reference??a.response_note??"Ожидается"}</td>
                  <td className="table-actions">{a.status==="PENDING"?<>
                    <button disabled={working} onClick={()=>void decideClientApproval(a,"APPROVED")}>Подтверждено</button>
                    <button disabled={working} className="secondary-button" onClick={()=>void decideClientApproval(a,"REJECTED")}>Замечания</button>
                  </>:null}</td>
                </tr>)}
                {!approvals.length?<tr><td colSpan={4}>Согласований пока нет.</td></tr>:null}
                </tbody>
              </table></div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Фактическая себестоимость времени</p>
                  <h2>Трудозатраты</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Сотрудник</th>
                      <th>Время</th>
                      <th>Ставка</th>
                      <th>Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.timeEntries.map((entry) => (
                      <tr key={entry.id}>
                        <td>{new Date(entry.work_date).toLocaleDateString("ru-RU")}</td>
                        <td>{entry.membership_name}</td>
                        <td><strong>{hours(entry.minutes)}</strong></td>
                        <td>{money(entry.hourly_rate_minor_snapshot, data.project.currency)}/ч</td>
                        <td>{entry.note ?? "—"}</td>
                      </tr>
                    ))}
                    {!data.timeEntries.length ? (
                      <tr><td colSpan={5}><div className="table-empty"><strong>Время ещё не списывали</strong><span>Фиксируйте фактическую работу, чтобы видеть отклонение от оценки.</span></div></td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
