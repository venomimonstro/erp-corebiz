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

type LocationBalance = {
  location_id: string;
  full_code: string;
  location_name: string | null;
  is_system: boolean;
  zone_name: string;
  zone_type: string;
  sku_id: string;
  sku_code: string;
  product_name: string;
  physical_milli: string;
};

type WmsTask = {
  id: string;
  task_type: string;
  status: string;
  priority: number;
  sku_id: string;
  sku_code: string;
  product_name: string;
  quantity_milli: string;
  from_code: string | null;
  to_code: string | null;
  claimed_by_membership_id: string | null;
  instructions: Record<string, unknown>;
  last_error: string | null;
};

type Order = {
  id: string;
  number: string;
  partyName: string | null;
  fulfillmentStatus: string;
};

type Wave = {
  id: string;
  strategy: string;
  status: string;
  priority: number;
  max_tasks: number;
  tasks: number;
  open_tasks: number;
  claimed_tasks: number;
  completed_tasks: number;
  failed_tasks: number;
  created_at: string;
  released_at: string | null;
};

type Dispatcher = {
  warehouseId: string;
  backlog: {
    open: number;
    claimed: number;
    unplanned_pick: number;
    oldest_open_at: string | null;
  };
  waves: Array<Wave & { progress_percent?: string | number | null }>;
  taskFlow: Array<{
    task_type: string;
    status: string;
    count: number;
  }>;
  exceptions: Array<{
    id: string;
    exception_id: string | null;
    task_type: string;
    status: string;
    last_error: string | null;
    sku_code: string | null;
    from_code: string | null;
    to_code: string | null;
    cluster_slot: string | null;
  }>;
};

type LaborMetrics = {
  warehouseId: string;
  windowHours: number;
  summary: {
    completed: number;
    active_tasks: number;
    active_operators: number;
    tasks_per_hour: string | number | null;
    median_cycle_minutes: string | number | null;
  };
  operators: Array<{
    membership_id: string;
    email: string;
    completed: number;
    active: number;
    median_cycle_minutes: string | number | null;
    last_completed_at: string | null;
  }>;
  throughput: Array<{
    task_type: string;
    completed: number;
    median_cycle_minutes: string | number | null;
  }>;
  backlogRisk: {
    fresh: number;
    watch: number;
    risk: number;
    critical: number;
    exceptions: number;
  };
  workload: Array<{
    zone_name: string;
    task_type: string;
    status: string;
    tasks: number;
  }>;
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
  const [balances, setBalances] = useState<LocationBalance[]>([]);
  const [tasks, setTasks] = useState<WmsTask[]>([]);
  const [waves, setWaves] = useState<Wave[]>([]);
  const [dispatcher, setDispatcher] = useState<Dispatcher | null>(null);
  const [labor, setLabor] = useState<LaborMetrics | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
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
    void apiRequest<Order[]>("/sales/orders")
      .then(setOrders)
      .catch(() => setOrders([]));
  }, [loadWarehouses]);

  const loadTopology = useCallback(async (id: string) => {
    if (!id) {
      setTopology(null);
      return;
    }
    try {
      const next = await apiRequest<Topology>(
        "/wms/warehouses/" + id + "/topology"
      );
      setTopology(next);

      if (next.profile?.stock_tracking_state === "LOCATION_LEDGER") {
        const [locationRows, taskRows, waveRows, dispatcherData, laborData] = await Promise.all([
          apiRequest<LocationBalance[]>(
            "/wms/warehouses/" + id + "/location-balances"
          ),
          apiRequest<WmsTask[]>(
            "/wms/warehouses/" + id + "/tasks"
          ),
          apiRequest<Wave[]>(
            "/wms/warehouses/" + id + "/waves"
          ),
          apiRequest<Dispatcher>(
            "/wms/warehouses/" + id + "/dispatcher"
          ),
          apiRequest<LaborMetrics>(
            "/wms/warehouses/" + id + "/labor?hours=24"
          )
        ]);
        setBalances(locationRows);
        setTasks(taskRows);
        setWaves(waveRows);
        setDispatcher(dispatcherData);
        setLabor(laborData);
      } else {
        setBalances([]);
        setTasks([]);
        setWaves([]);
        setDispatcher(null);
        setLabor(null);
      }

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

  async function initializeLedger() {
    if (!warehouseId) return;
    if (
      !window.confirm(
        "Инициализировать ячеечный учёт? Текущий физический остаток будет сверочно помещён в системный адрес UNASSIGNED."
      )
    ) {
      return;
    }

    try {
      const result = await apiRequest<{
        initialized: boolean;
        skuCount: number;
      }>(
        "/wms/warehouses/" +
          warehouseId +
          "/location-ledger/initialize",
        { method: "POST" }
      );

      window.alert(
        result.initialized
          ? "Ячеечный учёт включён. SKU перенесено в UNASSIGNED: " + result.skuCount
          : "Ячеечный учёт уже был инициализирован."
      );
      await loadTopology(warehouseId);
      await loadWarehouses();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось инициализировать ячеечный учёт"
      );
    }
  }

  async function createPutaway(balance: LocationBalance) {
    const raw = window.prompt(
      "Количество к размещению, шт.",
      String(Number(balance.physical_milli) / 1000)
    );
    if (!raw) return;

    const quantity = Number(raw.replace(",", "."));
    if (!Number.isFinite(quantity) || quantity <= 0) {
      setError("Некорректное количество");
      return;
    }

    try {
      const result = await apiRequest<{
        toLocationCode: string;
      }>("/wms/warehouses/" + warehouseId + "/putaway-tasks", {
        method: "POST",
        body: JSON.stringify({
          skuId: balance.sku_id,
          quantityMilli: String(Math.round(quantity * 1000))
        })
      });

      window.alert("Создана задача размещения → " + result.toLocationCode);
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать задачу размещения"
      );
    }
  }

  async function claimTask(task: WmsTask) {
    try {
      await apiRequest("/wms/tasks/" + task.id + "/claim", {
        method: "POST"
      });
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось взять задачу");
    }
  }

  async function planOutbound() {
    const candidates = orders.filter(
      (order) => order.fulfillmentStatus === "RESERVED"
    );

    if (!candidates.length) {
      setError("Нет заказов в статусе «В резерве» для отбора.");
      return;
    }

    const list = candidates
      .map(
        (order, index) =>
          (index + 1) +
          ". " +
          order.number +
          (order.partyName ? " · " + order.partyName : "")
      )
      .join("\n");

    const selected =
      Number(window.prompt("Выберите заказ для отбора:\n" + list, "1")) - 1;
    const order = candidates[selected];
    if (!order) return;

    try {
      const result = await apiRequest<{
        allocations: number;
        pickTasks: number;
      }>("/wms/orders/" + order.id + "/plan-outbound", {
        method: "POST"
      });

      window.alert(
        result.pickTasks
          ? "Создано PICK-задач: " + result.pickTasks
          : "Отбор по заказу уже запланирован."
      );

      await loadTopology(warehouseId);
      setOrders(await apiRequest<Order[]>("/sales/orders"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось запланировать отбор"
      );
    }
  }

  async function requeueException(exceptionId: string) {
    try {
      await apiRequest("/wms/exceptions/" + exceptionId + "/resolve", {
        method: "POST",
        body: JSON.stringify({ action: "REQUEUE" })
      });
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось вернуть задачу в очередь"
      );
    }
  }

  async function createWave() {
    if (!warehouseId) return;

    const strategy = (
      window.prompt(
        "Стратегия wave: ORDER, BATCH, ZONE, CLUSTER",
        "CLUSTER"
      ) ?? ""
    ).toUpperCase();
    if (!["ORDER","BATCH","ZONE","CLUSTER"].includes(strategy)) return;

    const maxRaw = window.prompt("Максимум PICK-задач в wave", "40");
    if (!maxRaw) return;
    const maxTasks = Number(maxRaw);
    if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 500) {
      setError("Некорректный размер wave");
      return;
    }

    try {
      const result = await apiRequest<{
        waveId: string;
        tasks: number;
        orders: number;
      }>("/wms/warehouses/" + warehouseId + "/waves", {
        method: "POST",
        body: JSON.stringify({
          strategy,
          maxTasks,
          priority: 80
        })
      });
      window.alert(
        "Wave создан: " + result.tasks + " задач, " + result.orders + " заказов."
      );
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать wave"
      );
    }
  }

  async function releaseWave(wave: Wave) {
    try {
      await apiRequest("/wms/waves/" + wave.id + "/release", {
        method: "POST"
      });
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось выпустить wave"
      );
    }
  }

  async function claimNextWave(wave: Wave) {
    try {
      const task = await apiRequest<{
        id: string;
        from_code: string | null;
        to_code: string | null;
        cluster_slot: string | null;
      } | null>("/wms/waves/" + wave.id + "/claim-next", {
        method: "POST"
      });

      if (!task) {
        window.alert("В wave больше нет свободных задач.");
      } else {
        window.alert(
          "Следующая задача: " +
            (task.from_code ?? "—") +
            " → " +
            (task.to_code ?? "—") +
            (task.cluster_slot ? " · ячейка тележки " + task.cluster_slot : "")
        );
      }

      await loadTopology(warehouseId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось получить следующую задачу wave"
      );
    }
  }

  async function startCycleCount() {
    if (!warehouseId) return;
    const reason = window.prompt(
      "Причина пересчёта",
      "Плановый cycle count"
    );
    if (reason === null) return;

    try {
      const result = await apiRequest<{
        countId: string;
        tasks: number;
      }>("/wms/warehouses/" + warehouseId + "/cycle-counts", {
        method: "POST",
        body: JSON.stringify({
          reason: reason.trim() || undefined
        })
      });
      window.alert("Создано COUNT-задач: " + result.tasks);
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать пересчёт"
      );
    }
  }

  async function planReplenishment() {
    if (!warehouseId) return;

    try {
      const result = await apiRequest<{
        tasks: number;
        shortages: Array<{
          skuId: string;
          targetLocationId: string;
          missingMilli: string;
        }>;
      }>(
        "/wms/warehouses/" + warehouseId + "/replenishment/plan",
        { method: "POST" }
      );

      window.alert(
        "Создано REPLENISH-задач: " +
          result.tasks +
          (result.shortages.length
            ? ". Дефицит по " + result.shortages.length + " pick-face."
            : ".")
      );
      await loadTopology(warehouseId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось спланировать пополнение"
      );
    }
  }

  async function configurePickFace(balance: LocationBalance) {
    const minRaw = window.prompt(
      "Минимальный остаток в pick-face, шт.",
      "5"
    );
    if (!minRaw) return;
    const maxRaw = window.prompt(
      "Пополнять до, шт.",
      "20"
    );
    if (!maxRaw) return;

    const min = Number(minRaw.replace(",", "."));
    const max = Number(maxRaw.replace(",", "."));
    if (
      !Number.isFinite(min) ||
      !Number.isFinite(max) ||
      min < 0 ||
      max <= 0 ||
      max < min
    ) {
      setError("Некорректные min/max для pick-face");
      return;
    }

    try {
      await apiRequest(
        "/wms/warehouses/" + warehouseId + "/sku-rules",
        {
          method: "POST",
          body: JSON.stringify({
            skuId: balance.sku_id,
            locationId: balance.location_id,
            ruleType: "FIXED_PICK",
            priority: 10,
            minQuantityMilli: String(Math.round(min * 1000)),
            maxQuantityMilli: String(Math.round(max * 1000))
          })
        }
      );
      window.alert("Pick-face правило сохранено.");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось настроить pick-face"
      );
    }
  }

  async function completeTask(task: WmsTask) {
    if (task.task_type === "COUNT") {
      const raw = window.prompt(
        "Фактическое количество, шт.",
        task.quantity_milli
          ? String(Number(task.quantity_milli) / 1000)
          : "0"
      );
      if (raw === null) return;

      const quantity = Number(raw.replace(",", "."));
      if (!Number.isFinite(quantity) || quantity < 0) {
        setError("Некорректный фактический остаток");
        return;
      }

      try {
        const result = await apiRequest<{
          varianceMilli: string;
          countCompleted: boolean;
        }>("/wms/tasks/" + task.id + "/complete-count", {
          method: "POST",
          body: JSON.stringify({
            countedMilli: String(Math.round(quantity * 1000))
          })
        });

        const variance = Number(result.varianceMilli) / 1000;
        window.alert(
          variance === 0
            ? "Остаток подтверждён без расхождения."
            : "Пересчёт проведён. Расхождение: " + variance
        );
        await loadTopology(warehouseId);
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось провести пересчёт"
        );
      }
      return;
    }

    const label =
      task.task_type === "PUTAWAY"
        ? "размещение"
        : task.task_type === "PICK"
          ? "отбор"
          : task.task_type === "PACK"
            ? "упаковку"
            : task.task_type === "SHIP"
              ? "отгрузку"
              : task.task_type === "REPLENISH"
                ? "пополнение pick-face"
                : "задачу";

    if (!window.confirm("Подтвердить " + label + "?")) return;

    const endpoint =
      task.task_type === "PUTAWAY"
        ? "complete-putaway"
        : task.task_type === "PICK"
          ? "complete-pick"
          : task.task_type === "PACK"
            ? "complete-pack"
            : task.task_type === "SHIP"
              ? "complete-ship"
              : task.task_type === "REPLENISH"
                ? "complete-replenishment"
                : null;

    if (!endpoint) {
      setError("Для этого типа задачи завершение ещё не поддерживается.");
      return;
    }

    try {
      await apiRequest(
        "/wms/tasks/" + task.id + "/" + endpoint,
        { method: "POST" }
      );
      await loadTopology(warehouseId);
      setOrders(await apiRequest<Order[]>("/sales/orders"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось завершить задачу"
      );
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
                <button
                  className="secondary-button"
                  onClick={() => void planOutbound()}
                >
                  Подготовить заказ
                </button>
                {topology.profile.stock_tracking_state === "LOCATION_LEDGER" ? (
                  <>
                    <button
                      className="secondary-button"
                      onClick={() => void createWave()}
                    >
                      + Wave
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void planReplenishment()}
                    >
                      Пополнить pick-face
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void startCycleCount()}
                    >
                      Пересчёт
                    </button>
                  </>
                ) : null}
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
                      ? "Топология готовится. Остатки пока только в Inventory Ledger."
                      : "Ячеечный субледжер активен и сверяется с Inventory Balance."}
                  </span>
                  {topology.profile.stock_tracking_state === "TOPOLOGY_ONLY" ? (
                    <button
                      onClick={() => void initializeLedger()}
                      type="button"
                    >
                      Инициализировать ячейки
                    </button>
                  ) : null}
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

                {topology.profile.stock_tracking_state === "LOCATION_LEDGER" ? (
                  <>
                    <section className="section-block">
                      <div className="section-heading">
                        <div>
                          <p className="muted">Receiving buffer</p>
                          <h2>Не размещено</h2>
                        </div>
                      </div>

                      <div className="data-table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>SKU</th>
                              <th>Товар</th>
                              <th>Количество</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {balances
                              .filter((row) => row.is_system)
                              .map((row) => (
                                <tr key={row.location_id + ":" + row.sku_id}>
                                  <td><strong>{row.sku_code}</strong></td>
                                  <td>{row.product_name}</td>
                                  <td>{Number(row.physical_milli) / 1000}</td>
                                  <td className="table-actions">
                                    <button
                                      onClick={() => void createPutaway(row)}
                                      type="button"
                                    >
                                      Разместить
                                    </button>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <section className="section-block">
                      <div className="section-heading">
                        <div>
                          <p className="muted">Location stock</p>
                          <h2>Остатки по ячейкам</h2>
                        </div>
                      </div>

                      <div className="data-table-wrap">
                        <table className="data-table">
                          <thead>
                            <tr>
                              <th>Ячейка</th>
                              <th>Зона</th>
                              <th>SKU</th>
                              <th>Товар</th>
                              <th>Факт</th>
                              <th />
                            </tr>
                          </thead>
                          <tbody>
                            {balances
                              .filter((row) => !row.is_system)
                              .map((row) => (
                                <tr key={row.location_id + ":" + row.sku_id}>
                                  <td><strong>{row.full_code}</strong></td>
                                  <td>{row.zone_name}</td>
                                  <td>{row.sku_code}</td>
                                  <td>{row.product_name}</td>
                                  <td>{Number(row.physical_milli) / 1000}</td>
                                  <td className="table-actions">
                                    {row.zone_type === "PICKING" ? (
                                      <button
                                        className="secondary-button"
                                        onClick={() => void configurePickFace(row)}
                                        type="button"
                                      >
                                        Pick-face min/max
                                      </button>
                                    ) : null}
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                    </section>

                    <section className="section-block">
                      <div className="section-heading">
                        <div>
                          <p className="muted">Dispatcher</p>
                          <h2>Поток склада</h2>
                        </div>
                      </div>

                      <div className="wms-dispatcher-grid">
                        <article>
                          <span>Открыто</span>
                          <strong>{dispatcher?.backlog.open ?? 0}</strong>
                        </article>
                        <article>
                          <span>В работе</span>
                          <strong>{dispatcher?.backlog.claimed ?? 0}</strong>
                        </article>
                        <article>
                          <span>PICK вне wave</span>
                          <strong>{dispatcher?.backlog.unplanned_pick ?? 0}</strong>
                        </article>
                        <article>
                          <span>Исключения</span>
                          <strong>{dispatcher?.exceptions.length ?? 0}</strong>
                        </article>
                      </div>

                      {dispatcher?.backlog.oldest_open_at ? (
                        <p className="builder-hint">
                          Самая старая открытая задача:{" "}
                          {new Date(dispatcher.backlog.oldest_open_at).toLocaleString("ru-RU")}
                        </p>
                      ) : null}

                      {dispatcher?.exceptions.length ? (
                        <div className="wms-exception-list">
                          {dispatcher.exceptions.slice(0, 10).map((item) => (
                            <article key={item.id}>
                              <div>
                                <strong>{item.task_type} · {item.status}</strong>
                                <span>
                                  {(item.from_code ?? "—") + " → " + (item.to_code ?? "—")}
                                  {item.sku_code ? " · " + item.sku_code : ""}
                                </span>
                              </div>
                              <small>{item.last_error ?? "Задача слишком долго находится в работе"}</small>
                              {item.exception_id && item.status === "BLOCKED" ? (
                                <button
                                  className="secondary-button"
                                  type="button"
                                  onClick={() => void requeueException(item.exception_id!)}
                                >
                                  Вернуть в очередь
                                </button>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      ) : null}
                    </section>

                    <section className="section-block">
                      <div className="section-heading">
                        <div>
                          <p className="muted">Labor / 24 часа</p>
                          <h2>Производительность склада</h2>
                        </div>
                      </div>

                      <div className="wms-dispatcher-grid">
                        <article>
                          <span>Завершено</span>
                          <strong>{labor?.summary.completed ?? 0}</strong>
                        </article>
                        <article>
                          <span>Задач / час</span>
                          <strong>{labor?.summary.tasks_per_hour ?? 0}</strong>
                        </article>
                        <article>
                          <span>Медиана цикла</span>
                          <strong>{labor?.summary.median_cycle_minutes ?? "—"}<small> мин</small></strong>
                        </article>
                        <article>
                          <span>Активные сотрудники</span>
                          <strong>{labor?.summary.active_operators ?? 0}</strong>
                        </article>
                      </div>

                      <div className="wms-risk-row">
                        <span>до 15м: <b>{labor?.backlogRisk.fresh ?? 0}</b></span>
                        <span>15–30м: <b>{labor?.backlogRisk.watch ?? 0}</b></span>
                        <span>30–60м: <b>{labor?.backlogRisk.risk ?? 0}</b></span>
                        <span>60м+: <b>{labor?.backlogRisk.critical ?? 0}</b></span>
                      </div>

                      {labor?.operators.length ? (
                        <div className="data-table-wrap">
                          <table className="data-table">
                            <thead>
                              <tr>
                                <th>Сотрудник</th>
                                <th>Завершено</th>
                                <th>В работе</th>
                                <th>Медиана</th>
                              </tr>
                            </thead>
                            <tbody>
                              {labor.operators.slice(0, 12).map((operator) => (
                                <tr key={operator.membership_id}>
                                  <td>{operator.email}</td>
                                  <td>{operator.completed}</td>
                                  <td>{operator.active}</td>
                                  <td>{operator.median_cycle_minutes ?? "—"} мин</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : null}
                    </section>

                    <section className="section-block">
                      <div className="section-heading">
                        <div>
                          <p className="muted">Wave picking</p>
                          <h2>Waves</h2>
                        </div>
                        <button
                          className="secondary-button"
                          onClick={() => void createWave()}
                          type="button"
                        >
                          Создать wave
                        </button>
                      </div>

                      <div className="wms-task-list">
                        {waves.map((wave) => {
                          const progress = wave.tasks
                            ? Math.round((wave.completed_tasks / wave.tasks) * 100)
                            : 0;

                          return (
                            <article key={wave.id} className="wms-task-card">
                              <div>
                                <span>{wave.strategy} · {wave.status}</span>
                                <strong>
                                  {wave.completed_tasks}/{wave.tasks} задач · {progress}%
                                </strong>
                                <small>
                                  Открыто {wave.open_tasks} · в работе {wave.claimed_tasks}
                                  {wave.failed_tasks ? " · ошибок " + wave.failed_tasks : ""}
                                </small>
                              </div>

                              <div className="table-actions">
                                {wave.status === "DRAFT" ? (
                                  <button
                                    onClick={() => void releaseWave(wave)}
                                    type="button"
                                  >
                                    Выпустить
                                  </button>
                                ) : ["RELEASED","IN_PROGRESS"].includes(wave.status) ? (
                                  <button
                                    onClick={() => void claimNextWave(wave)}
                                    type="button"
                                  >
                                    Следующая задача
                                  </button>
                                ) : null}
                              </div>
                            </article>
                          );
                        })}

                        {!waves.length ? (
                          <div className="table-empty">
                            <strong>Waves ещё нет</strong>
                            <span>
                              Сначала подготовьте заказ, затем сгруппируйте OPEN PICK-задачи.
                            </span>
                          </div>
                        ) : null}
                      </div>
                    </section>

                    <section className="section-block">
                      <div className="section-heading">
                        <div>
                          <p className="muted">Warehouse Tasks</p>
                          <h2>Задачи склада</h2>
                        </div>
                      </div>

                      <div className="wms-task-list">
                        {tasks
                          .filter((task) => task.status !== "COMPLETED")
                          .map((task) => (
                            <article key={task.id} className="wms-task-card">
                              <div>
                                <span>
                                  {task.task_type} · {task.status}
                                  {(task as any).cluster_slot
                                    ? " · " + (task as any).cluster_slot
                                    : ""}
                                </span>
                                <strong>
                                  {task.product_name
                                    ? task.product_name + " · " + task.sku_code
                                    : task.task_type === "PACK"
                                      ? "Упаковка заказа"
                                      : task.task_type === "SHIP"
                                        ? "Финальная отгрузка заказа"
                                        : "Складская задача"}
                                </strong>
                                <small>
                                  {(task.from_code ?? "—") + " → " + (task.to_code ?? "—")}
                                  {task.quantity_milli
                                    ? " · " + Number(task.quantity_milli) / 1000
                                    : ""}
                                </small>
                              </div>

                              {task.status === "OPEN" ? (
                                <button
                                  onClick={() => void claimTask(task)}
                                  type="button"
                                >
                                  Взять
                                </button>
                              ) : task.status === "CLAIMED" ? (
                                <button
                                  onClick={() => void completeTask(task)}
                                  type="button"
                                >
                                  Готово
                                </button>
                              ) : null}
                            </article>
                          ))}

                        {!tasks.some((task) => task.status !== "COMPLETED") ? (
                          <div className="table-empty">
                            <strong>Активных задач нет</strong>
                            <span>Новые задачи появятся после приёмки, размещения или планирования заказа.</span>
                          </div>
                        ) : null}
                      </div>
                    </section>
                  </>
                ) : null}
              </>
            ) : null}
          </section>
        </div>
      </section>
    </main>
  );
}
