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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setOverview(await apiRequest<Overview>("/release/overview"));
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
