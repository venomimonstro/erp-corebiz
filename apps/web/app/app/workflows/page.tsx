"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Workflow = {
  id: string;
  name: string;
  trigger_event: string;
  entity_type: string | null;
  enabled: boolean;
  published_version_id: string | null;
  published_version: number | null;
};

type Execution = {
  id: string;
  workflow_name: string;
  status: string;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
};

export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [workflowData, executionData] = await Promise.all([
        apiRequest<Workflow[]>("/workflows"),
        apiRequest<Execution[]>("/workflows/executions")
      ]);
      setWorkflows(workflowData);
      setExecutions(executionData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить автоматизации");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createWorkflow() {
    const name = window.prompt("Название автоматизации");
    if (!name?.trim()) return;

    const trigger = window.prompt(
      "Событие",
      "sales.order_confirmed"
    );
    if (!trigger?.trim()) return;

    try {
      const workflow = await apiRequest<{ id: string }>("/workflows", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          triggerEvent: trigger.trim()
        })
      });

      const taskTitle = window.prompt(
        "Какое действие выполнить? Пока создадим задачу. Название задачи:",
        "Проверить событие"
      );
      if (!taskTitle?.trim()) {
        await load();
        return;
      }

      const draft = await apiRequest<{
        id: string;
        version: number;
        validation: string[];
      }>("/workflows/" + workflow.id + "/versions", {
        method: "POST",
        body: JSON.stringify({
          conditions: [],
          actions: [
            {
              type: "CREATE_TASK",
              title: taskTitle.trim(),
              dueInHours: 24
            }
          ]
        })
      });

      if (draft.validation.length) {
        setError(draft.validation.join("; "));
        return;
      }

      const test = await apiRequest<{
        matched: boolean;
        validation: string[];
      }>("/workflows/versions/" + draft.id + "/test", {
        method: "POST",
        body: JSON.stringify({ payload: {} })
      });

      if (!test.matched || test.validation.length) {
        setError(test.validation.join("; ") || "Тест workflow не прошёл");
        return;
      }

      await apiRequest("/workflows/versions/" + draft.id + "/publish", {
        method: "POST"
      });

      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать workflow");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="workflows" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Автоматизация / WHEN · IF · THEN</p>
            <h1>Автоматизации</h1>
            <p className="workspace-summary">
              Правила работают через outbox и не могут напрямую менять Core или ledger.
            </p>
          </div>

          <button onClick={() => void createWorkflow()} type="button">
            + Автоматизация
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="workflow-grid">
          {workflows.map((workflow) => (
            <article className="workflow-card" key={workflow.id}>
              <div>
                <span className="status-pill">
                  {workflow.enabled ? "Включена" : "Выключена"}
                </span>
                <strong>{workflow.name}</strong>
                <small>{workflow.trigger_event}</small>
              </div>

              <div>
                <span>Версия</span>
                <strong>{workflow.published_version ?? "Draft"}</strong>
              </div>
            </article>
          ))}

          {!workflows.length ? (
            <div className="table-empty">
              <strong>Автоматизаций пока нет</strong>
              <span>Создайте первое правило без изменения бизнес-ядра.</span>
            </div>
          ) : null}
        </div>

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">Execution log</p>
              <h2>Последние запуски</h2>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th>Статус</th>
                  <th>Старт</th>
                  <th>Ошибка</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((execution) => (
                  <tr key={execution.id}>
                    <td><strong>{execution.workflow_name}</strong></td>
                    <td><span className="status-pill">{execution.status}</span></td>
                    <td>{new Date(execution.started_at).toLocaleString("ru-RU")}</td>
                    <td>{execution.error_message ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
  );
}
