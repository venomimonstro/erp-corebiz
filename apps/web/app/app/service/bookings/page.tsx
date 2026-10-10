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

type Customer = {
  id: string;
  displayName: string;
  phone: string | null;
  email: string | null;
};

type ServiceAsset = {
  id: string;
  party_id: string | null;
  asset_type: string;
  display_name: string;
  external_key: string | null;
  registration_number: string | null;
  manufacturer: string | null;
  model: string | null;
  usage_value: string;
  usage_unit: string;
};

type ServicePackage = {
  id: string;
  party_id: string;
  plan_name: string;
  available_visits: number | null;
  package_kind_snapshot?: string;
  expires_at: string;
  applicable_service_id: string | null;
  status: string;
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
  asset?: {
    id: string;
    assetType: string;
    displayName: string;
    externalKey: string | null;
    registrationNumber: string | null;
    usageValue: string;
    usageUnit: string;
  } | null;
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
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerAssets, setCustomerAssets] = useState<ServiceAsset[]>([]);
  const [customerPackages, setCustomerPackages] = useState<ServicePackage[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [error, setError] = useState("");
  const [weekOffset, setWeekOffset] = useState(0);
  const [resourceFilter, setResourceFilter] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [selectedService, setSelectedService] = useState("");
  const [selectedResource, setSelectedResource] = useState("");
  const [selectedCustomer, setSelectedCustomer] = useState("");
  const [selectedAsset, setSelectedAsset] = useState("");
  const [selectedPackage, setSelectedPackage] = useState("");
  const [selectedStart, setSelectedStart] = useState("");
  const [slotDate, setSlotDate] = useState("");
  const [availableSlots, setAvailableSlots] = useState<Array<{ resourceId: string; startsAt: string }>>([]);
  const [slotLoading, setSlotLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [details, setDetails] = useState<Booking | null>(null);
  const [rescheduling, setRescheduling] = useState<Booking | null>(null);
  const [rescheduleStart, setRescheduleStart] = useState("");

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
        apiRequest<Customer[]>("/crm/customers"),
        apiRequest<Booking[]>(
          "/service/bookings?from=" +
            encodeURIComponent(from.toISOString()) +
            "&to=" +
            encodeURIComponent(to.toISOString())
        )
      ]);

      setServices(data[0]);
      setResources(data[1]);
      setCustomers(data[2]);
      setBookings(data[3]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить записи");
    }
  }, [weekOffset]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!selectedCustomer) {
      setCustomerAssets([]);
      setCustomerPackages([]);
      setSelectedAsset("");
      setSelectedPackage("");
      return;
    }

    void Promise.all([
      apiRequest<ServiceAsset[]>(
        "/service/assets?partyId=" + encodeURIComponent(selectedCustomer)
      ),
      apiRequest<ServicePackage[]>(
        "/service/packages?partyId=" + encodeURIComponent(selectedCustomer)
      )
    ])
      .then(([assets, packages]) => {
        setCustomerAssets(assets);
        setCustomerPackages(
          packages.filter((item) => item.status === "ACTIVE")
        );
        setSelectedAsset((current) =>
          assets.some((item) => item.id === current) ? current : ""
        );
        setSelectedPackage((current) =>
          packages.some((item) => item.id === current) ? current : ""
        );
      })
      .catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить объекты и абонементы клиента"
        );
      });
  }, [selectedCustomer]);

  useEffect(() => {
    if (!services.length && !resources.length) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") !== "1") return;

    params.delete("create");
    const next = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (next ? "?" + next : "")
    );
    setError("");
    setShowCreate(true);
  }, [services.length, resources.length]);

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

  async function createCustomer() {
    const name = window.prompt("Имя клиента");
    if (!name?.trim()) return;

    const phone = window.prompt("Телефон", "")?.trim() || undefined;
    const email = window.prompt("Email", "")?.trim() || undefined;

    if (!phone && !email) {
      setError("Укажите телефон или email, чтобы не создавать обезличенную карточку.");
      return;
    }

    try {
      const customer = await apiRequest<{ id: string; displayName: string }>(
        "/crm/customers",
        {
          method: "POST",
          body: JSON.stringify({
            type: "PERSON",
            displayName: name.trim(),
            phone,
            email
          })
        }
      );

      const refreshed = await apiRequest<Customer[]>("/crm/customers");
      setCustomers(refreshed);
      setSelectedCustomer(customer.id);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать клиента"
      );
    }
  }

  async function createAsset() {
    if (!selectedCustomer) {
      setError("Сначала выберите клиента.");
      return;
    }

    const typeRaw = (
      window.prompt(
        "Тип объекта: VEHICLE / EQUIPMENT / DEVICE / OTHER",
        "VEHICLE"
      ) ?? ""
    ).trim().toUpperCase();
    if (!["VEHICLE", "EQUIPMENT", "DEVICE", "OTHER"].includes(typeRaw)) {
      setError("Некорректный тип объекта.");
      return;
    }

    const displayName = window.prompt(
      typeRaw === "VEHICLE"
        ? "Автомобиль, например BMW X5"
        : "Название объекта обслуживания"
    );
    if (!displayName?.trim()) return;

    const externalKey = window.prompt(
      typeRaw === "VEHICLE" ? "VIN (необязательно)" : "Серийный номер (необязательно)",
      ""
    )?.trim() || undefined;
    const registrationNumber =
      typeRaw === "VEHICLE"
        ? window.prompt("Госномер (необязательно)", "")?.trim() || undefined
        : undefined;
    const usageValue = window.prompt(
      typeRaw === "VEHICLE" ? "Текущий пробег, км" : "Наработка (необязательно)",
      "0"
    )?.trim() || "0";

    try {
      const created = await apiRequest<{ id: string }>("/service/assets", {
        method: "POST",
        body: JSON.stringify({
          partyId: selectedCustomer,
          assetType: typeRaw,
          displayName: displayName.trim(),
          externalKey,
          registrationNumber,
          usageValue,
          usageUnit: typeRaw === "VEHICLE" ? "KM" : "UNIT"
        })
      });

      const assets = await apiRequest<ServiceAsset[]>(
        "/service/assets?partyId=" + encodeURIComponent(selectedCustomer)
      );
      setCustomerAssets(assets);
      setSelectedAsset(created.id);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось добавить объект клиента"
      );
    }
  }

  async function fetchSlots() {
    if (!selectedService || !selectedResource || !slotDate) {
      setError("Выберите услугу, ресурс и день");
      return;
    }
    const from = new Date(slotDate + "T00:00:00");
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    if (Number.isNaN(from.getTime())) {
      setError("Некорректная дата");
      return;
    }
    setSlotLoading(true);
    setError("");
    setAvailableSlots([]);
    setSelectedStart("");
    try {
      const params = new URLSearchParams({
        serviceId: selectedService,
        from: from.toISOString(),
        to: to.toISOString()
      });
      const slots = await apiRequest<Array<{resourceId:string;startsAt:string}>>(
        "/service/availability?" + params.toString()
      );
      setAvailableSlots(slots.filter((slot) => slot.resourceId === selectedResource));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось найти свободное время");
    } finally {
      setSlotLoading(false);
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
          partyId: selectedCustomer || undefined,
          assetId: selectedAsset || undefined,
          packageId: selectedPackage || undefined,
          source: "MANUAL",
          idempotencyKey: crypto.randomUUID()
        })
      });
      setShowCreate(false);
      setSelectedStart("");
      setSelectedCustomer("");
      setSelectedAsset("");
      setSelectedPackage("");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать запись");
    } finally {
      setSubmitting(false);
    }
  }

  async function reschedule(booking: Booking, startsAt: string) {
    const parsed = new Date(startsAt);
    if (Number.isNaN(parsed.getTime())) {
      setError("Некорректное время переноса");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await apiRequest("/service/bookings/" + booking.id + "/reschedule", {
        method: "PATCH",
        body: JSON.stringify({
          startsAt: parsed.toISOString(),
          version: booking.version
        })
      });
      setRescheduling(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось перенести запись");
    } finally {
      setSubmitting(false);
    }
  }

  async function openDetails(id: string) {
    try {
      const result = await apiRequest<Booking>("/service/bookings/" + encodeURIComponent(id));
      setDetails(result);
    } catch {
      setError("Не удалось открыть карточку визита");
    }
  }

  async function changeStatus(
    booking: Booking,
    status: "ARRIVED" | "IN_SERVICE" | "COMPLETED" | "CANCELLED" | "NO_SHOW"
  ) {
    if (status === "CANCELLED" && !window.confirm("Отменить эту запись?")) return;
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
                <select required value={selectedService} onChange={(e) => { setSelectedService(e.target.value); setSelectedStart(""); setAvailableSlots([]); }}>
                  <option value="">Выбрать услугу</option>
                  {services.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.duration_minutes} мин</option>)}
                </select>
              </label>
              <label>Сотрудник или ресурс{" "}
                <select required value={selectedResource} onChange={(e) => { setSelectedResource(e.target.value); setSelectedStart(""); setAvailableSlots([]); }}>
                  <option value="">Выбрать ресурс</option>
                  {resources.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
              </label>
              <label>Клиент{" "}
                <select
                  value={selectedCustomer}
                  onChange={(e) => setSelectedCustomer(e.target.value)}
                >
                  <option value="">Без клиента / внутренняя бронь</option>
                  {customers.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}{item.phone ? " · " + item.phone : ""}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary-button"
                onClick={() => void createCustomer()}
              >
                + Новый клиент
              </button>
              {selectedCustomer ? (
                <>
                  <label>Объект клиента{" "}
                    <select
                      value={selectedAsset}
                      onChange={(e) => setSelectedAsset(e.target.value)}
                    >
                      <option value="">Не требуется</option>
                      {customerAssets.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.display_name}
                          {item.registration_number
                            ? " · " + item.registration_number
                            : ""}
                          {item.external_key ? " · " + item.external_key : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void createAsset()}
                  >
                    + Авто / объект
                  </button>
                  {customerPackages.length ? (
                    <label>Абонемент{" "}
                      <select
                        value={selectedPackage}
                        onChange={(e) => setSelectedPackage(e.target.value)}
                      >
                        <option value="">Без абонемента</option>
                        {customerPackages
                          .filter(
                            (item) =>
                              !item.applicable_service_id ||
                              !selectedService ||
                              item.applicable_service_id === selectedService
                          )
                          .map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.plan_name} · осталось {item.available_visits === null ? "∞" : item.available_visits}
                            </option>
                          ))}
                      </select>
                    </label>
                  ) : null}
                </>
              ) : null}
              <label>Начало{" "}
                <input required type="datetime-local" value={selectedStart} onChange={(e) => setSelectedStart(e.target.value)} />
              </label>
              <label>День{" "}
                <input type="date" value={slotDate} onChange={(e) => { setSlotDate(e.target.value); setAvailableSlots([]); setSelectedStart(""); }} />
              </label>
              <button type="button" className="secondary-button" disabled={slotLoading} onClick={() => void fetchSlots()}>
                {slotLoading ? "Ищем…" : "Показать свободное время"}
              </button>
              {availableSlots.length ? (
                <label>Свободные слоты{" "}
                  <select value={selectedStart} onChange={(e) => setSelectedStart(e.target.value)}>
                    <option value="">Выбрать время</option>
                    {availableSlots.map((slot) => (
                      <option key={slot.startsAt} value={toLocalDateTimeInput(new Date(slot.startsAt))}>
                        {new Date(slot.startsAt).toLocaleTimeString("ru-RU",{hour:"2-digit",minute:"2-digit"})}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button type="submit" disabled={submitting}>{submitting ? "Сохраняем…" : "Записать"}</button>
              <button className="secondary-button" type="button" onClick={() => setShowCreate(false)}>Отмена</button>
            </div>
          </form>
        ) : null}

        {rescheduling ? (
          <form className="settings-card" onSubmit={(e) => { e.preventDefault(); void reschedule(rescheduling, rescheduleStart); }} style={{ marginBottom: 16 }}>
            <h2>Перенести запись {rescheduling.business_number}</h2>
            <p className="muted">{rescheduling.service_name} · {rescheduling.party_name ?? "Клиент не указан"}</p>
            <div className="header-actions">
              <label>Новое время{" "}
                <input required type="datetime-local" value={rescheduleStart} onChange={(e) => setRescheduleStart(e.target.value)} />
              </label>
              <button type="submit" disabled={submitting}>{submitting ? "Переносим…" : "Подтвердить перенос"}</button>
              <button type="button" className="secondary-button" onClick={() => setRescheduling(null)}>Отмена</button>
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
        {details && (
          <section className="settings-card">
            <h2>Визит {details.business_number}</h2>
            <p>{details.service_name} · {details.party_name ?? "Клиент не указан"}</p>
            {details.asset ? (
              <p>
                Объект: {details.asset.displayName}
                {details.asset.registrationNumber
                  ? " · " + details.asset.registrationNumber
                  : ""}
                {details.asset.usageValue
                  ? " · " + details.asset.usageValue + " " + details.asset.usageUnit
                  : ""}
              </p>
            ) : null}
            <p>{new Date(details.starts_at).toLocaleString("ru-RU")}</p>
            <p>{details.resources.map((item) => item.resourceName).join(", ")}</p>
            <p>Статус: {details.status}</p>
            <p>Стоимость: {money(details.price_minor_snapshot, details.currency)}</p>
            <p>Это стоимость услуги, не подтверждение оплаты.</p>
            <button type="button" onClick={() => setDetails(null)}>Закрыть карточку</button>
          </section>
        )}
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
                      <button type="button" onClick={() => void openDetails(booking.id)}>Подробнее</button>
                      {booking.status === "CONFIRMED" ? (
                        <>
                          <button
                            className="secondary-button"
                            onClick={() => { setRescheduling(booking); setRescheduleStart(toLocalDateTimeInput(new Date(booking.starts_at))); }}
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
