"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Budget = {
  id: string;
  name: string;
  currency: string;
  period_from: string;
  period_to: string;
  active_version_id: string | null;
  published_version_no: number | null;
  draft_version_id: string | null;
  draft_version_no: number | null;
};

type Category = {
  id: string;
  name: string;
  direction: "IN" | "OUT";
  code: string | null;
};

type CompareRow = {
  month: string;
  categoryId: string;
  categoryName: string;
  direction: "IN" | "OUT";
  plannedMinor: string;
  actualMinor: string;
  varianceMinor: string;
};

type Comparison = {
  budget: {
    id: string;
    name: string;
    currency: string;
    periodFrom: string;
    periodTo: string;
    versionNo: number;
    versionStatus: string;
  };
  rows: CompareRow[];
  monthly: Array<{
    month: string;
    plannedInMinor: string;
    actualInMinor: string;
    plannedOutMinor: string;
    actualOutMinor: string;
    plannedNetMinor: string;
    actualNetMinor: string;
  }>;
};

function monthStart(value: string): string {
  return value.slice(0, 7) + "-01";
}

export default function FinanceBudgetPage() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [budgetId, setBudgetId] = useState("");
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [budgetRows, categoryRows] = await Promise.all([
        apiRequest<Budget[]>("/finance/budgets"),
        apiRequest<Category[]>("/finance/budget-categories")
      ]);
      setBudgets(budgetRows);
      setCategories(categoryRows);
      const selected = budgetId || budgetRows[0]?.id || "";
      if (!budgetId && selected) setBudgetId(selected);
      if (selected) {
        setComparison(
          await apiRequest<Comparison>(
            "/finance/budgets/" + selected + "/comparison"
          )
        );
      } else {
        setComparison(null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить бюджеты"
      );
    }
  }, [budgetId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function selectBudget(id: string) {
    setBudgetId(id);
    setComparison(
      await apiRequest<Comparison>(
        "/finance/budgets/" + id + "/comparison"
      )
    );
  }

  async function createBudget() {
    const name = window.prompt("Название бюджета", "Основной бюджет");
    if (!name?.trim()) return;

    const year = new Date().getFullYear();
    const periodFrom = window.prompt("Начало периода YYYY-MM-DD", year + "-01-01");
    const periodTo = window.prompt("Конец периода YYYY-MM-DD", year + "-12-31");
    if (!periodFrom || !periodTo) return;

    try {
      const created = await apiRequest<{ id: string }>("/finance/budgets", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          periodFrom,
          periodTo,
          currency: "RUB"
        })
      });
      setBudgetId(created.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать бюджет");
    }
  }

  async function setPlan() {
    if (!budgetId) return;

    const selectedBudget = budgets.find((item) => item.id === budgetId);
    if (!selectedBudget) return;

    const month = window.prompt(
      "Месяц плана YYYY-MM-01",
      monthStart(selectedBudget.period_from)
    );
    if (!month) return;

    const list = categories
      .map((item, index) =>
        (index + 1) + ". " +
        (item.direction === "IN" ? "Поступление" : "Расход") +
        " · " + item.name
      )
      .join("\n");
    const categoryIndex =
      Number(window.prompt("Выберите категорию:\n" + list, "1")) - 1;
    const category = categories[categoryIndex];
    if (!category) return;

    const amount = window.prompt("План, ₽", "100000");
    if (amount === null) return;

    const numeric = Number(amount.replace(",", "."));
    if (!Number.isFinite(numeric) || numeric < 0) {
      setError("Некорректная сумма");
      return;
    }

    try {
      await apiRequest("/finance/budgets/" + budgetId + "/lines", {
        method: "POST",
        body: JSON.stringify({
          month,
          categoryId: category.id,
          plannedMinor: String(Math.round(numeric * 100))
        })
      });
      await selectBudget(budgetId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить план");
    }
  }

  async function publish() {
    if (!budgetId) return;
    if (!window.confirm("Опубликовать текущую версию бюджета? Она станет неизменяемой.")) {
      return;
    }
    try {
      await apiRequest("/finance/budgets/" + budgetId + "/publish", {
        method: "POST"
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось опубликовать бюджет");
    }
  }

  function money(value: string): string {
    return new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: comparison?.budget.currency ?? "RUB",
      maximumFractionDigits: 0
    }).format(Number(value) / 100);
  }

  const totals = useMemo(() => {
    return (comparison?.monthly ?? []).reduce(
      (sum, row) => ({
        plannedNet: sum.plannedNet + BigInt(row.plannedNetMinor),
        actualNet: sum.actualNet + BigInt(row.actualNetMinor)
      }),
      { plannedNet: 0n, actualNet: 0n }
    );
  }, [comparison]);

  return (
    <main className="app-shell">
      <AppSidebar active="finance-budget" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Деньги / Планирование</p>
            <h1>Бюджет: план / факт</h1>
            <p className="workspace-summary">
              Планируем денежные потоки по категориям и сравниваем с реально проведёнными платежами.
            </p>
          </div>

          <div className="header-actions">
            <button className="secondary-button" onClick={() => void createBudget()}>
              + Бюджет
            </button>
            <button className="secondary-button" disabled={!budgetId} onClick={() => void setPlan()}>
              + План
            </button>
            <button disabled={!budgetId} onClick={() => void publish()}>
              Опубликовать версию
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Бюджет</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="budget-layout">
          <aside className="site-list">
            <strong>Бюджеты</strong>
            {budgets.map((budget) => (
              <button
                key={budget.id}
                className={budget.id === budgetId ? "active" : ""}
                onClick={() => void selectBudget(budget.id)}
              >
                {budget.name}
                <small>
                  {budget.period_from} — {budget.period_to}
                  {budget.published_version_no
                    ? " · published v" + budget.published_version_no
                    : " · draft"}
                </small>
              </button>
            ))}
          </aside>

          <section>
            {comparison ? (
              <>
                <div className="owner-kpi-grid">
                  <article className="owner-kpi">
                    <span>Версия</span>
                    <strong>v{comparison.budget.versionNo}</strong>
                    <small>{comparison.budget.versionStatus}</small>
                  </article>
                  <article className="owner-kpi">
                    <span>План net</span>
                    <strong>{money(totals.plannedNet.toString())}</strong>
                    <small>Поступления минус расходы</small>
                  </article>
                  <article className="owner-kpi">
                    <span>Факт net</span>
                    <strong>{money(totals.actualNet.toString())}</strong>
                    <small>Только POSTED платежи</small>
                  </article>
                  <article className="owner-kpi">
                    <span>Отклонение net</span>
                    <strong>
                      {money((totals.actualNet - totals.plannedNet).toString())}
                    </strong>
                    <small>Факт минус план</small>
                  </article>
                </div>

                <section className="section-block">
                  <div className="section-heading">
                    <div>
                      <p className="muted">Monthly</p>
                      <h2>По месяцам</h2>
                    </div>
                  </div>
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Месяц</th>
                          <th>План поступлений</th>
                          <th>Факт поступлений</th>
                          <th>План расходов</th>
                          <th>Факт расходов</th>
                          <th>План net</th>
                          <th>Факт net</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.monthly.map((row) => (
                          <tr key={row.month}>
                            <td><strong>{row.month.slice(0,7)}</strong></td>
                            <td>{money(row.plannedInMinor)}</td>
                            <td>{money(row.actualInMinor)}</td>
                            <td>{money(row.plannedOutMinor)}</td>
                            <td>{money(row.actualOutMinor)}</td>
                            <td>{money(row.plannedNetMinor)}</td>
                            <td>{money(row.actualNetMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="section-block">
                  <div className="section-heading">
                    <div>
                      <p className="muted">Categories</p>
                      <h2>Категории</h2>
                    </div>
                  </div>
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Месяц</th>
                          <th>Категория</th>
                          <th>Тип</th>
                          <th>План</th>
                          <th>Факт</th>
                          <th>Отклонение</th>
                        </tr>
                      </thead>
                      <tbody>
                        {comparison.rows.map((row) => (
                          <tr key={row.month + ":" + row.categoryId}>
                            <td>{row.month.slice(0,7)}</td>
                            <td>
                              <strong>{row.categoryName}</strong>
                              {row.plannedMinor === "0" && row.actualMinor !== "0" ? (
                                <small>не было в плане</small>
                              ) : null}
                            </td>
                            <td>{row.direction === "IN" ? "Поступление" : "Расход"}</td>
                            <td>{money(row.plannedMinor)}</td>
                            <td>{money(row.actualMinor)}</td>
                            <td>{money(row.varianceMinor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            ) : (
              <div className="table-empty">
                <strong>Создайте первый бюджет</strong>
                <span>Опубликованная версия не переписывается.</span>
              </div>
            )}
          </section>
        </div>
      </section>
    </main>
  );
}
