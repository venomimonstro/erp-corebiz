"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Service = {
  id: string;
  name: string;
  category: string | null;
  duration_minutes: number;
  price_minor: string;
  currency: string;
};

type Resource = {
  id: string;
  name: string;
  type: string;
};

type Booking = {
  id: string;
  business_number: string;
  status: string;
  source: string;
  starts_at: string;
  ends_at: string;
  price_minor_snapshot: string;
  currency: string;
  version: number;
  party_name: string | null;
  service_name: string;
  resources: Array<{
    resourceId: string;
    resourceName: string;
    type: string;
    capacityUnits: number;
  }>;
};

// datetime-local expects wall-clock time, not a UTC ISO timestamp.
function toLocalDateTimeInput(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" +
    pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
}

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function BookingsPage() {
  const [services, setServices] = useState<Service[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);
  const [resourceFilter, setResourceFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedService, setSelectedService] = useState("");
  const [selectedResource, setSelectedResource] = useState("");
  const [selectedStart, setSelectedStart] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setError("");

    try {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      from.setDate(from.getDate() + weekOffset * 7);
      const to = new Date(from);
      to.setDate(to.getDate() + 7);

      const data = await Promise.all([
        apiRequest<Service[]>("/service/catalog"),
        apiRequest<Resource[]>("/service/resources"),
        apiRequest<Booking[]>(
          "/service/bookings?from=" +
            encodeURIComponent(from.toISOString()) +
            "&to=" +
            encodeURIComponent(to.toISOString())
        )
      ]);

      setServices(data[0]);
      setResources(data[1]);
      setBookings(data[2]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить записи");
    }
  }, [weekOffset]);

  useEffect(() => {
    void load();
  }, [load]);

  const grouped = useMemo(() => {
    const map = new Map<string, Booking[]>();

    for (const booking of bookings) {
      if (resourceFilter && !booking.resources.some((r) => r.resourceId === resourceFilter)) continue;
      const key = new Date(booking.starts_at).toLocaleDateString("ru-RU");
      const rows = map.get(key) ?? [];
      rows.push(booking);
      map.set(key, rows);
    }

    return Array.from(map.entries());
  }, [bookings, resourceFilter]);

  async function createService() {
    const name = window.prompt("Название услуги");
    if (!name?.trim()) return;

    const duration = Number(window.prompt("Длительность, минут", "60") ?? "60");
    const priceRub = Number(
      (window.prompt("Цена, ₽", "0") ?? "0").replace(",", ".")
    );

    if (
      !Number.isFinite(duration) ||
      duration < 5 ||
      !Number.isFinite(priceRub) ||
      priceRub < 0
    ) {
      setError("Некорректная длительность или цена");
      return;
    }

    try {
      await apiRequest("/service/catalog", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          durationMinutes: Math.round(duration),
          priceMinor: String(Math.round(priceRub * 100))
        })
      });

      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать услугу");
    }
  }

  async function createBooking() {
    if (!selectedService || !selectedResource || !selectedStart) {
      setError("Выберите услугу, сотрудника или ресурс и время");
      return;
    }
    const parsed = new Date(selectedStart);
    if (Number.isNaN(parsed.getTime())) {
      setError("Некорректная дата записи");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await apiRequest("/service/bookings", {
        method: "POST",
        body: JSON.stringify({
          serviceId: selectedService,
          resourceIds: [selectedResource],
          startsAt: parsed.toISOString(),
          source: "MANUAL",
          idempotencyKey: crypto.randomUUID()
        })
      });
      setShowCreate(false);
      setSelectedStart("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать запись");
    } finally {
      setSubmitting(false);
    }
  }

  async function reschedule(booking: Booking) {
    const startsAt = window.prompt(
      "Новое время начала",
      toLocalDateTimeInput(new Date(booking.starts_at))
    );
    if (!startsAt) return;

    try {
      await apiRequest("/service/bookings/" + booking.id + "/reschedule", {
        method: "PATCH",
        body: JSON.stringify({
          startsAt,
          version: booking.version
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось перенести запись");
    }
  }

  async function changeStatus(
    booking: Booking,
    status: "ARRIVED" | "IN_SERVICE" | "COMPLETED" | "CANCELLED" | "NO_SHOW"
  ) {
    try {
      await apiRequest("/service/bookings/" + booking.id + "/status", {
        method: "PATCH",
        body: JSON.stringify({
          status,
          version: booking.version
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить статус");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="bookings" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Сервис / Календарь</p>
            <h1>Записи</h1>
            <p className="workspace-summary">
              Услуга резервирует реальную мощность ресурса и не допускает двойную запись.
            </p>
          </div>

          <div className="header-actions">
            <button className="secondary-button" onClick={() => void createService()} type="button">
              + Услуга
            </button>
            <button onClick={() => { setShowCreate((v) => !v); setError(""); }} type="button">
              + Запись
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {showCreate ? (
          <form className="settings-card" onSubmit={(e) => { e.preventDefault(); void createBooking(); }} style={{ marginBottom: 16 }}>
            <h2>Новая запись</h2>
            <p className="muted">Выберите услугу, ресурс и местное время. Доступность проверяется сервером.</p>
            <div className="header-actions" style={{ flexWrap: "wrap" }}>
              <label>Услуга{" "}
                <select required value={selectedService} onChange={(e) => setSelectedService(e.target.value)}>
                  <option value="">Выбрать услугу</option>
                  {services.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.duration_minutes} мин</option>)}
                </select>
              </label>
              <label>Сотрудник или ресурс{" "}
                <select required value={selectedResource} onChange={(e) => setSelectedResource(e.target.value)}>
                  <option value="">Выбрать ресурс</option>
                  {resources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>Начало{" "}
                <input required type="datetime-local" value={selectedStart} onChange={(e) => setSelectedStart(e.target.value)} />
              </label>
              <button type="submit" disabled={submitting}>{submitting ? "Сохраняем…" : "Записать"}</button>
              <button className="secondary-button" type="button" onClick={() => setShowCreate(false)}>Отмена</button>
            </div>
          </form>
        ) : null}

        <div className="header-actions" aria-label="Навигация по календарю" style={{ marginBottom: 16, flexWrap: "wrap" }}>
          <button type="button" className="secondary-button" onClick={() => setWeekOffset((n) => n - 1)}>
            ← Предыдущие 7 дней
          </button>
          <button type="button" className="secondary-button" onClick={() => setWeekOffset(0)}>
            Сегодня
          </button>
          <button type="button" className="secondary-button" onClick={() => setWeekOffset((n) => n + 1)}>
            Следующие 7 дней →
          </button>
          <label>
            Ресурс:{" "}
            <select aria-label="Фильтр по сотруднику или ресурсу" value={resourceFilter} onChange={(e) => setResourceFilter(e.target.value)}>
              <option value="">Все сотрудники и ресурсы</option>
              {resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
        </div>

        {!grouped.length ? (
          <div className="table-empty" role="status">
            <strong>На выбранной неделе записей нет</strong>
            <span>Выберите другой период, ресурс или создайте новую запись.</span>
          </div>
        ) : null}
        <div className="booking-calendar">
          {grouped.map(([date, rows]) => (
            <section className="booking-day" key={date}>
              <header>
                <strong>{date}</strong>
                <span>{rows.length} записей</span>
              </header>

              <div className="booking-list">
                {rows.map((booking) => (
                  <article className="booking-card" key={booking.id}>
                    <div className="booking-time">
                      <strong>
                        {new Date(booking.starts_at).toLocaleTimeString("ru-RU", {
                          hour: "2-digit",
                          minute: "2-digit"
                        })}
                      </strong>
                      <span>
                        {new Date(booking.ends_at).toLocaleTimeString("ru-RU", {
                          hour: "2-digit",
                          minute: "2-digit"
                        })}
                      </span>
                    </div>

                    <div className="booking-main">
                      <div>
                        <strong>{booking.service_name}</strong>
                        <span>
                          {booking.party_name ?? "Без клиента"} ·{" "}
                          {booking.resources.map((item) => item.resourceName).join(", ")}
                        </span>
                      </div>
                      <div>
                        <span className="status-pill">{booking.status}</span>
                        <strong>
                          {money(booking.price_minor_snapshot, booking.currency)}
                        </strong>
                      </div>
                    </div>

                    <div className="booking-actions">
                      {booking.status === "CONFIRMED" ? (
                        <>
                          <button
                            className="secondary-button"
                            onClick={() => void reschedule(booking)}
                            type="button"
                          >
                            Перенести
                          </button>
                          <button
                            onClick={() => void changeStatus(booking, "ARRIVED")}
                            type="button"
                          >
                            Пришёл
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() => void changeStatus(booking, "NO_SHOW")}
                            type="button"
                          >
                            Не пришёл
                          </button>
                        </>
                      ) : null}

                      {booking.status === "ARRIVED" ? (
                        <button
                          onClick={() => void changeStatus(booking, "IN_SERVICE")}
                          type="button"
                        >
                          Начать
                        </button>
                      ) : null}

                      {booking.status === "IN_SERVICE" ? (
                        <button
                          onClick={() => void changeStatus(booking, "COMPLETED")}
                          type="button"
                        >
                          Завершить
                        </button>
                      ) : null}

                      {!["COMPLETED", "CANCELLED", "NO_SHOW"].includes(
                        booking.status
                      ) ? (
                        <button
                          className="secondary-button"
                          onClick={() => void changeStatus(booking, "CANCELLED")}
                          type="button"
                        >
                          Отменить
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ))}

          {!bookings.length ? (
            <div className="table-empty">
              <strong>Записей пока нет</strong>
              <span>Создайте услугу и первую запись клиента.</span>
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
