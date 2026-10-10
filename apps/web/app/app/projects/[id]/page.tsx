"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

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

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError("");
    try {
      setData(await apiRequest<ProjectDetail>("/projects/" + projectId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить проект");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
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
