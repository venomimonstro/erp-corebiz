"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Customer = {
  id: string;
  displayName: string;
  phone: string | null;
};

type Asset = {
  id: string;
  party_id: string | null;
  party_name: string | null;
  asset_type: "VEHICLE" | "EQUIPMENT" | "DEVICE" | "OTHER";
  display_name: string;
  external_key: string | null;
  registration_number: string | null;
  manufacturer: string | null;
  model: string | null;
  production_year: number | null;
  usage_value: string;
  usage_unit: "KM" | "HOURS" | "CYCLES" | "UNIT";
  last_service_at: string | null;
};

type AssetHistory = {
  asset: Asset;
  bookings: Array<{
    id: string;
    business_number: string;
    status: string;
    starts_at: string;
    price_minor_snapshot: string;
    currency: string;
    service_name: string;
  }>;
};

function money(value: string, currency: string): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function ServiceAssetsPage() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [history, setHistory] = useState<AssetHistory | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [assetType, setAssetType] = useState<Asset["asset_type"]>("VEHICLE");
  const [displayName, setDisplayName] = useState("");
  const [externalKey, setExternalKey] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [usageValue, setUsageValue] = useState("0");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const [customerRows, assetRows] = await Promise.all([
        apiRequest<Customer[]>("/crm/customers"),
        apiRequest<Asset[]>("/service/assets")
      ]);
      setCustomers(customerRows);
      setAssets(assetRows);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить объекты обслуживания");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createAsset() {
    if (!displayName.trim()) {
      setError("Укажите объект обслуживания");
      return;
    }
    if (!/^\d+$/.test(usageValue)) {
      setError("Пробег или наработка должны быть целым неотрицательным числом");
      return;
    }

    setPending(true);
    setError("");
    try {
      await apiRequest("/service/assets", {
        method: "POST",
        body: JSON.stringify({
          partyId: customerId || undefined,
          assetType,
          displayName: displayName.trim(),
          externalKey: externalKey.trim() || undefined,
          registrationNumber:
            assetType === "VEHICLE"
              ? registrationNumber.trim() || undefined
              : undefined,
          usageValue,
          usageUnit: assetType === "VEHICLE" ? "KM" : "HOURS"
        })
      });
      setDisplayName("");
      setExternalKey("");
      setRegistrationNumber("");
      setUsageValue("0");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось добавить объект");
    } finally {
      setPending(false);
    }
  }

  async function updateUsage(asset: Asset) {
    const raw = window.prompt(
      asset.usage_unit === "KM" ? "Текущий пробег, км" : "Текущая наработка",
      asset.usage_value
    );
    if (raw === null) return;
    const value = raw.trim();
    if (!/^\d+$/.test(value)) {
      setError("Введите целое неотрицательное значение");
      return;
    }

    try {
      await apiRequest("/service/assets/" + asset.id + "/usage", {
        method: "PATCH",
        body: JSON.stringify({
          usageValue: value,
          usageUnit: asset.usage_unit
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось обновить пробег/наработку");
    }
  }

  async function openHistory(asset: Asset) {
    try {
      setHistory(
        await apiRequest<AssetHistory>(
          "/service/assets/" + encodeURIComponent(asset.id) + "/history"
        )
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить историю");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="service-assets" />

      <section className="workspace workspace-wide">
        <header className="workspace-header">
          <div>
            <p className="muted">Сервис / Объекты клиента</p>
            <h1>Автомобили и оборудование</h1>
            <p className="workspace-summary">
              История обслуживания, VIN/серийные номера и пробег или наработка в одной карточке.
            </p>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section className="settings-card">
          <div className="section-heading">
            <div>
              <p className="muted">Новый объект</p>
              <h2>Добавить объект обслуживания</h2>
            </div>
          </div>

          <div className="header-actions" style={{ flexWrap: "wrap" }}>
            <label>
              Клиент{" "}
              <select value={customerId} onChange={(event) => setCustomerId(event.target.value)}>
                <option value="">Без владельца</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}{customer.phone ? " · " + customer.phone : ""}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Тип{" "}
              <select
                value={assetType}
                onChange={(event) => setAssetType(event.target.value as Asset["asset_type"])}
              >
                <option value="VEHICLE">Автомобиль</option>
                <option value="EQUIPMENT">Оборудование</option>
                <option value="DEVICE">Устройство</option>
                <option value="OTHER">Другое</option>
              </select>
            </label>

            <input
              placeholder={assetType === "VEHICLE" ? "BMW X5" : "Название объекта"}
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />

            <input
              placeholder={assetType === "VEHICLE" ? "VIN" : "Серийный номер"}
              value={externalKey}
              onChange={(event) => setExternalKey(event.target.value)}
            />

            {assetType === "VEHICLE" ? (
              <input
                placeholder="Госномер"
                value={registrationNumber}
                onChange={(event) => setRegistrationNumber(event.target.value)}
              />
            ) : null}

            <input
              inputMode="numeric"
              placeholder={assetType === "VEHICLE" ? "Пробег" : "Наработка"}
              value={usageValue}
              onChange={(event) => setUsageValue(event.target.value)}
            />

            <button disabled={pending} onClick={() => void createAsset()} type="button">
              {pending ? "Добавляем…" : "+ Добавить"}
            </button>
          </div>
        </section>

        <section className="section-block">
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Объект</th>
                  <th>Клиент</th>
                  <th>Идентификатор</th>
                  <th>Пробег / наработка</th>
                  <th>Последнее обслуживание</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {assets.map((asset) => (
                  <tr key={asset.id}>
                    <td>
                      <strong>{asset.display_name}</strong>
                      <small>{asset.asset_type}</small>
                    </td>
                    <td>{asset.party_name ?? "Без владельца"}</td>
                    <td>
                      {asset.registration_number ?? asset.external_key ?? "—"}
                      {asset.registration_number && asset.external_key ? (
                        <small>{asset.external_key}</small>
                      ) : null}
                    </td>
                    <td>
                      <strong>{asset.usage_value}</strong>
                      <small>{asset.usage_unit}</small>
                    </td>
                    <td>
                      {asset.last_service_at
                        ? new Date(asset.last_service_at).toLocaleDateString("ru-RU")
                        : "Ещё не обслуживался"}
                    </td>
                    <td className="table-actions">
                      <button className="secondary-button" onClick={() => void updateUsage(asset)} type="button">
                        Пробег
                      </button>
                      <button onClick={() => void openHistory(asset)} type="button">
                        История
                      </button>
                    </td>
                  </tr>
                ))}
                {!assets.length ? (
                  <tr>
                    <td colSpan={6}>
                      <div className="table-empty">
                        <strong>Объектов обслуживания пока нет</strong>
                        <span>Добавьте автомобиль, оборудование или устройство клиента.</span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        {history ? (
          <section className="section-block">
            <div className="section-heading">
              <div>
                <p className="muted">История объекта</p>
                <h2>{history.asset.display_name}</h2>
              </div>
              <button className="secondary-button" onClick={() => setHistory(null)} type="button">
                Закрыть
              </button>
            </div>

            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Дата</th>
                    <th>Заказ</th>
                    <th>Услуга</th>
                    <th>Статус</th>
                    <th>Сумма</th>
                  </tr>
                </thead>
                <tbody>
                  {history.bookings.map((booking) => (
                    <tr key={booking.id}>
                      <td>{new Date(booking.starts_at).toLocaleDateString("ru-RU")}</td>
                      <td>{booking.business_number}</td>
                      <td>{booking.service_name}</td>
                      <td><span className="status-pill">{booking.status}</span></td>
                      <td>{money(booking.price_minor_snapshot, booking.currency)}</td>
                    </tr>
                  ))}
                  {!history.bookings.length ? (
                    <tr><td colSpan={5}><div className="table-empty"><strong>История пуста</strong></div></td></tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
      </section>
    </main>
  );
}
