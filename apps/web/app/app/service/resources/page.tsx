"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Resource = {
  id: string;
  branch_id: string | null;
  branch_name: string | null;
  membership_id: string | null;
  type: string;
  name: string;
  code: string | null;
  capacity: number;
  cost_per_hour_minor: string;
  currency: string;
  timezone: string;
  skills: Array<{
    id: string;
    code: string;
    name: string;
    level: number;
  }>;
};

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function ResourcesPage() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      setResources(await apiRequest<Resource[]>("/service/resources"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить ресурсы");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createResource() {
    const name = window.prompt("Название ресурса");
    if (!name?.trim()) return;

    const type = (
      window.prompt(
        "Тип: EMPLOYEE, ROOM, EQUIPMENT, VEHICLE, WORKPLACE, HALL, MACHINE",
        "EMPLOYEE"
      ) ?? "EMPLOYEE"
    ).toUpperCase();

    const allowed = [
      "EMPLOYEE",
      "ROOM",
      "EQUIPMENT",
      "VEHICLE",
      "WORKPLACE",
      "HALL",
      "MACHINE",
      "OTHER"
    ];

    if (!allowed.includes(type)) {
      setError("Неизвестный тип ресурса");
      return;
    }

    const capacity = Number(window.prompt("Вместимость", "1") ?? "1");
    const costRub = Number(
      (window.prompt("Себестоимость часа, ₽", "0") ?? "0").replace(",", ".")
    );

    if (
      !Number.isFinite(capacity) ||
      capacity < 1 ||
      !Number.isFinite(costRub) ||
      costRub < 0
    ) {
      setError("Некорректная вместимость или стоимость");
      return;
    }

    try {
      await apiRequest("/service/resources", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          type,
          capacity: Math.floor(capacity),
          costPerHourMinor: String(Math.round(costRub * 100))
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать ресурс");
    }
  }

  async function setSchedule(resource: Resource) {
    const start = Number(
      window.prompt(
        "Начало рабочего дня в часах, например 9",
        "9"
      ) ?? "9"
    );
    const end = Number(
      window.prompt(
        "Конец рабочего дня в часах, например 18",
        "18"
      ) ?? "18"
    );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end > 24 ||
      end <= start
    ) {
      setError("Некорректный рабочий день");
      return;
    }

    const windows = [1, 2, 3, 4, 5].map((weekday) => ({
      weekday,
      startMinute: Math.round(start * 60),
      endMinute: Math.round(end * 60)
    }));

    try {
      await apiRequest("/service/resources/" + resource.id + "/schedule", {
        method: "PUT",
        body: JSON.stringify({ windows })
      });
      window.alert("График сохранён: Пн–Пт");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить график");
    }
  }

  async function blockResource(resource: Resource) {
    const startsAt = window.prompt(
      "Недоступен с, ISO или дата-время",
      new Date().toISOString().slice(0, 16)
    );
    if (!startsAt) return;

    const endsAt = window.prompt(
      "Недоступен до, ISO или дата-время",
      new Date(Date.now() + 3600000).toISOString().slice(0, 16)
    );
    if (!endsAt) return;

    try {
      await apiRequest("/service/resources/" + resource.id + "/blocks", {
        method: "POST",
        body: JSON.stringify({
          startsAt,
          endsAt,
          type: "UNAVAILABLE",
          reason: "Ручная блокировка"
        })
      });
      window.alert("Период недоступности добавлен");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось заблокировать ресурс");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="resources" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Сервис / Мощности</p>
            <h1>Ресурсы</h1>
            <p className="workspace-summary">
              Люди, кабинеты, боксы, оборудование, транспорт и рабочие места.
            </p>
          </div>

          <button onClick={() => void createResource()} type="button">
            + Ресурс
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="resource-grid">
          {resources.map((resource) => (
            <article className="resource-card" key={resource.id}>
              <header>
                <div>
                  <span>{resource.type}</span>
                  <h2>{resource.name}</h2>
                </div>
                <span className="status-pill">
                  вместимость {resource.capacity}
                </span>
              </header>

              <dl>
                <div>
                  <dt>Филиал</dt>
                  <dd>{resource.branch_name ?? "Не привязан"}</dd>
                </div>
                <div>
                  <dt>Себестоимость часа</dt>
                  <dd>{money(resource.cost_per_hour_minor, resource.currency)}</dd>
                </div>
                <div>
                  <dt>Навыки</dt>
                  <dd>
                    {resource.skills.length
                      ? resource.skills.map((skill) => skill.name).join(", ")
                      : "Не указаны"}
                  </dd>
                </div>
              </dl>

              <div className="header-actions">
                <button
                  className="secondary-button"
                  onClick={() => void setSchedule(resource)}
                  type="button"
                >
                  График
                </button>
                <button
                  onClick={() => void blockResource(resource)}
                  type="button"
                >
                  Недоступность
                </button>
              </div>
            </article>
          ))}

          {!resources.length ? (
            <div className="table-empty">
              <strong>Ресурсов пока нет</strong>
              <span>
                Добавьте сотрудника, кабинет, бокс, оборудование или другой ресурс.
              </span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
