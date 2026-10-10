"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Insight = {
  severity: "INFO" | "WARNING" | "CRITICAL";
  code: string;
  title: string;
  detail: string;
  href: string;
};

type Brief = {
  generatedAt: string;
  mode: string;
  executionAllowed: boolean;
  dataSources: string[];
  headline: Insight;
  insights: Insight[];
  snapshot: {
    owner: {
      cashMinor: string;
      sales30dMinor: string;
      grossProfit30dMinor: string;
      receivableMinor: string;
      payableMinor: string;
    };
    cashForecast: {
      openingBalanceMinor: string;
      endingBalanceMinor: string;
      firstCashGapDate: string | null;
    };
    marketing: {
      spendMinor: string;
      contributionProfitMinor: string;
      romiPercent: number | null;
    };
    operationalIssueCount: number;
  };
};

export default function OwnerAssistantPage() {
  const [data, setData] = useState<Brief | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiRequest<Brief>("/assistant/owner/brief"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось собрать бизнес-бриф"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function rub(value: string): string {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }

  return (
    <main className="app-shell">
      <AppSidebar active="owner-assistant" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Владелец / Помощник</p>
            <h1>Что происходит с бизнесом</h1>
            <p className="workspace-summary">
              Только проверяемые данные системы. Помощник ничего не меняет и не выполняет операции от вашего имени.
            </p>
          </div>
          <button
            className="secondary-button"
            type="button"
            onClick={() => void load()}
          >
            Обновить анализ
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Помощник владельца</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {data ? (
          <>
            <section
              className={
                "assistant-headline assistant-" +
                data.headline.severity.toLowerCase()
              }
            >
              <small>Главное сейчас</small>
              <h2>{data.headline.title}</h2>
              <p>{data.headline.detail}</p>
              <a href={data.headline.href}>Разобраться →</a>
            </section>

            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Деньги сейчас</span>
                <strong>
                  {rub(data.snapshot.cashForecast.openingBalanceMinor)}
                </strong>
                <small>
                  Через 30 дней{" "}
                  {rub(data.snapshot.cashForecast.endingBalanceMinor)}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Валовая прибыль 30д</span>
                <strong>{rub(data.snapshot.owner.grossProfit30dMinor)}</strong>
                <small>
                  Продажи {rub(data.snapshot.owner.sales30dMinor)}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Contribution рекламы</span>
                <strong>
                  {rub(data.snapshot.marketing.contributionProfitMinor)}
                </strong>
                <small>
                  ROMI{" "}
                  {data.snapshot.marketing.romiPercent === null
                    ? "—"
                    : data.snapshot.marketing.romiPercent + "%"}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Открытые исключения</span>
                <strong>{data.snapshot.operationalIssueCount}</strong>
                <small>
                  Банк / НДС / close / payroll
                </small>
              </article>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Приоритеты</p>
                  <h2>Что проверить</h2>
                </div>
              </div>

              <div className="assistant-insights">
                {data.insights.map((insight, index) => (
                  <a
                    className="assistant-insight"
                    href={insight.href}
                    key={insight.code + ":" + index}
                  >
                    <span
                      className={
                        "severity-dot " +
                        (insight.severity === "CRITICAL"
                          ? "critical"
                          : insight.severity === "WARNING"
                            ? "warning"
                            : "")
                      }
                    />
                    <div>
                      <small>{insight.code}</small>
                      <strong>{insight.title}</strong>
                      <p>{insight.detail}</p>
                    </div>
                    <b>Открыть →</b>
                  </a>
                ))}
              </div>
            </section>

            <div className="quality-banner">
              <strong>Режим: read-only</strong>
              <span>
                Источники: {data.dataSources.join(" · ")}. Выполнение действий: запрещено.
              </span>
            </div>
          </>
        ) : null}
      </section>
    </main>
  );
}
