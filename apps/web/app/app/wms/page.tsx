"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../components/app-sidebar";
import { apiRequest } from "../../lib/api";

type Warehouse = {
  id: string;
  name: string;
  code: string;
  is_default: boolean;
  mode: string | null;
  wms_status: string | null;
  stock_tracking_state: string | null;
  zones: number;
  locations: number;
};

type Zone = {
  id: string;
  code: string;
  name: string;
  zone_type: string;
  priority: number;
  status: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

type Location = {
  id: string;
  zone_id: string;
  parent_location_id: string | null;
  code: string;
  full_code: string;
  name: string | null;
  location_type: string;
  status: string;
  pick_sequence: number;
  allow_mixed_sku: boolean;
  allow_mixed_lot: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  level_no: number;
};

type Topology = {
  profile: {
    mode: string;
    status: string;
    stock_tracking_state: string;
    coordinate_unit: string;
  } | null;
  zones: Zone[];
  locations: Location[];
};

const ZONE_TYPES = [
  "RECEIVING",
  "STORAGE",
  "PICKING",
  "PACKING",
  "SHIPPING",
  "QUARANTINE",
  "RETURNS",
  "CROSS_DOCK"
];

const LOCATION_TYPES = [
  "DOCK",
  "STAGING",
  "AISLE",
  "RACK",
  "SHELF",
  "BIN",
  "FLOOR",
  "BUFFER"
];

export default function WmsPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [topology, setTopology] = useState<Topology | null>(null);
  const [error, setError] = useState("");

  const loadWarehouses = useCallback(async () => {
    try {
      const rows = await apiRequest<Warehouse[]>("/wms/warehouses");
      setWarehouses(rows);
      if (!warehouseId && rows[0]) setWarehouseId(rows[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить склады");
    }
  }, [warehouseId]);

  useEffect(() => {
    void loadWarehouses();
  }, [loadWarehouses]);

  const loadTopology = useCallback(async (id: string) => {
    if (!id) {
      setTopology(null);
      return;
    }
    try {
      setTopology(
        await apiRequest<Topology>("/wms/warehouses/" + id + "/topology")
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить топологию");
    }
  }, []);

  useEffect(() => {
    void loadTopology(warehouseId);
  }, [warehouseId, loadTopology]);

  async function enableWms() {
    if (!warehouseId) return;
    try {
      await apiRequest("/wms/warehouses/" + warehouseId + "/profile", {
        method: "PUT",
        body: JSON.stringify({
          mode: "ADDRESS",
          status: "ACTIVE",
          coordinateUnit: "GRID"
        })
      });
      await loadWarehouses();
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось включить WMS");
    }
  }

  async function addZone() {
    if (!warehouseId || !topology?.profile) return;

    const type = (
      window.prompt(
        "Тип зоны: " + ZONE_TYPES.join(", "),
        "STORAGE"
      ) ?? ""
    ).toUpperCase();
    if (!ZONE_TYPES.includes(type)) return;

    const code = window.prompt("Код зоны", type.slice(0, 3));
    if (!code?.trim()) return;

    const name = window.prompt("Название зоны", "Основное хранение");
    if (!name?.trim()) return;

    try {
      await apiRequest("/wms/warehouses/" + warehouseId + "/zones", {
        method: "POST",
        body: JSON.stringify({
          code: code.trim(),
          name: name.trim(),
          zoneType: type,
          priority: 100,
          x: topology.zones.length * 3,
          y: 0,
          width: 2,
          height: 2
        })
      });
      await loadTopology(warehouseId);
      await loadWarehouses();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать зону");
    }
  }

  async function addLocation() {
    if (!warehouseId || !topology?.zones.length) return;

    const zoneList = topology.zones
      .map((zone, index) => (index + 1) + ". " + zone.name + " · " + zone.code)
      .join("\n");
    const zoneIndex =
      Number(window.prompt("Выберите зону:\n" + zoneList, "1")) - 1;
    const zone = topology.zones[zoneIndex];
    if (!zone) return;

    const type = (
      window.prompt("Тип адреса: " + LOCATION_TYPES.join(", "), "BIN") ?? ""
    ).toUpperCase();
    if (!LOCATION_TYPES.includes(type)) return;

    const code = window.prompt("Код адреса", "A-01-01");
    if (!code?.trim()) return;

    const parentCandidates = topology.locations.filter(
      (location) => location.zone_id === zone.id
    );
    let parentLocationId: string | undefined;

    if (parentCandidates.length) {
      const useParent = window.confirm(
        "Привязать адрес к родительскому адресу (например, полка к стеллажу)?"
      );
      if (useParent) {
        const list = parentCandidates
          .map(
            (location, index) =>
              (index + 1) + ". " + location.full_code + " · " + location.location_type
          )
          .join("\n");
        const index = Number(window.prompt("Родитель:\n" + list, "1")) - 1;
        parentLocationId = parentCandidates[index]?.id;
      }
    }

    try {
      await apiRequest("/wms/warehouses/" + warehouseId + "/locations", {
        method: "POST",
        body: JSON.stringify({
          zoneId: zone.id,
          parentLocationId,
          code: code.trim(),
          locationType: type,
          pickSequence: topology.locations.length * 10 + 10,
          allowMixedSku: true,
          allowMixedLot: true,
          x: topology.locations.filter((item) => item.zone_id === zone.id).length,
          y: 0,
          width: 1,
          height: 1,
          levelNo: 0
        })
      });
      await loadTopology(warehouseId);
      await loadWarehouses();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать адрес");
    }
  }

  async function toggleLocation(location: Location) {
    if (!warehouseId) return;
    const status = location.status === "ACTIVE" ? "BLOCKED" : "ACTIVE";
    try {
      await apiRequest(
        "/wms/warehouses/" +
          warehouseId +
          "/locations/" +
          location.id +
          "/status",
        {
          method: "PATCH",
          body: JSON.stringify({ status })
        }
      );
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить адрес");
    }
  }

  const selected = useMemo(
    () => warehouses.find((warehouse) => warehouse.id === warehouseId) ?? null,
    [warehouses, warehouseId]
  );

  return (
    <main className="app-shell">
      <AppSidebar active="wms" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Склад / WMS</p>
            <h1>Адресное хранение</h1>
            <p className="workspace-summary">
              Обычный склад остаётся простым. Адресный режим включается только там, где реально нужны зоны и ячейки.
            </p>
          </div>

          <div className="header-actions">
            {topology?.profile ? (
              <>
                <button className="secondary-button" onClick={() => void addZone()}>
                  + Зона
                </button>
                <button onClick={() => void addLocation()}>
                  + Адрес
                </button>
              </>
            ) : null}
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>WMS</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="wms-layout">
          <aside className="wms-warehouse-list">
            <strong>Склады</strong>
            {warehouses.map((warehouse) => (
              <button
                key={warehouse.id}
                className={warehouse.id === warehouseId ? "active" : ""}
                onClick={() => setWarehouseId(warehouse.id)}
              >
                <span>{warehouse.name}</span>
                <small>
                  {warehouse.wms_status
                    ? warehouse.wms_status + " · " + warehouse.locations + " адресов"
                    : "Обычный склад"}
                </small>
              </button>
            ))}
          </aside>

          <section className="wms-content">
            {selected && !topology?.profile ? (
              <div className="wms-empty">
                <div>
                  <span>Обычный склад</span>
                  <h2>{selected.name}</h2>
                  <p>
                    Для этого склада адресное хранение не включено. Остатки и операции продолжают работать как раньше.
                  </p>
                </div>
                <button onClick={() => void enableWms()}>
                  Включить адресный WMS
                </button>
              </div>
            ) : null}

            {selected && topology?.profile ? (
              <>
                <div className="quality-banner">
                  <strong>
                    {selected.name} · {topology.profile.mode}
                  </strong>
                  <span>
                    {topology.profile.stock_tracking_state === "TOPOLOGY_ONLY"
                      ? "Сейчас настраивается только топология. Остатки остаются в Inventory Ledger."
                      : topology.profile.stock_tracking_state}
                  </span>
                </div>

                <div className="wms-zone-grid">
                  {topology.zones.map((zone) => {
                    const locations = topology.locations.filter(
                      (location) => location.zone_id === zone.id
                    );

                    return (
                      <article className="wms-zone" key={zone.id}>
                        <header>
                          <div>
                            <span>{zone.zone_type}</span>
                            <h3>{zone.name}</h3>
                            <small>{zone.code}</small>
                          </div>
                          <b>{locations.length}</b>
                        </header>

                        <div className="wms-location-grid">
                          {locations.map((location) => (
                            <button
                              key={location.id}
                              className={
                                "wms-location " +
                                (location.status !== "ACTIVE" ? "blocked" : "")
                              }
                              onClick={() => void toggleLocation(location)}
                              title="Нажмите, чтобы заблокировать/разблокировать адрес"
                            >
                              <strong>{location.full_code}</strong>
                              <span>{location.location_type}</span>
                              <small>
                                seq {location.pick_sequence}
                                {location.level_no ? " · ур. " + location.level_no : ""}
                              </small>
                            </button>
                          ))}

                          {!locations.length ? (
                            <div className="wms-zone-empty">
                              Адресов пока нет
                            </div>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}

                  {!topology.zones.length ? (
                    <div className="table-empty">
                      <strong>Топология пустая</strong>
                      <span>
                        Добавьте зоны: приёмка, хранение, отбор, упаковка, отгрузка.
                      </span>
                    </div>
                  ) : null}
                </div>
              </>
            ) : null}
          </section>
        </div>
      </section>
    </main>
  );
}
