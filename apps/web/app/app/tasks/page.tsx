"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Task = {
  id: string;
  title: string;
  type: string;
  state: "OPEN" | "IN_PROGRESS" | "WAITING" | "DONE" | "CANCELLED";
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  dueAt: string | null;
  responsibleMembershipId: string;
  linkedType: string | null;
  linkedId: string | null;
};

const columns: Array<{ state: Task["state"]; title: string }> = [
  { state: "OPEN", title: "Новые" },
  { state: "IN_PROGRESS", title: "В работе" },
  { state: "WAITING", title: "Ожидают" },
  { state: "DONE", title: "Выполнено" }
];

function dueLabel(value: string | null): string {
  if (!value) return "Без срока";

  const date = new Date(value);
  const now = new Date();

  if (date.getTime() < now.getTime()) {
    return "Просрочено · " + date.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<"all" | "today" | "overdue" | "mine">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    setLoading(true);

    try {
      const data = await apiRequest<Task[]>(`/tasks?filter=${filter}`);
      setTasks(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить задачи");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  const overdueCount = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.dueAt &&
          new Date(task.dueAt).getTime() < Date.now() &&
          !["DONE", "CANCELLED"].includes(task.state)
      ).length,
    [tasks]
  );

  async function createTask() {
    const title = window.prompt("Что нужно сделать?");
    if (!title?.trim()) return;

    const hours = window.prompt("Через сколько часов срок?", "24");
    const hoursNumber = Number(hours ?? "24");

    const dueAt = Number.isFinite(hoursNumber)
      ? new Date(Date.now() + Math.max(0, hoursNumber) * 3600000).toISOString()
      : undefined;

    try {
      await apiRequest("/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          dueAt
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать задачу");
    }
  }

  async function moveTask(task: Task, state: Task["state"]) {
    try {
      await apiRequest(`/tasks/${task.id}/state`, {
        method: "PATCH",
        body: JSON.stringify({ state })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить задачу");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="tasks" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Работа / Команда</p>
            <h1>Задачи</h1>
            <p className="workspace-summary">
              {tasks.length} задач · просрочено {overdueCount}
            </p>
          </div>
          <button onClick={createTask} type="button">+ Задача</button>
        </header>

        <div className="filter-row">
          {([
            ["all", "Все"],
            ["today", "Сегодня"],
            ["overdue", "Просрочено"],
            ["mine", "Мои"]
          ] as const).map(([value, label]) => (
            <button
              className={filter === value ? "filter-chip active" : "filter-chip"}
              key={value}
              onClick={() => setFilter(value)}
              type="button"
            >
              {label}
            </button>
          ))}
        </div>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем задачи…</div> : null}

        {!loading ? (
          <div className="task-board">
            {columns.map((column) => (
              <section className="task-column" key={column.state}>
                <header>
                  <strong>{column.title}</strong>
                  <span>{tasks.filter((task) => task.state === column.state).length}</span>
                </header>

                <div className="task-list">
                  {tasks
                    .filter((task) => task.state === column.state)
                    .map((task) => {
                      const overdue =
                        task.dueAt &&
                        new Date(task.dueAt).getTime() < Date.now() &&
                        task.state !== "DONE";

                      return (
                        <article className="task-card" key={task.id}>
                          <strong>{task.title}</strong>
                          <span className={overdue ? "task-due overdue" : "task-due"}>
                            {dueLabel(task.dueAt)}
                          </span>
                          <small>{task.type}</small>

                          <div className="task-actions">
                            {task.state === "OPEN" ? (
                              <button
                                onClick={() => void moveTask(task, "IN_PROGRESS")}
                                type="button"
                              >
                                Начать
                              </button>
                            ) : null}

                            {["OPEN", "IN_PROGRESS", "WAITING"].includes(task.state) ? (
                              <button
                                className="secondary-button"
                                onClick={() => void moveTask(task, "DONE")}
                                type="button"
                              >
                                Выполнить
                              </button>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                </div>
              </section>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
