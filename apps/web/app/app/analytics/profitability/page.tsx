"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Dashboard = {
  model: string;
  totals: {
    spendMinor: string;
    revenueMinor: string;
    collectedMinor: string;
    refundsMinor: string;
    cogsMinor: string;
    grossProfitMinor: string;
    contributionProfitMinor: string;
    conversions: number;
    roas: number | null;
    romiPercent: number | null;
  };
  campaigns: Array<{
    id: string;
    name: string;
    spendMinor: string;
    conversions: number;
    customers: number;
    revenueMinor: string;
    collectedMinor: string;
    refundsMinor: string;
    cogsMinor: string;
    grossProfitMinor: string;
    contributionProfitMinor: string;
    cpoMinor: string | null;
    cacMinor: string | null;
    roas: number | null;
    romiPercent: number | null;
  }>;
  dataQuality: {
    attributionRows: number;
    mappedConversions: number;
    unmappedConversions: number;
    mappedPercent: number;
  };
  freshness: {
    marketingLastSyncedAt: string | null;
  };
};

type Alert = {
  id: string;
  severity: string;
  status: string;
  rule_name: string;
  type: string;
  campaign_name: string | null;
  created_at: string;
};

function rub(value: string | null): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function ProfitabilityPage() {
  const [model, setModel] = useState("LAST_PAID_TOUCH");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await Promise.all([
        apiRequest<Dashboard>(
          "/analytics/profitability?model=" + encodeURIComponent(model)
        ),
        apiRequest<Alert[]>("/analytics/profitability/alerts")
      ]);
      setDashboard(data[0]);
      setAlerts(data[1]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить прибыльность"
      );
    }
  }, [model]);

  useEffect(() => {
    void load();
  }, [load]);

  async function addAlias(campaignId: string) {
    const value = window.prompt(
      "UTM campaign или другое значение, которое должно соответствовать этой кампании"
    );
    if (!value?.trim()) return;

    try {
      await apiRequest(
        "/analytics/profitability/campaigns/" +
          campaignId +
          "/aliases",
        {
          method: "POST",
          body: JSON.stringify({
            type: "UTM_CAMPAIGN",
            value: value.trim()
          })
        }
      );
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось добавить alias"
      );
    }
  }

  async function createAlert() {
    const type =
      window.prompt(
        "Тип: SPEND_WITHOUT_ORDERS, CPO_ABOVE, ROMI_BELOW, CONTRIBUTION_PROFIT_BELOW",
        "SPEND_WITHOUT_ORDERS"
      ) ?? "";

    const allowed = [
      "SPEND_WITHOUT_ORDERS",
      "CPO_ABOVE",
      "ROMI_BELOW",
      "CONTRIBUTION_PROFIT_BELOW"
    ];

    if (!allowed.includes(type)) {
      setError("Неизвестный тип правила");
      return;
    }

    const name = window.prompt("Название правила", "Контроль рекламы");
    if (!name?.trim()) return;

    const threshold = window.prompt(
      type === "ROMI_BELOW"
        ? "Порог ROMI, %"
        : "Денежный порог, ₽",
      type === "ROMI_BELOW" ? "0" : "5000"
    );
    if (threshold === null) return;

    const numeric = Number(threshold.replace(",", "."));
    if (!Number.isFinite(numeric)) {
      setError("Некорректный порог");
      return;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      type,
      attributionModel: model,
      lookbackDays: 7
    };

    if (type === "ROMI_BELOW") {
      body.thresholdRatio = numeric;
    } else {
      body.thresholdMinor = String(Math.round(numeric * 100));
    }

    try {
      await apiRequest("/analytics/profitability/alerts/rules", {
        method: "POST",
        body: JSON.stringify(body)
      });

      await apiRequest("/analytics/profitability/alerts/evaluate", {
        method: "POST"
      });

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать правило"
      );
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="profitability" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Маркетинг / Где деньги</p>
            <h1>Прибыльность рекламы</h1>
            <p className="workspace-summary">
              Не клики, а расходы → продажи → себестоимость → вклад в прибыль.
            </p>
          </div>

          <div className="header-actions">
            <select
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              <option value="LAST_PAID_TOUCH">Последний платный</option>
              <option value="LAST_TOUCH">Последний контакт</option>
              <option value="FIRST_TOUCH">Первый контакт</option>
            </select>
            <button
              className="secondary-button"
              onClick={() => void createAlert()}
              type="button"
            >
              + Контроль
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {dashboard ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Расход рекламы</span>
                <strong>{rub(dashboard.totals.spendMinor)}</strong>
                <small>
                  Direct:{" "}
                  {dashboard.freshness.marketingLastSyncedAt
                    ? new Date(
                        dashboard.freshness.marketingLastSyncedAt
                      ).toLocaleString("ru-RU")
                    : "нет синхронизации"}
                </small>
              </article>

              <article className="owner-kpi">
                <span>Выручка</span>
                <strong>{rub(dashboard.totals.revenueMinor)}</strong>
                <small>
                  Получено денег: {rub(dashboard.totals.collectedMinor)}
                </small>
              </article>

              <article className="owner-kpi">
                <span>Валовая прибыль</span>
                <strong>{rub(dashboard.totals.grossProfitMinor)}</strong>
                <small>
                  COGS {rub(dashboard.totals.cogsMinor)} · возвраты{" "}
                  {rub(dashboard.totals.refundsMinor)}
                </small>
              </article>

              <article className="owner-kpi">
                <span>Contribution profit</span>
                <strong>
                  {rub(dashboard.totals.contributionProfitMinor)}
                </strong>
                <small>
                  ROMI{" "}
                  {dashboard.totals.romiPercent === null
                    ? "—"
                    : dashboard.totals.romiPercent + "%"}{" "}
                  · ROAS{" "}
                  {dashboard.totals.roas === null
                    ? "—"
                    : dashboard.totals.roas}
                </small>
              </article>
            </div>

            <div className="quality-banner">
              <strong>
                Атрибуция сопоставлена на{" "}
                {dashboard.dataQuality.mappedPercent}%
              </strong>
              <span>
                {dashboard.dataQuality.mappedConversions} из{" "}
                {dashboard.dataQuality.attributionRows} конверсий. Не
                сопоставлено: {dashboard.dataQuality.unmappedConversions}.
              </span>
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">{dashboard.model}</p>
                  <h2>Кампании</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Кампания</th>
                      <th>Расход</th>
                      <th>Конверсии</th>
                      <th>Выручка</th>
                      <th>Gross profit</th>
                      <th>Contribution</th>
                      <th>ROMI</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.campaigns.map((campaign) => (
                      <tr key={campaign.id}>
                        <td>
                          <strong>{campaign.name}</strong>
                          <small>
                            клиентов {campaign.customers} · CPO{" "}
                            {rub(campaign.cpoMinor)} · CAC{" "}
                            {rub(campaign.cacMinor)}
                          </small>
                        </td>
                        <td>{rub(campaign.spendMinor)}</td>
                        <td>{campaign.conversions}</td>
                        <td>{rub(campaign.revenueMinor)}</td>
                        <td>{rub(campaign.grossProfitMinor)}</td>
                        <td>{rub(campaign.contributionProfitMinor)}</td>
                        <td>
                          {campaign.romiPercent === null
                            ? "—"
                            : campaign.romiPercent + "%"}
                        </td>
                        <td className="table-actions">
                          <button
                            className="secondary-button"
                            onClick={() => void addAlias(campaign.id)}
                            type="button"
                          >
                            UTM alias
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Action & Exception</p>
              <h2>Контроль рекламы</h2>
            </div>
          </div>

          <div className="action-queue">
            {alerts
              .filter((alert) => alert.status !== "CLOSED")
              .map((alert) => (
                <article className="action-item" key={alert.id}>
                  <span
                    className={
                      "severity-dot " +
                      (alert.severity === "CRITICAL"
                        ? "critical"
                        : "warning")
                    }
                  />
                  <div>
                    <small>{alert.type}</small>
                    <strong>{alert.rule_name}</strong>
                    <span>
                      {alert.campaign_name ?? "Кампания"} ·{" "}
                      {new Date(alert.created_at).toLocaleString("ru-RU")}
                    </span>
                  </div>
                  <b>{alert.status}</b>
                </article>
              ))}
          </div>
        </section>
      </section>
    </main>
  );
}
