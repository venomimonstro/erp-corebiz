"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Ticket = {
  id: string;
  number: string;
  subject: string;
  status: string;
  priority: string;
  category: string | null;
  contextUrl: string | null;
  updatedAt: string;
};

type TicketDetails = {
  ticket: {
    id: string;
    number: string;
    subject: string;
    status: string;
    priority: string;
    category: string | null;
    contextUrl: string | null;
    createdAt: string;
    updatedAt: string;
  };
  messages: Array<{
    id: string;
    body: string;
    visibility: string;
    authorMembershipId: string | null;
    createdAt: string;
  }>;
  attachments: Array<{
    id: string;
    filename: string;
    sizeBytes: string;
    createdAt: string;
  }>;
};

type Article = {
  id: string;
  slug: string;
  title: string;
  category: string | null;
  bodyMarkdown: string;
};

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<TicketDetails | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const loadTickets = useCallback(async () => {
    setError("");
    try {
      setTickets(await apiRequest<Ticket[]>("/support/tickets"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить поддержку");
    }
  }, []);

  const searchKnowledge = useCallback(async (value = "") => {
    try {
      const path = value.trim()
        ? "/support/knowledge?q=" + encodeURIComponent(value.trim())
        : "/support/knowledge";
      setArticles(await apiRequest<Article[]>(path));
    } catch {
      setArticles([]);
    }
  }, []);

  useEffect(() => {
    void loadTickets();
    void searchKnowledge();
  }, [loadTickets, searchKnowledge]);

  async function openTicket(id: string) {
    setPending(true);
    setError("");
    try {
      setSelected(await apiRequest<TicketDetails>("/support/tickets/" + id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть тикет");
    } finally {
      setPending(false);
    }
  }

  async function createTicket() {
    const subject = window.prompt("Кратко опишите проблему");
    if (!subject?.trim()) return;

    const body = window.prompt("Что произошло и что вы ожидали?");
    if (!body?.trim()) return;

    const contextUrl = window.location.href;

    setPending(true);
    setError("");
    try {
      const created = await apiRequest<{ id: string; number: string }>(
        "/support/tickets",
        {
          method: "POST",
          body: JSON.stringify({
            subject: subject.trim(),
            body: body.trim(),
            contextUrl
          })
        }
      );

      await loadTickets();
      await openTicket(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать тикет");
    } finally {
      setPending(false);
    }
  }

  async function sendReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || !reply.trim()) return;

    setPending(true);
    setError("");
    try {
      await apiRequest(
        "/support/tickets/" + selected.ticket.id + "/reply",
        {
          method: "POST",
          body: JSON.stringify({ body: reply.trim() })
        }
      );
      setReply("");
      await openTicket(selected.ticket.id);
      await loadTickets();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось отправить сообщение");
    } finally {
      setPending(false);
    }
  }

  async function closeTicket() {
    if (!selected) return;
    if (!window.confirm("Закрыть тикет " + selected.ticket.number + "?")) return;

    try {
      await apiRequest(
        "/support/tickets/" + selected.ticket.id + "/close",
        { method: "PATCH" }
      );
      await loadTickets();
      await openTicket(selected.ticket.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось закрыть тикет");
    }
  }

  async function createGrant() {
    const reason = window.prompt(
      "Для чего поддержке нужен временный доступ?",
      "Диагностика обращения"
    );
    if (!reason?.trim()) return;

    try {
      const grant = await apiRequest<{
        token: string;
        grantId: string;
        expiresAt: string;
      }>("/support/grants", {
        method: "POST",
        body: JSON.stringify({
          hours: 4,
          scopes: ["read"],
          reason: reason.trim()
        })
      });

      window.prompt(
        "Одноразовый токен поддержки. Он больше не будет показан:",
        grant.token
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать временный доступ");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="support" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Помощь / Поддержка</p>
            <h1>Поддержка</h1>
            <p className="workspace-summary">
              Контекст обращения сохраняется, постоянного доступа поддержки к компании нет.
            </p>
          </div>

          <div className="header-actions">
            <button className="secondary-button" onClick={() => void createGrant()} type="button">
              Временный доступ
            </button>
            <button disabled={pending} onClick={() => void createTicket()} type="button">
              + Тикет
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="support-layout">
          <section className="support-list">
            <div className="support-panel-title">
              <strong>Обращения</strong>
              <span>{tickets.length}</span>
            </div>

            <div className="support-ticket-list">
              {tickets.map((ticket) => (
                <button
                  className={
                    selected?.ticket.id === ticket.id
                      ? "support-ticket active"
                      : "support-ticket"
                  }
                  key={ticket.id}
                  onClick={() => void openTicket(ticket.id)}
                  type="button"
                >
                  <div>
                    <strong>{ticket.subject}</strong>
                    <span>{ticket.number}</span>
                  </div>
                  <small>{ticket.status}</small>
                </button>
              ))}

              {!tickets.length ? (
                <div className="support-empty">
                  <strong>Обращений нет</strong>
                  <span>Создайте тикет, если нужна помощь команды.</span>
                </div>
              ) : null}
            </div>
          </section>

          <section className="support-conversation">
            {selected ? (
              <>
                <header>
                  <div>
                    <span>{selected.ticket.number}</span>
                    <h2>{selected.ticket.subject}</h2>
                  </div>
                  <div className="header-actions">
                    <span className="status-pill">{selected.ticket.status}</span>
                    {selected.ticket.status !== "CLOSED" ? (
                      <button
                        className="secondary-button"
                        onClick={() => void closeTicket()}
                        type="button"
                      >
                        Закрыть
                      </button>
                    ) : null}
                  </div>
                </header>

                {selected.ticket.contextUrl ? (
                  <div className="ticket-context">
                    Контекст: {selected.ticket.contextUrl}
                  </div>
                ) : null}

                <div className="message-stream">
                  {selected.messages.map((message) => (
                    <article className="support-message" key={message.id}>
                      <p>{message.body}</p>
                      <small>
                        {new Date(message.createdAt).toLocaleString("ru-RU")}
                      </small>
                    </article>
                  ))}
                </div>

                {selected.ticket.status !== "CLOSED" ? (
                  <form className="support-reply" onSubmit={sendReply}>
                    <textarea
                      onChange={(event) => setReply(event.target.value)}
                      placeholder="Напишите сообщение поддержке…"
                      rows={3}
                      value={reply}
                    />
                    <button disabled={pending || !reply.trim()} type="submit">
                      Отправить
                    </button>
                  </form>
                ) : null}
              </>
            ) : (
              <div className="support-empty conversation-empty">
                <strong>Выберите обращение</strong>
                <span>История переписки появится здесь.</span>
              </div>
            )}
          </section>

          <aside className="knowledge-panel">
            <div className="support-panel-title">
              <strong>База знаний</strong>
            </div>

            <div className="knowledge-search">
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Поиск ответа"
                value={query}
              />
              <button onClick={() => void searchKnowledge(query)} type="button">
                Найти
              </button>
            </div>

            <div className="knowledge-list">
              {articles.map((article) => (
                <article key={article.id}>
                  <span>{article.category ?? "Помощь"}</span>
                  <strong>{article.title}</strong>
                  <p>{article.bodyMarkdown.replace(/#/g, "").slice(0, 180)}</p>
                </article>
              ))}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
