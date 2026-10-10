"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest } from "../lib/api";

type QueueItem = {
  sourceKey: string;
  domain: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  title: string;
  detail: string;
  href: string;
  createdAt: string;
  state: "UNREAD" | "READ";
};

type QueueResponse = {
  unread: number;
  items: QueueItem[];
};

export function ActionQueueCenter() {
  const [data, setData] = useState<QueueResponse>({
    unread: 0,
    items: []
  });
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await apiRequest<QueueResponse>("/action-queue"));
      setError("");
    } catch {
      // The notification center must never block normal navigation.
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  async function state(
    sourceKey: string,
    next: "UNREAD" | "READ" | "SNOOZED"
  ) {
    try {
      await apiRequest("/action-queue/state", {
        method: "PUT",
        body: JSON.stringify({
          sourceKey,
          state: next,
          ...(next === "SNOOZED"
            ? {
                snoozedUntil: new Date(
                  Date.now() + 24 * 3600000
                ).toISOString()
              }
            : {})
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось изменить уведомление"
      );
    }
  }

  async function openItem(item: QueueItem) {
    if (item.state === "UNREAD") {
      try {
        await apiRequest("/action-queue/state", {
          method: "PUT",
          body: JSON.stringify({
            sourceKey: item.sourceKey,
            state: "READ"
          })
        });
      } catch {
        // Navigation to the real source is more important than read-state.
      }
    }

    window.location.href = item.href;
  }

  return (
    <div className="action-center-wrap">
      <button
        className="sidebar-action-trigger"
        type="button"
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
        aria-expanded={open}
      >
        <span>Требует внимания</span>
        <b>{data.unread}</b>
      </button>

      {open ? (
        <section className="action-center-panel">
          <header>
            <div>
              <small>Личная очередь</small>
              <strong>Требует внимания</strong>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>

          {error ? <div className="action-center-error">{error}</div> : null}

          <div className="action-center-list">
            {data.items.slice(0, 50).map((item) => (
              <article
                className={
                  item.state === "READ"
                    ? "action-center-item read"
                    : "action-center-item"
                }
                key={item.sourceKey}
              >
                <button
                  className="action-center-main"
                  type="button"
                  onClick={() => void openItem(item)}
                >
                  <span
                    className={
                      "severity-dot " +
                      item.severity.toLowerCase()
                    }
                  />
                  <div>
                    <small>{item.domain}</small>
                    <strong>{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                </button>

                <div className="action-center-actions">
                  <button
                    type="button"
                    onClick={() =>
                      void state(
                        item.sourceKey,
                        item.state === "READ" ? "UNREAD" : "READ"
                      )
                    }
                  >
                    {item.state === "READ" ? "Не прочитано" : "Прочитано"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void state(item.sourceKey, "SNOOZED")
                    }
                  >
                    На 24 ч.
                  </button>
                </div>
              </article>
            ))}

            {!data.items.length ? (
              <div className="command-empty">
                <strong>Очередь пуста</strong>
                <span>
                  Новые задачи и исключения появятся здесь автоматически.
                </span>
              </div>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
