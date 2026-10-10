"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Lesson = {
  id: string;
  group_name: string | null;
  program_name: string | null;
  lesson_type: string;
  starts_at: string;
  ends_at: string;
  capacity: number;
  status: string;
  trainer_name: string | null;
  room_name: string | null;
  booked_count: number;
  attended_count: number;
};

type GroupHealth = {
  id: string;
  name: string;
  capacity: number;
  break_even_members: number;
  members: number;
  waitlist: number;
};

type Dashboard = {
  todayLessons: Lesson[];
  debt: {
    open_count: number;
    open_minor: string;
    overdue_count: number;
  };
  groups: GroupHealth[];
  packageAlerts: {
    expiring: number;
    low_visits: number;
  };
  monthEconomics: {
    revenue_minor: string;
    trainer_cost_minor: string;
    room_cost_minor: string;
    margin_minor: string;
  };
  attention: {
    unclosed_past_lessons: number;
    attended_without_payment_source: number;
    completed_without_profitability: number;
    completed_without_trainer_accrual: number;
    lesson_waitlist: number;
    over_capacity: number;
  };
};

function money(value: string, currency = "RUB") {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function DanceDashboardPage() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiRequest<Dashboard>("/dance/dashboard"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить студию");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const belowBreakEven = useMemo(
    () =>
      data?.groups.filter(
        (group) => Number(group.members) < Number(group.break_even_members)
      ) ?? [],
    [data]
  );

  return (
    <main className="app-shell">
      <AppSidebar active="dance" />
      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Студия / Панель владельца</p>
            <h1>Студия сегодня</h1>
            <p className="workspace-summary">
              Посещаемость, долги, абонементы, загрузка групп и экономика месяца.
            </p>
          </div>
          <div className="header-actions">
            <a className="secondary-button" href="/app/dance/students">Ученики и деньги</a>
            <a className="secondary-button" href="/app/dance/groups">Группы и уроки</a>
            <a className="secondary-button" href="/app/dance/team">Тренеры и залы</a>
            <button onClick={() => void load()} type="button">Обновить</button>
          </div>
        </header>

        {error ? <div className="inline-error"><strong>Студия</strong><span>{error}</span></div> : null}

        {data ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Реализация месяца</span>
                <strong>{money(data.monthEconomics.revenue_minor)}</strong>
                <small>оказанные занятия</small>
              </article>
              <article className="owner-kpi">
                <span>Маржинальный доход</span>
                <strong>{money(data.monthEconomics.margin_minor)}</strong>
                <small>
                  тренеры {money(data.monthEconomics.trainer_cost_minor)} · залы {money(data.monthEconomics.room_cost_minor)}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Дебиторка</span>
                <strong>{money(data.debt.open_minor)}</strong>
                <small>{data.debt.overdue_count} просрочено</small>
              </article>
              <article className="owner-kpi">
                <span>Абонементы</span>
                <strong>{data.packageAlerts.expiring + data.packageAlerts.low_visits}</strong>
                <small>{data.packageAlerts.expiring} заканчиваются · {data.packageAlerts.low_visits} почти исчерпаны</small>
              </article>
              <article className="owner-kpi">
                <span>Группы ниже break-even</span>
                <strong>{belowBreakEven.length}</strong>
                <small>{data.groups.length} активных групп</small>
              </article>
            </div>

            {Object.values(data.attention).some((value) => Number(value) > 0) ? (
              <div className="inline-error">
                <strong>Операционные исключения</strong>
                <span>
                  {data.attention.unclosed_past_lessons > 0
                    ? "Незакрытых прошедших уроков: " + data.attention.unclosed_past_lessons + ". "
                    : ""}
                  {data.attention.attended_without_payment_source > 0
                    ? "Посещений без источника оплаты: " + data.attention.attended_without_payment_source + ". "
                    : ""}
                  {data.attention.completed_without_profitability > 0
                    ? "Уроков без расчёта экономики: " + data.attention.completed_without_profitability + ". "
                    : ""}
                  {data.attention.completed_without_trainer_accrual > 0
                    ? "Уроков без начисления тренеру: " + data.attention.completed_without_trainer_accrual + ". "
                    : ""}
                  {data.attention.lesson_waitlist > 0
                    ? "Учеников в waitlist уроков: " + data.attention.lesson_waitlist + ". "
                    : ""}
                  {data.attention.over_capacity > 0
                    ? "Переполненных уроков: " + data.attention.over_capacity + "."
                    : ""}
                </span>
              </div>
            ) : null}

            {belowBreakEven.length ? (
              <div className="inline-error">
                <strong>Требует внимания</strong>
                <span>
                  Ниже точки безубыточности: {belowBreakEven.map((group) => group.name).join(", ")}
                </span>
              </div>
            ) : null}

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Сегодня</p>
                  <h2>Занятия</h2>
                </div>
                <a href="/app/dance/groups">Управлять расписанием →</a>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Время</th>
                      <th>Группа / занятие</th>
                      <th>Тренер</th>
                      <th>Зал</th>
                      <th>Запись</th>
                      <th>Статус</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.todayLessons.map((lesson) => (
                      <tr key={lesson.id}>
                        <td>
                          <strong>{new Date(lesson.starts_at).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</strong>
                          <small>{new Date(lesson.ends_at).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}</small>
                        </td>
                        <td>
                          <strong>{lesson.group_name ?? lesson.lesson_type}</strong>
                          <small>{lesson.program_name ?? lesson.lesson_type}</small>
                        </td>
                        <td>{lesson.trainer_name ?? "Не назначен"}</td>
                        <td>{lesson.room_name ?? "Без зала"}</td>
                        <td>
                          <strong>{lesson.booked_count}/{lesson.capacity}</strong>
                          <small>пришло {lesson.attended_count}</small>
                        </td>
                        <td><span className="status-pill">{lesson.status}</span></td>
                      </tr>
                    ))}
                    {!data.todayLessons.length ? (
                      <tr><td colSpan={6}><div className="table-empty"><strong>Сегодня занятий нет</strong><span>Проверьте расписание групп.</span></div></td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Группы</p>
                  <h2>Загрузка и лист ожидания</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Группа</th><th>Участников</th><th>Capacity</th><th>Break-even</th><th>Waitlist</th><th>Решение</th></tr></thead>
                  <tbody>
                    {data.groups.map((group) => {
                      const weak = Number(group.members) < Number(group.break_even_members);
                      const full = Number(group.members) >= Number(group.capacity);
                      return (
                        <tr key={group.id}>
                          <td><strong>{group.name}</strong></td>
                          <td>{group.members}</td>
                          <td>{group.capacity}</td>
                          <td>{group.break_even_members}</td>
                          <td>{group.waitlist}</td>
                          <td>
                            {weak ? "Нужен набор / объединение" : full && group.waitlist > 0 ? "Рассмотреть вторую группу" : "Норма"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : <div className="board-loading">Загружаем студию…</div>}
      </section>
    </main>
  );
}
