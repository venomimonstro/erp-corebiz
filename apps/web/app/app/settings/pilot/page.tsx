"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Overview = {
  enrollment: null | {
    id: string;
    cohort_code: string;
    status: "PLANNED"|"READY"|"RUNNING"|"PAUSED"|"COMPLETED"|"STOPPED";
    profile_snapshot: string;
    target_version: string | null;
    release_status: string | null;
    pilot_owner_email: string | null;
    planned_start_at: string | null;
    target_end_at: string | null;
    started_at: string | null;
    completed_at: string | null;
    stop_reason: string | null;
  };
  approvedRelease: null | {
    id: string;
    targetVersion: string;
    reviewedAt: string | null;
  };
  prerequisites: {
    releaseApproved: boolean;
    tenantReady: boolean;
    launchStage: string;
    formalGo: boolean;
    latestHypercareGreen: boolean;
    openP0: number;
  };
  currentHypercare: {
    health: string;
    stage: string;
    metrics: Record<string, number | string>;
    blockers: Array<{code:string;message:string;count:number}>;
    warnings: Array<{code:string;message:string;count:number}>;
  };
  incidents: Array<{
    id: string;
    severity: "P0"|"P1"|"P2"|"P3";
    code: string;
    summary: string;
    status: string;
    resolution_note: string | null;
    opened_at: string;
    resolved_at: string | null;
  }>;
  history: Array<{
    id: string;
    from_status: string | null;
    to_status: string;
    reason: string | null;
    created_at: string;
  }>;
  snapshots: Array<{
    id: string;
    stage: string;
    health: string;
    metrics: Record<string, number | string>;
    blockers: unknown[];
    warnings: unknown[];
    captured_at: string;
  }>;
};

type PilotStatus = NonNullable<Overview["enrollment"]>["status"];

export default function PilotPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiRequest<Overview>("/pilot/overview"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить pilot"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function enroll() {
    const cohortCode = window.prompt("Код pilot cohort", "PILOT-01");
    if (!cohortCode?.trim()) return;

    setBusy("enroll");
    try {
      await apiRequest("/pilot/enroll", {
        method: "POST",
        body: JSON.stringify({ cohortCode: cohortCode.trim() })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось создать pilot"
      );
    } finally {
      setBusy("");
    }
  }

  async function transition(status: PilotStatus) {
    let reason: string | undefined;
    if (status === "PAUSED" || status === "STOPPED") {
      reason =
        window.prompt(
          status === "PAUSED"
            ? "Причина паузы pilot"
            : "Причина остановки pilot"
        )?.trim() || undefined;
      if (!reason) return;
    }

    if (
      !window.confirm(
        "Перевести pilot в статус " + status + "?"
      )
    ) return;

    setBusy("transition");
    try {
      await apiRequest("/pilot/transition", {
        method: "POST",
        body: JSON.stringify({ status, reason })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Переход pilot заблокирован"
      );
    } finally {
      setBusy("");
    }
  }

  async function snapshot() {
    setBusy("snapshot");
    try {
      await apiRequest("/pilot/snapshots", { method: "POST" });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось снять snapshot"
      );
    } finally {
      setBusy("");
    }
  }

  async function openIncident() {
    const severity = (
      window.prompt("Severity: P0, P1, P2, P3", "P1") ?? ""
    ).toUpperCase();
    if (!["P0","P1","P2","P3"].includes(severity)) return;

    const code = window.prompt("Код incident", "PILOT_ISSUE");
    if (!code?.trim()) return;

    const summary = window.prompt("Кратко опишите проблему");
    if (!summary?.trim()) return;

    setBusy("incident");
    try {
      await apiRequest("/pilot/incidents", {
        method: "POST",
        body: JSON.stringify({
          severity,
          code: code.trim(),
          summary: summary.trim()
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось открыть incident"
      );
    } finally {
      setBusy("");
    }
  }

  async function resolveIncident(id: string) {
    const note = window.prompt("Что сделано для решения incident?");
    if (!note?.trim()) return;

    setBusy("resolve");
    try {
      await apiRequest("/pilot/incidents/" + id + "/resolve", {
        method: "POST",
        body: JSON.stringify({ resolutionNote: note.trim() })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось закрыть incident"
      );
    } finally {
      setBusy("");
    }
  }

  const nextActions = useMemo(() => {
    const status = data?.enrollment?.status;
    if (!status) return [];
    if (status === "PLANNED") return ["READY"] as PilotStatus[];
    if (status === "READY") return ["RUNNING","STOPPED"] as PilotStatus[];
    if (status === "RUNNING") return ["PAUSED","COMPLETED","STOPPED"] as PilotStatus[];
    if (status === "PAUSED") return ["RUNNING","STOPPED"] as PilotStatus[];
    return [];
  }, [data]);

  return (
    <main className="app-shell">
      <AppSidebar active="pilot" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Управление / Pilot rollout</p>
            <h1>Pilot & Hypercare</h1>
            <p className="workspace-summary">
              Контролируемый запуск реальной компании. P0 автоматически ставит работающий pilot на паузу.
            </p>
          </div>
          <div className="header-actions">
            <button className="secondary-button" onClick={() => void load()}>
              Обновить
            </button>
            {!data?.enrollment ? (
              <button disabled={busy !== ""} onClick={() => void enroll()}>
                Создать pilot
              </button>
            ) : (
              <>
                <button
                  className="secondary-button"
                  disabled={busy !== ""}
                  onClick={() => void snapshot()}
                >
                  Снять snapshot
                </button>
                <button
                  disabled={busy !== ""}
                  onClick={() => void openIncident()}
                >
                  + Incident
                </button>
              </>
            )}
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Pilot</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data?.enrollment ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Pilot</span>
                <strong>{data.enrollment.status}</strong>
                <small>{data.enrollment.cohort_code} · {data.enrollment.profile_snapshot}</small>
              </article>
              <article className="owner-kpi">
                <span>Release</span>
                <strong>{data.approvedRelease ? "APPROVED" : "BLOCKED"}</strong>
                <small>{data.approvedRelease?.targetVersion ?? "Нет approved RC"}</small>
              </article>
              <article className="owner-kpi">
                <span>Go-Live</span>
                <strong>{data.prerequisites.launchStage}</strong>
                <small>{data.prerequisites.tenantReady ? "Readiness PASS" : "Есть blockers"}</small>
              </article>
              <article className="owner-kpi">
                <span>Hypercare</span>
                <strong>{data.currentHypercare.health}</strong>
                <small>P0 открыто: {data.prerequisites.openP0}</small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Controlled state machine</p>
                  <h2>Управление pilot</h2>
                </div>
              </div>
              <div className="pilot-prerequisites">
                <Prereq ok={data.prerequisites.releaseApproved} text="Approved release candidate" />
                <Prereq ok={data.prerequisites.tenantReady} text="Tenant readiness" />
                <Prereq ok={data.prerequisites.formalGo} text="Формальное GO / Hypercare" />
                <Prereq ok={data.prerequisites.latestHypercareGreen} text="Свежий GREEN snapshot" />
                <Prereq ok={data.prerequisites.openP0 === 0} text="Нет открытого P0" />
              </div>
              <div className="builder-actions">
                {nextActions.map((status) => (
                  <button
                    key={status}
                    className={
                      status === "STOPPED" || status === "PAUSED"
                        ? "secondary-button"
                        : ""
                    }
                    disabled={busy !== ""}
                    onClick={() => void transition(status)}
                    type="button"
                  >
                    → {status}
                  </button>
                ))}
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Stop conditions</p>
                  <h2>Incidents</h2>
                </div>
              </div>
              <div className="action-queue">
                {data.incidents.map((incident) => (
                  <article className="action-item" key={incident.id}>
                    <span
                      className={
                        "severity-dot " +
                        (incident.severity === "P0" ? "critical" : "warning")
                      }
                    />
                    <div>
                      <small>{incident.severity} · {incident.code}</small>
                      <strong>{incident.summary}</strong>
                      <span>
                        {incident.status} · {new Date(incident.opened_at).toLocaleString("ru-RU")}
                      </span>
                    </div>
                    {incident.status !== "RESOLVED" ? (
                      <button
                        className="secondary-button"
                        disabled={busy !== ""}
                        onClick={() => void resolveIncident(incident.id)}
                      >
                        Решить
                      </button>
                    ) : (
                      <b>RESOLVED</b>
                    )}
                  </article>
                ))}
                {!data.incidents.length ? (
                  <div className="table-empty">
                    <strong>Incidents нет</strong>
                    <span>Новые проблемы фиксируются здесь, а не теряются в чатах.</span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Daily evidence</p>
                  <h2>Hypercare snapshots</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Stage</th>
                      <th>Health</th>
                      <th>Заказы</th>
                      <th>Записи</th>
                      <th>Платежи</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.snapshots.map((row) => (
                      <tr key={row.id}>
                        <td>{new Date(row.captured_at).toLocaleString("ru-RU")}</td>
                        <td>{row.stage}</td>
                        <td><span className="status-pill">{row.health}</span></td>
                        <td>{String(row.metrics.orders ?? 0)}</td>
                        <td>{String(row.metrics.bookings ?? 0)}</td>
                        <td>{String(row.metrics.postedPayments ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Immutable history</p>
                  <h2>Переходы pilot</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr><th>Дата</th><th>Из</th><th>В</th><th>Причина</th></tr>
                  </thead>
                  <tbody>
                    {data.history.map((row) => (
                      <tr key={row.id}>
                        <td>{new Date(row.created_at).toLocaleString("ru-RU")}</td>
                        <td>{row.from_status ?? "—"}</td>
                        <td><strong>{row.to_status}</strong></td>
                        <td>{row.reason ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          <div className="table-empty">
            <strong>Pilot ещё не создан</strong>
            <span>
              Создайте enrollment только для ограниченной реальной компании после выбора pilot cohort.
            </span>
          </div>
        )}
      </section>
    </main>
  );
}

function Prereq({ ok, text }: { ok: boolean; text: string }) {
  return (
    <div className={"pilot-prereq " + (ok ? "ok" : "blocked")}>
      <b>{ok ? "PASS" : "BLOCK"}</b>
      <span>{text}</span>
    </div>
  );
}
