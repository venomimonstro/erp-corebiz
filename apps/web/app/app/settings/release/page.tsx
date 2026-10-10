"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Evidence = {
  component: string;
  kind: string;
  targetVersion: string;
  outcome: "PASS" | "FAIL" | "BLOCKED";
  evidenceReference: string;
  executedAt: string;
};

type Candidate = {
  id: string;
  target_version: string;
  status: string;
  verdict_snapshot: {
    readyForApproval?: boolean;
    evaluatedAt?: string;
    missing?: Array<{ component: string; kind: string }>;
    stale?: Array<{ component: string; kind: string; executedAt: string }>;
    failing?: Array<{ component: string; kind: string; outcome: string }>;
  };
  review_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
};

type Overview = {
  ready: boolean;
  summary: {
    evidence: number;
    failing: number;
    missing: number;
    stale: number;
  };
  mandatoryMissing: Array<{ component: string; kind: string }>;
  stale: Array<{ component: string; kind: string; executedAt: string }>;
  latest: Evidence[];
};

const COMPONENTS = [
  "CORE","API","AUTH","COMMERCE","SITES","WMS",
  "FINANCE","BANK","ACCOUNTING","VAT","PAYROLL","ANALYTICS"
];

const KINDS = [
  "MIGRATIONS","TYPECHECK","TESTS","BUILD","SECURITY",
  "STABILITY","INTEGRATION","BROWSER_SMOKE","RESTORE","RECONCILIATION"
];

export default function ReleaseReadinessPage() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [overviewData, candidateRows] = await Promise.all([
        apiRequest<Overview>("/release/overview"),
        apiRequest<Candidate[]>("/release/candidates")
      ]);
      setOverview(overviewData);
      setCandidates(candidateRows);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить готовность релиза"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createCandidate() {
    const targetVersion = window.prompt(
      "Commit SHA / tag / версия release candidate"
    );
    if (!targetVersion?.trim()) return;

    setBusy(true);
    setError("");
    try {
      const created = await apiRequest<{ id: string }>(
        "/release/candidates",
        {
          method: "POST",
          body: JSON.stringify({
            targetVersion: targetVersion.trim()
          })
        }
      );
      await apiRequest(
        "/release/candidates/" + created.id + "/evaluate",
        { method: "POST" }
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать release candidate"
      );
    } finally {
      setBusy(false);
    }
  }

  async function evaluateCandidate(id: string) {
    setBusy(true);
    setError("");
    try {
      await apiRequest("/release/candidates/" + id + "/evaluate", {
        method: "POST"
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось пересчитать verdict"
      );
    } finally {
      setBusy(false);
    }
  }

  async function reviewCandidate(
    candidate: Candidate,
    decision: "APPROVE" | "REJECT"
  ) {
    const reason =
      window.prompt(
        decision === "APPROVE"
          ? "Комментарий владельца к approval"
          : "Причина отклонения"
      ) ?? "";

    setBusy(true);
    setError("");
    try {
      await apiRequest(
        "/release/candidates/" + candidate.id + "/review",
        {
          method: "POST",
          body: JSON.stringify({
            decision,
            reason: reason.trim() || undefined
          })
        }
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить решение"
      );
    } finally {
      setBusy(false);
    }
  }

  async function addEvidence() {
    const component = (
      window.prompt("Компонент: " + COMPONENTS.join(", "), "CORE") ?? ""
    ).toUpperCase();
    if (!COMPONENTS.includes(component)) return;

    const kind = (
      window.prompt("Проверка: " + KINDS.join(", "), "INTEGRATION") ?? ""
    ).toUpperCase();
    if (!KINDS.includes(kind)) return;

    const outcome = (
      window.prompt("Результат: PASS, FAIL или BLOCKED", "PASS") ?? ""
    ).toUpperCase();
    if (!["PASS","FAIL","BLOCKED"].includes(outcome)) return;

    const targetVersion = window.prompt(
      "Версия / commit / release",
      "main"
    );
    if (!targetVersion?.trim()) return;

    const evidenceReference = window.prompt(
      "Evidence: ссылка, путь к логу или краткое описание результата"
    );
    if (!evidenceReference?.trim()) return;

    setBusy(true);
    try {
      await apiRequest("/release/evidence", {
        method: "POST",
        body: JSON.stringify({
          component,
          kind,
          outcome,
          targetVersion: targetVersion.trim(),
          evidenceReference: evidenceReference.trim()
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сохранить evidence"
      );
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const result = new Map<string, Evidence[]>();
    for (const row of overview?.latest ?? []) {
      const list = result.get(row.component) ?? [];
      list.push(row);
      result.set(row.component, list);
    }
    return Array.from(result.entries()).sort(([a],[b]) => a.localeCompare(b));
  }, [overview]);

  return (
    <main className="app-shell">
      <AppSidebar active="release-readiness" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Управление / Release Gate</p>
            <h1>Готовность релиза</h1>
            <p className="workspace-summary">
              История проверок неизменяема. Новый запуск добавляет новый evidence, а не переписывает прошлый.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="secondary-button"
              type="button"
              onClick={() => void load()}
            >
              Обновить
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={() => void createCandidate()}
            >
              + Release candidate
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void addEvidence()}
            >
              + Evidence
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Release Gate</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {overview ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Статус</span>
                <strong>{overview.ready ? "READY" : "BLOCKED"}</strong>
                <small>
                  {overview.ready
                    ? "Обязательные проверки свежие и успешные"
                    : "Есть незакрытые условия релиза"}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Evidence</span>
                <strong>{overview.summary.evidence}</strong>
                <small>Последние результаты по компонентам</small>
              </article>
              <article className="owner-kpi">
                <span>FAIL / BLOCKED</span>
                <strong>{overview.summary.failing}</strong>
                <small>Должно быть 0 перед production rollout</small>
              </article>
              <article className="owner-kpi">
                <span>Missing / stale</span>
                <strong>
                  {overview.summary.missing + overview.summary.stale}
                </strong>
                <small>Missing {overview.summary.missing} · stale {overview.summary.stale}</small>
              </article>
            </div>

            {overview.mandatoryMissing.length ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Release blockers</p>
                    <h2>Не хватает обязательных проверок</h2>
                  </div>
                </div>
                <div className="action-queue">
                  {overview.mandatoryMissing.map((item) => (
                    <article
                      className="action-item"
                      key={item.component + ":" + item.kind}
                    >
                      <span className="severity-dot critical" />
                      <div>
                        <strong>{item.component}</strong>
                        <span>{item.kind}</span>
                      </div>
                      <b>MISSING</b>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            {overview.stale.length ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Older than 30 days</p>
                    <h2>Устаревшие проверки</h2>
                  </div>
                </div>
                <div className="action-queue">
                  {overview.stale.map((item) => (
                    <article
                      className="action-item"
                      key={item.component + ":" + item.kind}
                    >
                      <span className="severity-dot warning" />
                      <div>
                        <strong>{item.component}</strong>
                        <span>
                          {item.kind} ·{" "}
                          {new Date(item.executedAt).toLocaleString("ru-RU")}
                        </span>
                      </div>
                      <b>STALE</b>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Sprint 70 / Production verdict</p>
                  <h2>Release candidates</h2>
                </div>
              </div>

              <div className="release-grid">
                {candidates.map((candidate) => {
                  const verdict = candidate.verdict_snapshot ?? {};
                  const missing = verdict.missing?.length ?? 0;
                  const stale = verdict.stale?.length ?? 0;
                  const failing = verdict.failing?.length ?? 0;

                  return (
                    <article className="settings-card" key={candidate.id}>
                      <div className="growth-site-heading">
                        <div>
                          <h3>{candidate.target_version}</h3>
                          <small>
                            {new Date(candidate.created_at).toLocaleString("ru-RU")}
                          </small>
                        </div>
                        <span className="status-pill">
                          {candidate.status}
                        </span>
                      </div>

                      <dl className="growth-site-meta">
                        <div><dt>Missing</dt><dd>{missing}</dd></div>
                        <div><dt>Stale</dt><dd>{stale}</dd></div>
                        <div><dt>Fail / blocked</dt><dd>{failing}</dd></div>
                        <div>
                          <dt>Verdict</dt>
                          <dd>
                            {verdict.readyForApproval === true
                              ? "READY FOR APPROVAL"
                              : verdict.evaluatedAt
                                ? "BLOCKED"
                                : "NOT EVALUATED"}
                          </dd>
                        </div>
                      </dl>

                      {candidate.review_reason ? (
                        <p className="builder-hint">
                          Решение: {candidate.review_reason}
                        </p>
                      ) : null}

                      <div className="builder-actions">
                        {!["APPROVED","REJECTED"].includes(candidate.status) ? (
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() => void evaluateCandidate(candidate.id)}
                            type="button"
                          >
                            Пересчитать
                          </button>
                        ) : null}

                        {candidate.status === "READY_FOR_APPROVAL" ? (
                          <button
                            disabled={busy}
                            onClick={() =>
                              void reviewCandidate(candidate, "APPROVE")
                            }
                            type="button"
                          >
                            Approve
                          </button>
                        ) : null}

                        {!["APPROVED","REJECTED"].includes(candidate.status) ? (
                          <button
                            className="secondary-button"
                            disabled={busy}
                            onClick={() =>
                              void reviewCandidate(candidate, "REJECT")
                            }
                            type="button"
                          >
                            Reject
                          </button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}

                {!candidates.length ? (
                  <div className="table-empty">
                    <strong>Release candidate ещё не создан</strong>
                    <span>
                      Укажите commit/tag, соберите evidence именно для него,
                      затем выполните owner approval.
                    </span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Latest evidence</p>
                  <h2>Матрица проверок</h2>
                </div>
              </div>

              <div className="release-grid">
                {grouped.map(([component, rows]) => (
                  <article className="settings-card" key={component}>
                    <div className="growth-site-heading">
                      <h3>{component}</h3>
                      <span className="status-pill">
                        {rows.some((row) => row.outcome !== "PASS")
                          ? "ATTENTION"
                          : "PASS"}
                      </span>
                    </div>

                    <div className="release-check-list">
                      {rows
                        .sort((a,b) => a.kind.localeCompare(b.kind))
                        .map((row) => (
                          <div key={row.kind}>
                            <div>
                              <strong>{row.kind}</strong>
                              <span>
                                {row.targetVersion} ·{" "}
                                {new Date(row.executedAt).toLocaleString("ru-RU")}
                              </span>
                            </div>
                            <b data-outcome={row.outcome}>{row.outcome}</b>
                            <small>{row.evidenceReference}</small>
                          </div>
                        ))}
                    </div>
                  </article>
                ))}
              </div>
            </section>

            <div className="quality-banner">
              <strong>Серверная команда проверки</strong>
              <span>
                COREBIZ_CONFIRM_DISPOSABLE_DB=YES … pnpm release:gate
              </span>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
