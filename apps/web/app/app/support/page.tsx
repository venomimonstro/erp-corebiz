"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
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

type Telemetry = {
  periodDays: number;
  searches: number;
  noResult: number;
  helpfulYes: number;
  helpfulNo: number;
  ticketsAfterSearch: number;
  selfServiceRatePercent: number | null;
  gaps: Array<{
    query_text: string;
    searches: string;
    tickets: string;
  }>;
};

export default function SupportPage() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [selected, setSelected] = useState<TicketDetails | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [selectedArticle, setSelectedArticle] = useState<Article | null>(null);
  const [searchId, setSearchId] = useState("");
  const [query, setQuery] = useState("");
  const [reply, setReply] = useState("");
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const contextUrl = useMemo(() => {
    if (typeof window === "undefined") return "/app/support";
    const params = new URLSearchParams(window.location.search);
    return params.get("from") || window.location.pathname;
  }, []);

  const loadTickets = useCallback(async () => {
    setError("");
    try {
      setTickets(await apiRequest<Ticket[]>("/support/tickets"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить поддержку"
      );
    }
  }, []);

  const loadTelemetry = useCallback(async () => {
    try {
      setTelemetry(
        await apiRequest<Telemetry>("/support/knowledge/telemetry")
      );
    } catch {
      // Telemetry is intentionally owner/admin only.
      setTelemetry(null);
    }
  }, []);

  const searchKnowledge = useCallback(
    async (value = "") => {
      try {
        const result = await apiRequest<{
          searchId: string;
          articles: Article[];
        }>("/support/knowledge/search", {
          method: "POST",
          body: JSON.stringify({
            query: value.trim(),
            contextUrl
          })
        });
        setSearchId(result.searchId);
        setArticles(result.articles);
        setSelectedArticle(null);
      } catch {
        setArticles([]);
        setSearchId("");
      }
    },
    [contextUrl]
  );

  useEffect(() => {
    void loadTickets();
    void searchKnowledge("");
    void loadTelemetry();
  }, [loadTickets, searchKnowledge, loadTelemetry]);

  async function openTicket(id: string) {
    setPending(true);
    setError("");
    try {
      setSelected(
        await apiRequest<TicketDetails>("/support/tickets/" + id)
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось открыть тикет"
      );
    } finally {
      setPending(false);
    }
  }

  async function selectArticle(article: Article) {
    setSelectedArticle(article);
    if (!searchId) return;

    try {
      await apiRequest(
        "/support/knowledge/search/" + searchId + "/select",
        {
          method: "POST",
          body: JSON.stringify({ articleId: article.id })
        }
      );
    } catch {
      // Selection telemetry must never block help content.
    }
  }

  async function feedback(helpful: boolean) {
    if (!searchId) return;

    try {
      await apiRequest(
        "/support/knowledge/search/" + searchId + "/feedback",
        {
          method: "POST",
          body: JSON.stringify({ helpful })
        }
      );
      await loadTelemetry();
    } catch {
      // Feedback is optional UX telemetry.
    }
  }

  async function createTicket() {
    const subject = window.prompt(
      "Кратко опишите проблему",
      query.trim() || undefined
    );
    if (!subject?.trim()) return;

    const body = window.prompt("Что произошло и что вы ожидали?");
    if (!body?.trim()) return;

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
            contextUrl,
            knowledgeSearchId: searchId || undefined
          })
        }
      );

      await Promise.all([loadTickets(), loadTelemetry()]);
      await openTicket(created.id);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать тикет"
      );
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
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось отправить сообщение"
      );
    } finally {
      setPending(false);
    }
  }

  async function closeTicket() {
    if (!selected) return;
    if (
      !window.confirm(
        "Закрыть тикет " + selected.ticket.number + "?"
      )
    ) {
      return;
    }

    try {
      await apiRequest(
        "/support/tickets/" + selected.ticket.id + "/close",
        { method: "PATCH" }
      );
      await loadTickets();
      await openTicket(selected.ticket.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось закрыть тикет"
      );
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
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать временный доступ"
      );
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
              Сначала найдите ответ. Если он не помог, тикет сохранит поиск и
              экран, на котором возникла проблема.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="secondary-button"
              onClick={() => void createGrant()}
              type="button"
            >
              Временный доступ
            </button>
            <button
              disabled={pending}
              onClick={() => void createTicket()}
              type="button"
            >
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

        {telemetry ? (
          <section className="support-self-service">
            <article className="owner-kpi">
              <span>Поисков за {telemetry.periodDays} дней</span>
              <strong>{telemetry.searches}</strong>
              <small>Без результата: {telemetry.noResult}</small>
            </article>
            <article className="owner-kpi">
              <span>Решено без тикета</span>
              <strong>
                {telemetry.selfServiceRatePercent === null
                  ? "—"
                  : telemetry.selfServiceRatePercent + "%"}
              </strong>
              <small>Тикетов после поиска: {telemetry.ticketsAfterSearch}</small>
            </article>
            <article className="owner-kpi">
              <span>Ответ помог</span>
              <strong>{telemetry.helpfulYes}</strong>
              <small>Не помог: {telemetry.helpfulNo}</small>
            </article>
            <article className="owner-kpi">
              <span>Главный пробел</span>
              <strong className="support-gap-kpi">
                {telemetry.gaps[0]?.query_text ?? "Нет данных"}
              </strong>
              <small>
                {telemetry.gaps[0]
                  ? "поисков " +
                    telemetry.gaps[0].searches +
                    " · тикетов " +
                    telemetry.gaps[0].tickets
                  : "Проблемные запросы не накоплены"}
              </small>
            </article>
          </section>
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
                  <span>Если база знаний не поможет, создайте тикет.</span>
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
                    <span className="status-pill">
                      {selected.ticket.status}
                    </span>
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
                    <article
                      className="support-message"
                      key={message.id}
                    >
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
                    <button
                      disabled={pending || !reply.trim()}
                      type="submit"
                    >
                      Отправить
                    </button>
                  </form>
                ) : null}
              </>
            ) : selectedArticle ? (
              <article className="knowledge-article-open">
                <button
                  className="secondary-button"
                  onClick={() => setSelectedArticle(null)}
                  type="button"
                >
                  ← К результатам
                </button>
                <span>{selectedArticle.category ?? "Помощь"}</span>
                <h2>{selectedArticle.title}</h2>
                <div className="knowledge-article-body">
                  {selectedArticle.bodyMarkdown}
                </div>
                <div className="knowledge-feedback">
                  <span>Ответ решил вопрос?</span>
                  <button
                    className="secondary-button"
                    onClick={() => void feedback(true)}
                    type="button"
                  >
                    Да
                  </button>
                  <button
                    className="secondary-button"
                    onClick={() => void feedback(false)}
                    type="button"
                  >
                    Нет
                  </button>
                  <button
                    onClick={() => void createTicket()}
                    type="button"
                  >
                    Нужна поддержка
                  </button>
                </div>
              </article>
            ) : (
              <div className="support-empty conversation-empty">
                <strong>Сначала попробуйте найти ответ</strong>
                <span>
                  Если статья не поможет, создайте тикет — поиск будет связан
                  с обращением.
                </span>
              </div>
            )}
          </section>

          <aside className="knowledge-panel">
            <div className="support-panel-title">
              <strong>База знаний</strong>
              {searchId ? <span>поиск сохранён</span> : null}
            </div>

            <div className="knowledge-search">
              <input
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Поиск ответа"
                value={query}
              />
              <button
                onClick={() => void searchKnowledge(query)}
                type="button"
              >
                Найти
              </button>
            </div>

            <div className="knowledge-list">
              {articles.map((article) => (
                <button
                  className="knowledge-result"
                  key={article.id}
                  onClick={() => void selectArticle(article)}
                  type="button"
                >
                  <span>{article.category ?? "Помощь"}</span>
                  <strong>{article.title}</strong>
                  <p>
                    {article.bodyMarkdown.replace(/#/g, "").slice(0, 180)}
                  </p>
                </button>
              ))}

              {!articles.length ? (
                <div className="support-empty">
                  <strong>Ответов не найдено</strong>
                  <span>
                    Создайте тикет — этот запрос попадёт в список пробелов базы
                    знаний.
                  </span>
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
