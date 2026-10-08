"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type TodayData = {
  bookings: Array<{
    id: string;
    business_number: string;
    status: string;
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
    }>;
  }>;
  metrics: {
    total: number;
    completed: number;
    noShow: number;
    revenueMinor: string;
  };
};

type Analytics = {
  services: Array<{
    id: string;
    name: string;
    bookings: number;
    completed: number;
    no_show: number;
    revenue_minor: string;
  }>;
  resources: Array<{
    id: string;
    name: string;
    type: string;
    bookings: number;
    booked_minutes: string;
    completed: number;
  }>;
};

type Balance = {
  warehouseId: string;
  warehouseName: string;
  skuId: string;
  sku: string;
  productName: string;
  availableMilli: string;
};

function money(value: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function ServiceHomePage() {
  const [today, setToday] = useState<TodayData | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [balances, setBalances] = useState<Balance[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setError("");

    try {
      const [todayData, analyticsData, balanceData] = await Promise.all([
        apiRequest<TodayData>("/service/workspace/today"),
        apiRequest<Analytics>("/service/workspace/analytics"),
        apiRequest<Balance[]>("/inventory/balances")
      ]);

      setToday(todayData);
      setAnalytics(analyticsData);
      setBalances(balanceData);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить рабочее место сервиса"
      );
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const conversion = useMemo(() => {
    if (!today?.metrics.total) return 0;
    return Math.round(
      (today.metrics.completed / today.metrics.total) * 100
    );
  }, [today]);

  async function consumeMaterial(bookingId: string) {
    const available = balances.filter(
      (item) => BigInt(item.availableMilli) > 0n
    );

    if (!available.length) {
      setError("Нет доступных складских остатков для расхода");
      return;
    }

    const text = available
      .slice(0, 40)
      .map(
        (item, index) =>
          `${index + 1}. ${item.productName} · ${item.sku} · ${item.warehouseName} · доступно ${Number(
            item.availableMilli
          ) / 1000}`
      )
      .join("\n");

    const index =
      Number(window.prompt("Выберите расходник:\n" + text, "1")) - 1;
    const item = available[index];
    if (!item) return;

    const max = Number(item.availableMilli) / 1000;
    const raw = window.prompt(
      "Количество расхода",
      String(Math.min(1, max))
    );
    if (raw === null) return;

    const units = Number(raw.replace(",", "."));
    if (!Number.isFinite(units) || units <= 0 || units > max) {
      setError("Некорректное количество расхода");
      return;
    }

    const quantityMilli = String(Math.round(units * 1000));

    try {
      const line = await apiRequest<{ id: string }>(
        "/service/workspace/bookings/" + bookingId + "/materials",
        {
          method: "POST",
          body: JSON.stringify({
            warehouseId: item.warehouseId,
            skuId: item.skuId,
            quantityMilli
          })
        }
      );

      await apiRequest(
        "/service/workspace/materials/" + line.id + "/consume",
        {
          method: "POST",
          body: JSON.stringify({
            quantityMilli,
            idempotencyKey: crypto.randomUUID()
          })
        }
      );

      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось списать расходник"
      );
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="service-home" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Сервис / Рабочее место</p>
            <h1>Сегодня</h1>
            <p className="workspace-summary">
              Записи, выручка, no-show, загрузка ресурсов и расходники.
            </p>
          </div>

          <a className="button-link" href="/app/service/bookings">
            Открыть календарь
          </a>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {today ? (
          <>
            <div className="metric-grid">
              <article className="metric-card">
                <span>Записей сегодня</span>
                <strong>{today.metrics.total}</strong>
                <small>Завершено {today.metrics.completed}</small>
              </article>

              <article className="metric-card">
                <span>Стоимость завершённых услуг</span>
                <strong>{money(today.metrics.revenueMinor)}</strong>
                <small>Начисленная стоимость, не фактическая оплата</small>
              </article>

              <article className="metric-card">
                <span>Выполнено</span>
                <strong>{conversion}%</strong>
                <small>No-show: {today.metrics.noShow}</small>
              </article>
            </div>

            <div className="service-today-list">
              {today.bookings.map((booking) => (
                <article className="service-today-row" key={booking.id}>
                  <div className="booking-time">
                    <strong>
                      {new Date(booking.starts_at).toLocaleTimeString(
                        "ru-RU",
                        {
                          hour: "2-digit",
                          minute: "2-digit"
                        }
                      )}
                    </strong>
                    <span>
                      {new Date(booking.ends_at).toLocaleTimeString(
                        "ru-RU",
                        {
                          hour: "2-digit",
                          minute: "2-digit"
                        }
                      )}
                    </span>
                  </div>

                  <div>
                    <strong>{booking.service_name}</strong>
                    <span>
                      {booking.party_name ?? "Без клиента"} ·{" "}
                      {booking.resources
                        .map((resource) => resource.resourceName)
                        .join(", ")}
                    </span>
                  </div>

                  <span className="status-pill">{booking.status}</span>

                  <button
                    disabled={["CANCELLED", "NO_SHOW"].includes(
                      booking.status
                    )}
                    onClick={() => void consumeMaterial(booking.id)}
                    type="button"
                  >
                    Расходник
                  </button>
                </article>
              ))}

              {!today.bookings.length ? (
                <div className="table-empty">
                  <strong>Сегодня записей нет</strong>
                  <span>Откройте календарь и создайте первую запись.</span>
                </div>
              ) : null}
            </div>
          </>
        ) : null}

        {analytics ? (
          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="muted">30 дней</p>
                <h2>Эффективность сервиса</h2>
              </div>
            </div>

            <div className="service-analytics-grid">
              <div className="settings-card">
                <strong>Услуги</strong>
                <div className="mini-ranking">
                  {analytics.services.slice(0, 8).map((service) => (
                    <article key={service.id}>
                      <div>
                        <strong>{service.name}</strong>
                        <span>
                          {service.completed}/{service.bookings} выполнено ·
                          no-show {service.no_show}
                        </span>
                      </div>
                      <b>{money(service.revenue_minor)}</b>
                    </article>
                  ))}
                </div>
              </div>

              <div className="settings-card">
                <strong>Ресурсы</strong>
                <div className="mini-ranking">
                  {analytics.resources.slice(0, 8).map((resource) => (
                    <article key={resource.id}>
                      <div>
                        <strong>{resource.name}</strong>
                        <span>
                          {resource.type} ·{" "}
                          {Math.round(Number(resource.booked_minutes) / 60)} ч
                          занято
                        </span>
                      </div>
                      <b>{resource.completed}</b>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
