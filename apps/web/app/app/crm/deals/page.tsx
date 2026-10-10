"use client";

import {
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useState
} from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Deal = {
  id: string;
  title: string;
  amountMinor: string;
  currency: string;
  partyName: string | null;
  responsibleMembershipId: string | null;
  version: number;
  hasNextAction: boolean;
  overdueTasks: number;
};

type Stage = {
  id: string;
  name: string;
  kind: "NORMAL" | "WON" | "LOST";
  position: number;
  color: string | null;
  deals: Deal[];
};

type Board = {
  pipeline: { id: string; name: string };
  stages: Stage[];
};

type DragPayload = {
  dealId: string;
  version: number;
};

function formatMoney(amountMinor: string, currency: string): string {
  const amount = Number(amountMinor) / 100;
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(amount);
}

export default function DealsPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [moving, setMoving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError("");
    try {
      const data = await apiRequest<Board>("/crm/board");
      setBoard(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить CRM");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") !== "1") return;

    params.delete("create");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (next ? "?" + next : "")
    );
    void quickCreate();
  }, []);

  const totals = useMemo(() => {
    if (!board) return { deals: 0, amountMinor: 0 };
    return board.stages.reduce(
      (acc, stage) => {
        acc.deals += stage.deals.length;
        acc.amountMinor += stage.deals.reduce(
          (sum, deal) => sum + Number(deal.amountMinor),
          0
        );
        return acc;
      },
      { deals: 0, amountMinor: 0 }
    );
  }, [board]);

  function startDrag(event: DragEvent, deal: Deal) {
    const payload: DragPayload = {
      dealId: deal.id,
      version: deal.version
    };
    event.dataTransfer.setData("application/json", JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "move";
  }

  async function dropOnStage(event: DragEvent, stage: Stage) {
    event.preventDefault();

    const raw = event.dataTransfer.getData("application/json");
    if (!raw) return;

    const payload = JSON.parse(raw) as DragPayload;
    let lostReason: string | undefined;

    if (stage.kind === "LOST") {
      const reason = window.prompt("Почему сделка проиграна?");
      if (!reason?.trim()) return;
      lostReason = reason.trim();
    }

    setMoving(payload.dealId);
    setError("");

    try {
      await apiRequest(`/crm/deals/${payload.dealId}/stage`, {
        method: "PATCH",
        body: JSON.stringify({
          toStageId: stage.id,
          version: payload.version,
          ...(lostReason ? { lostReason } : {})
        })
      });

      if (
        stage.kind === "WON" &&
        window.confirm("Сделка успешна. Создать заказ?")
      ) {
        const order = await apiRequest<{ number: string }>(
          `/sales/orders/from-deal/${payload.dealId}`,
          {
            method: "POST",
            body: JSON.stringify({
              idempotencyKey: `deal:${payload.dealId}:order:1`
            })
          }
        );

        window.alert(`Создан заказ ${order.number}`);
      }

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось перенести сделку"
      );
      await load();
    } finally {
      setMoving(null);
    }
  }

  async function quickCreate() {
    const title = window.prompt("Название сделки");
    if (!title?.trim()) return;

    const amountRub = window.prompt("Сумма, ₽", "0") ?? "0";
    const amount = Number(amountRub.replace(",", "."));

    if (!Number.isFinite(amount) || amount < 0) {
      setError("Некорректная сумма");
      return;
    }

    try {
      await apiRequest("/crm/deals", {
        method: "POST",
        body: JSON.stringify({
          title: title.trim(),
          amountMinor: String(Math.round(amount * 100))
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось создать сделку"
      );
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="deals" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">CRM / Продажи</p>
            <h1>{board?.pipeline.name ?? "Сделки"}</h1>
            {board ? (
              <p className="workspace-summary">
                {totals.deals} сделок · {formatMoney(String(totals.amountMinor), "RUB")}
              </p>
            ) : null}
          </div>

          <button onClick={quickCreate} type="button">+ Сделка</button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? (
          <div className="board-loading">Загружаем воронку…</div>
        ) : null}

        {!loading && board ? (
          <div className="kanban">
            {board.stages.map((stage) => {
              const stageAmount = stage.deals.reduce(
                (sum, deal) => sum + Number(deal.amountMinor),
                0
              );

              return (
                <section
                  className="kanban-column"
                  key={stage.id}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => void dropOnStage(event, stage)}
                >
                  <header className="kanban-column-header">
                    <div>
                      <span
                        className="stage-dot"
                        style={{ background: stage.color ?? "#9ca3af" }}
                      />
                      <strong>{stage.name}</strong>
                    </div>
                    <small>
                      {stage.deals.length} · {formatMoney(String(stageAmount), "RUB")}
                    </small>
                  </header>

                  <div className="kanban-cards">
                    {stage.deals.map((deal) => (
                      <article
                        className={[
                          "deal-card",
                          moving === deal.id ? "is-moving" : ""
                        ].join(" ")}
                        draggable
                        key={deal.id}
                        onDragStart={(event) => startDrag(event, deal)}
                      >
                        <strong>{deal.title}</strong>
                        <span className="deal-amount">
                          {formatMoney(deal.amountMinor, deal.currency)}
                        </span>
                        <span className="deal-party">
                          {deal.partyName ?? "Клиент не указан"}
                        </span>

                        <footer>
                          {deal.overdueTasks > 0 ? (
                            <span className="deal-alert danger">
                              Просрочено: {deal.overdueTasks}
                            </span>
                          ) : !deal.hasNextAction && stage.kind === "NORMAL" ? (
                            <span className="deal-alert warning">
                              Нет следующего действия
                            </span>
                          ) : (
                            <span className="deal-alert ok">Следующее действие есть</span>
                          )}
                        </footer>
                      </article>
                    ))}

                    {stage.deals.length === 0 ? (
                      <div className="kanban-empty">Перетащите сделку сюда</div>
                    ) : null}
                  </div>
                </section>
              );
            })}
          </div>
        ) : null}

        {!loading && !board && !error ? (
          <div className="empty-state">
            <h2>Воронка пока недоступна</h2>
            <p>После настройки компании здесь появятся сделки.</p>
          </div>
        ) : null}
      </section>
    </main>
  );
}
