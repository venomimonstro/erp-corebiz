"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Snapshot = {
  metric_code: string;
  value_minor: string;
  currency: string;
  metric_date: string;
  source_updated_at: string;
};

type Issue = {
  id: string;
  code: string;
  referenceId: string;
  firstSeenAt: string;
  href: string;
  title: string;
  severity: "WARNING"|"CRITICAL";
  domain: string;
  explanation: string;
};

type Operational = {
  generatedAt: string;
  snapshots: Snapshot[];
  issues: Issue[];
};

const LABELS: Record<string,string> = {
  PAYMENTS_IN: "Поступления сегодня",
  PAYMENTS_OUT: "Списания сегодня",
  AR_OPEN: "Дебиторка",
  AP_OPEN: "Кредиторка",
  BANK_UNMATCHED: "Не сопоставлено в банке",
  VAT_UNREGISTERED: "НДС не зарегистрирован",
  CLOSE_BLOCKED: "Закрытие месяца заблокировано",
  PAYROLL_DRAFT: "Расчёт зарплаты не утверждён"
};

export default function OperationsPage() {
  const [data, setData] = useState<Operational | null>(null);
  const [error, setError] = useState("");
  const [activeDomain,setActiveDomain]=useState("ALL");
  const [showAll,setShowAll]=useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiRequest<Operational>("/dashboard/operational"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить контроль бизнеса"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const snapshotMap = useMemo(
    () => new Map((data?.snapshots ?? []).map((row) => [row.metric_code,row])),
    [data]
  );

  const domains=useMemo(()=>{
    const map=new Map<string,number>();
    for(const issue of data?.issues??[]){
      map.set(issue.domain,(map.get(issue.domain)??0)+1);
    }
    return [...map].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  },[data]);
  const visibleIssues=useMemo(()=>{
    const filtered=(data?.issues??[]).filter(issue=>
      activeDomain==="ALL"||issue.domain===activeDomain
    ).sort((a,b)=>Number(b.severity==="CRITICAL")-
      Number(a.severity==="CRITICAL")||
      Date.parse(a.firstSeenAt)-Date.parse(b.firstSeenAt));
    return showAll?filtered:filtered.slice(0,25);
  },[data,activeDomain,showAll]);
  const criticalCount=(data?.issues??[])
    .filter(issue=>issue.severity==="CRITICAL").length;

  function money(code: string): string {
    const row = snapshotMap.get(code);
    if (!row) return "—";
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: row.currency,
      maximumFractionDigits: 0
    }).format(Number(row.value_minor) / 100);
  }

  function count(code: string): string {
    return snapshotMap.get(code)?.value_minor ?? "0";
  }

  return (
    <main className="app-shell">
      <AppSidebar active="operations" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Владелец / Контроль</p>
            <h1>Что требует внимания</h1>
            <p className="workspace-summary">
              Единая точка контроля для торговли, услуг, студий, автосервисов, агентств,
              маркетплейсов и складов. Только реальные отклонения и следующий шаг.
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void load()}
          >
            Обновить
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Контроль бизнеса</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Поступления сегодня</span>
                <strong>{money("PAYMENTS_IN")}</strong>
                <small>Фактически проведённые платежи</small>
              </article>
              <article className="owner-kpi">
                <span>Списания сегодня</span>
                <strong>{money("PAYMENTS_OUT")}</strong>
                <small>Фактически проведённые платежи</small>
              </article>
              <article className="owner-kpi">
                <span>Дебиторка</span>
                <strong>{money("AR_OPEN")}</strong>
                <small>Открытые обязательства клиентов</small>
              </article>
              <article className="owner-kpi">
                <span>Кредиторка</span>
                <strong>{money("AP_OPEN")}</strong>
                <small>Открытые обязательства компании</small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Контроль бизнес-процессов</p>
                  <h2>Нужны решения · {data.issues.length}</h2>
                  <p className="muted">{criticalCount
                    ?criticalCount+" критичных отклонений — сначала устраните их"
                    :"Сначала просроченные операции, затем предупреждения"}</p>
                </div>
              </div>
              <div className="operations-filters" role="group" aria-label="Фильтр процессов">
                <button type="button" className={activeDomain==="ALL"?"active":""}
                  aria-pressed={activeDomain==="ALL"}
                  onClick={()=>{setActiveDomain("ALL");setShowAll(false);}}>
                  Все · {data.issues.length}
                </button>
                {domains.map(([domain,count])=>
                  <button type="button" key={domain}
                    className={activeDomain===domain?"active":""}
                    aria-pressed={activeDomain===domain}
                    onClick={()=>{setActiveDomain(domain);setShowAll(false);}}>
                    {domain} · {count}
                  </button>)}
              </div>
              <div className="action-queue">
                {visibleIssues.map((issue) => (
                  <a
                    className="action-item"
                    href={issue.href}
                    key={issue.id}
                  >
                    <span
                      className={
                        "severity-dot " +
                        (issue.severity==="CRITICAL"?"critical":"warning")
                      }
                    />
                    <div>
                      <small>{issue.domain} · {issue.code}</small>
                      <strong>{issue.title ?? LABELS[issue.code] ?? issue.code}</strong>
                      <span>{issue.explanation}</span>
                      <small>Обнаружено: {new Date(issue.firstSeenAt).toLocaleString("ru-RU")}</small>
                    </div>
                    <b>Открыть →</b>
                  </a>
                ))}

                {activeDomain!=="ALL"&&!visibleIssues.length?<div className="table-empty">
                  <strong>В этой категории исключений нет</strong>
                </div>:null}
                {(data.issues.filter(issue=>activeDomain==="ALL"||issue.domain===activeDomain).length>25&&!showAll)?
                  <button className="secondary-button" type="button"
                    onClick={()=>setShowAll(true)}>Показать остальные события</button>:null}
                {!data.issues.length ? (
                  <div className="table-empty">
                    <strong>Критичных исключений нет</strong>
                    <span>
                      В проверенных процессах нет открытых отклонений. Это не заменяет сверку
                      с внешними банками и площадками.
                    </span>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Сегодня</p>
                  <h2>Контрольные показатели</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Показатель</th>
                      <th>Значение</th>
                      <th>Обновлён</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.snapshots.map((row) => (
                      <tr key={row.metric_code}>
                        <td>
                          <strong>
                            {LABELS[row.metric_code] ?? row.metric_code}
                          </strong>
                        </td>
                        <td>
                          {row.metric_code === "BANK_UNMATCHED"
                            ? count(row.metric_code)
                            : money(row.metric_code)}
                        </td>
                        <td>
                          {new Date(row.source_updated_at).toLocaleString("ru-RU")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <div className="quality-banner">
              <strong>Срез обновлён</strong>
              <span>{new Date(data.generatedAt).toLocaleString("ru-RU")}</span>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
