"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../components/app-sidebar";
import { apiRequest } from "../../lib/api";

type WorkspaceContext = {
  roles: string[];
  permissions: Array<{ code: string; scope: string }>;
  profileCode: string;
  workspace:
    | "OWNER"
    | "ADMIN"
    | "SALES"
    | "SERVICE"
    | "WAREHOUSE"
    | "FINANCE"
    | "PROCUREMENT"
    | "VIEWER";
};

type MemberWorkspace = {
  workspace: string;
  roles: string[];
  title: string;
  metrics: Array<{
    label: string;
    value: string;
    detail: string;
  }>;
  actions: Array<{
    id: string;
    title: string;
    detail: string;
    href: string;
    severity: "INFO" | "WARNING" | "CRITICAL";
  }>;
};

type Activation = {
  profile: string;
  dismissed: boolean;
  completed: boolean;
  progressPercent: number;
  doneCount: number;
  total: number;
  firstSeenAt: string;
  firstValueAt: string | null;
  timeToFirstValueMinutes: number | null;
  milestones: Array<{
    key: string;
    title: string;
    detail: string;
    href: string;
    done: boolean;
    firstValue?: boolean;
  }>;
};

type Dashboard = {
  kpis: {
    cashMinor: string;
    sales30dMinor: string;
    grossProfit30dMinor: string;
    openOrders: number;
    receivableMinor: string;
    payableMinor: string;
    stockValueMinor: string;
  };
  queue: Array<{
    id: string;
    type:
      | "OVERDUE_TASK"
      | "DEAL_NO_NEXT_ACTION"
      | "OVERDUE_OBLIGATION"
      | "STOCK_RISK";
    severity: "INFO" | "WARNING" | "CRITICAL";
    title: string;
    detail: string;
    href: string;
  }>;
};

function money(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

const queueLabels: Record<Dashboard["queue"][number]["type"], string> = {
  OVERDUE_TASK: "Задача",
  DEAL_NO_NEXT_ACTION: "CRM",
  OVERDUE_OBLIGATION: "Финансы",
  STOCK_RISK: "Склад"
};

const workspaceLabels: Record<WorkspaceContext["workspace"], {
  eyebrow: string;
  summary: string;
}> = {
  OWNER: {
    eyebrow: "Среда владельца",
    summary: "Ключевые показатели бизнеса и ситуации, где требуется решение."
  },
  ADMIN: {
    eyebrow: "Среда администратора",
    summary: "Состояние бизнеса и операционные исключения без лишних технических экранов."
  },
  SALES: {
    eyebrow: "Рабочее место продаж",
    summary: "Ваши сделки, задачи и заказы — только то, что нужно менеджеру сегодня."
  },
  SERVICE: {
    eyebrow: "Рабочее место сотрудника",
    summary: "Записи клиентов, ближайшие услуги и ваши задачи."
  },
  WAREHOUSE: {
    eyebrow: "Рабочее место склада",
    summary: "Очередь складских заданий и проблемы исполнения."
  },
  FINANCE: {
    eyebrow: "Рабочее место финансов",
    summary: "Дебиторка, кредиторка, банковская сверка и действия на сегодня."
  },
  PROCUREMENT: {
    eyebrow: "Рабочее место закупок",
    summary: "Заказы поставщикам, ожидаемые поставки и просрочки."
  },
  VIEWER: {
    eyebrow: "Рабочее пространство",
    summary: "Доступные вам разделы и действия."
  }
};

export default function AppHomePage() {
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [member, setMember] = useState<MemberWorkspace | null>(null);
  const [activation, setActivation] = useState<Activation | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const workspace = await apiRequest<WorkspaceContext>(
        "/workspace/context"
      );
      setContext(workspace);

      if (workspace.workspace === "OWNER" || workspace.workspace === "ADMIN") {
        const [dashboardData, activationData] = await Promise.all([
          apiRequest<Dashboard>("/dashboard/owner"),
          apiRequest<Activation>("/dashboard/activation")
        ]);
        setDashboard(dashboardData);
        setActivation(activationData);
        setMember(null);
      } else {
        setMember(
          await apiRequest<MemberWorkspace>("/dashboard/workspace")
        );
        setDashboard(null);
        setActivation(null);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить рабочее пространство"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function dismissActivation() {
    if (!activation) return;
    try {
      await apiRequest("/dashboard/activation/dismiss", {
        method: "PATCH",
        body: JSON.stringify({ dismissed: true })
      });
      setActivation({ ...activation, dismissed: true });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось скрыть подсказки"
      );
    }
  }

  const ownerKpis = useMemo(() => {
    if (!dashboard) return [];

    return [
      ["Деньги (RUB)", money(dashboard.kpis.cashMinor), "Рублёвые счета; без валютной переоценки"],
      ["Заказы · 30 дней", money(dashboard.kpis.sales30dMinor), "Подтверждённые и выполненные; это не фактическая выручка"],
      ["Оценка маржи · 30 дней", money(dashboard.kpis.grossProfit30dMinor), "Предварительная оценка по заказам, без расходов и возвратов"],
      ["Дебиторка (RUB)", money(dashboard.kpis.receivableMinor), "Нам должны в рублях"],
      ["Кредиторка (RUB)", money(dashboard.kpis.payableMinor), "Мы должны в рублях"],
      ["Запасы (RUB)", money(dashboard.kpis.stockValueMinor), "Предварительная оценка по стоимости SKU"]
    ];
  }, [dashboard]);

  const workspaceCopy = context
    ? workspaceLabels[context.workspace]
    : workspaceLabels.VIEWER;

  return (
    <main className="app-shell">
      <AppSidebar active="dashboard" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">{workspaceCopy.eyebrow}</p>
            <h1>{member?.title ?? "Сегодня"}</h1>
            <p className="workspace-summary">{workspaceCopy.summary}</p>
          </div>

          <button onClick={() => void load()} type="button">
            Обновить
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось загрузить данные</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Собираем рабочее пространство…</div> : null}

        {!loading && dashboard ? (
          <>
            {activation && !activation.dismissed && !activation.completed ? (
              <section className="activation-card" aria-labelledby="corebiz-activation">
                <div className="activation-heading">
                  <div>
                    <p className="muted">Первый результат</p>
                    <h2 id="corebiz-activation">
                      Запустите рабочий сценарий · {activation.progressPercent}%
                    </h2>
                    <p>
                      Не нужно настраивать всю систему. Выполните реальные операции своего профиля — прогресс отмечается автоматически.
                    </p>
                  </div>
                  <button
                    className="secondary-button"
                    onClick={() => void dismissActivation()}
                    type="button"
                  >
                    Скрыть
                  </button>
                </div>

                <div className="activation-progress" aria-hidden="true">
                  <span style={{ width: activation.progressPercent + "%" }} />
                </div>

                <div className="activation-steps">
                  {activation.milestones.map((item) => (
                    <a
                      href={item.href}
                      key={item.key}
                      className={item.done ? "activation-step done" : "activation-step"}
                    >
                      <span>{item.done ? "✓" : "○"}</span>
                      <div>
                        <strong>{item.title}</strong>
                        <small>{item.detail}</small>
                      </div>
                      <b>{item.done ? "Готово" : "Открыть →"}</b>
                    </a>
                  ))}
                </div>

                {activation.firstValueAt ? (
                  <small className="activation-ttfv">
                    Первый результат получен
                    {activation.timeToFirstValueMinutes !== null
                      ? " за " + activation.timeToFirstValueMinutes + " мин."
                      : ""}.
                  </small>
                ) : null}
              </section>
            ) : null}

            <div className="owner-kpi-grid">
              {ownerKpis.map(([label, value, detail]) => (
                <article className="owner-kpi" key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                  <small>{detail}</small>
                </article>
              ))}
            </div>

            <section className="attention">
              <div className="attention-heading">
                <div>
                  <p className="muted">Action & Exception Engine</p>
                  <h2>Требует решения</h2>
                </div>
                <span className="queue-count">{dashboard.queue.length}</span>
              </div>

              {dashboard.queue.length ? (
                <div className="action-queue">
                  {dashboard.queue.map((item) => (
                    <a className="action-item" href={item.href} key={item.id}>
                      <span className={"severity-dot " + item.severity.toLowerCase()} />
                      <div>
                        <small>{queueLabels[item.type]}</small>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </div>
                      <b>→</b>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="queue-empty">
                  <strong>Критичных исключений нет</strong>
                  <span>
                    Просроченные задачи, риски по деньгам, CRM и складу появятся здесь автоматически.
                  </span>
                </div>
              )}
            </section>
          </>
        ) : null}

        {!loading && member ? (
          <>
            <div className="owner-kpi-grid">
              {member.metrics.map((item) => (
                <article className="owner-kpi" key={item.label}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                  <small>{item.detail}</small>
                </article>
              ))}
            </div>

            <section className="attention">
              <div className="attention-heading">
                <div>
                  <p className="muted">Мои действия</p>
                  <h2>На сегодня</h2>
                </div>
                <span className="queue-count">{member.actions.length}</span>
              </div>

              {member.actions.length ? (
                <div className="action-queue">
                  {member.actions.map((item) => (
                    <a className="action-item" href={item.href} key={item.id}>
                      <span className={"severity-dot " + item.severity.toLowerCase()} />
                      <div>
                        <small>{member.workspace}</small>
                        <strong>{item.title}</strong>
                        <span>{item.detail}</span>
                      </div>
                      <b>→</b>
                    </a>
                  ))}
                </div>
              ) : (
                <div className="queue-empty">
                  <strong>Срочных действий нет</strong>
                  <span>
                    Здесь появятся задачи и исключения, относящиеся к вашей роли.
                  </span>
                </div>
              )}
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
