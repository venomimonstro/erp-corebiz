"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type ProjectStatus = "PLANNED" | "ACTIVE" | "ON_HOLD" | "COMPLETED" | "CANCELLED";

type Project = {
  id: string;
  business_number: string;
  name: string;
  code: string | null;
  status: ProjectStatus;
  billing_mode: "FIXED" | "TIME_AND_MATERIAL" | "INTERNAL";
  party_name: string | null;
  currency: string;
  budget_minor: string;
  hourly_rate_minor: string;
  estimated_minutes: number;
  actual_minutes: number;
  billable_minutes: number;
  billable_value_minor: string;
  milestone_count: number;
  milestone_done: number;
  overdue_milestones: number;
  open_tasks: number;
  starts_on: string | null;
  due_on: string | null;
  version: number;
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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setProjects(await apiRequest<Project[]>("/projects"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить проекты");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const metrics = useMemo(() => {
    let budget = 0n;
    let billable = 0n;
    let actual = 0;
    let estimate = 0;
    let overdue = 0;
    let active = 0;

    for (const project of projects) {
      if (!["COMPLETED", "CANCELLED"].includes(project.status)) {
        budget += BigInt(project.budget_minor || "0");
        billable += BigInt(project.billable_value_minor || "0");
        actual += Number(project.actual_minutes || 0);
        estimate += Number(project.estimated_minutes || 0);
        overdue += Number(project.overdue_milestones || 0);
      }
      if (project.status === "ACTIVE") active += 1;
    }

    return { budget, billable, actual, estimate, overdue, active };
  }, [projects]);

  async function createProject() {
    const name = window.prompt("Название проекта");
    if (!name?.trim()) return;

    const budgetRub = Number((window.prompt("Бюджет проекта, ₽", "0") ?? "0").replace(",", "."));
    const estimateHours = Number((window.prompt("Оценка трудозатрат, часов", "0") ?? "0").replace(",", "."));
    const hourlyRub = Number((window.prompt("Расчётная ставка, ₽/час", "0") ?? "0").replace(",", "."));

    if (
      !Number.isFinite(budgetRub) ||
      budgetRub < 0 ||
      !Number.isFinite(estimateHours) ||
      estimateHours < 0 ||
      !Number.isFinite(hourlyRub) ||
      hourlyRub < 0
    ) {
      setError("Некорректные параметры проекта");
      return;
    }

    try {
      const created = await apiRequest<{ id: string }>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          budgetMinor: String(Math.round(budgetRub * 100)),
          estimatedMinutes: Math.round(estimateHours * 60),
          hourlyRateMinor: String(Math.round(hourlyRub * 100)),
          billingMode: hourlyRub > 0 ? "TIME_AND_MATERIAL" : "FIXED",
          startsOn: new Date().toISOString().slice(0, 10)
        })
      });
      window.location.href = "/app/projects/" + created.id;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать проект");
    }
  }

  async function changeStatus(project: Project, status: ProjectStatus) {
    try {
      await apiRequest("/projects/" + project.id + "/status", {
        method: "PATCH",
        body: JSON.stringify({ status, version: project.version })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить статус проекта");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="projects" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Проекты / Маржинальность и загрузка</p>
            <h1>Проекты</h1>
            <p className="workspace-summary">
              Сроки, этапы, трудозатраты и фактическая экономика клиентской работы.
            </p>
          </div>
          <button onClick={() => void createProject()} type="button">+ Проект</button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем проекты…</div> : null}

        {!loading ? (
          <>
            <div className="metric-grid">
              <article className="metric-card">
                <span>Активных проектов</span>
                <strong>{metrics.active}</strong>
                <small>{projects.length} всего</small>
              </article>
              <article className="metric-card">
                <span>Бюджет незавершённых</span>
                <strong>{money(metrics.budget.toString())}</strong>
                <small>Зафиксированный бюджет проектов</small>
              </article>
              <article className="metric-card">
                <span>Учтено по времени</span>
                <strong>{money(metrics.billable.toString())}</strong>
                <small>{hours(metrics.actual)} фактически</small>
              </article>
              <article className="metric-card">
                <span>Просроченных этапов</span>
                <strong>{metrics.overdue}</strong>
                <small>
                  {metrics.estimate > 0
                    ? Math.round((metrics.actual / metrics.estimate) * 100) + "% от оценки времени"
                    : "Нет оценки времени"}
                </small>
              </article>
            </div>

            <section className="section-block">
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Проект</th>
                      <th>Клиент</th>
                      <th>Статус</th>
                      <th>Бюджет</th>
                      <th>Время</th>
                      <th>Этапы</th>
                      <th>Срок</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => (
                      <tr key={project.id}>
                        <td>
                          <a href={"/app/projects/" + project.id}><strong>{project.name}</strong></a>
                          <small>{project.business_number}</small>
                        </td>
                        <td>{project.party_name ?? "Без клиента"}</td>
                        <td><span className="status-pill">{project.status}</span></td>
                        <td>
                          <strong>{money(project.budget_minor, project.currency)}</strong>
                          <small>{project.billing_mode}</small>
                        </td>
                        <td>
                          <strong>{hours(project.actual_minutes)}</strong>
                          <small>оценка {hours(project.estimated_minutes)}</small>
                        </td>
                        <td>
                          <strong>{project.milestone_done}/{project.milestone_count}</strong>
                          <small>
                            {project.overdue_milestones > 0
                              ? "просрочено " + project.overdue_milestones
                              : "задач " + project.open_tasks}
                          </small>
                        </td>
                        <td>{project.due_on ? new Date(project.due_on).toLocaleDateString("ru-RU") : "Без срока"}</td>
                        <td className="table-actions">
                          {project.status === "PLANNED" ? (
                            <button onClick={() => void changeStatus(project, "ACTIVE")} type="button">Начать</button>
                          ) : null}
                          {project.status === "ACTIVE" ? (
                            <button className="secondary-button" onClick={() => void changeStatus(project, "ON_HOLD")} type="button">Пауза</button>
                          ) : null}
                          {project.status === "ON_HOLD" ? (
                            <button onClick={() => void changeStatus(project, "ACTIVE")} type="button">Продолжить</button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                    {!projects.length ? (
                      <tr>
                        <td colSpan={8}>
                          <div className="table-empty">
                            <strong>Проектов пока нет</strong>
                            <span>Создайте проект и начните учитывать этапы и фактическое время.</span>
                          </div>
                        </td>
                      </tr>
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
