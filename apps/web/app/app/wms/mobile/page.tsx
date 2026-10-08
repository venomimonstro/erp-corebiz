"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { apiRequest } from "../../../../lib/api";

type Warehouse = {
  id: string;
  name: string;
  code: string;
  wms_status: string | null;
  stock_tracking_state: string | null;
};

type MobileTask = {
  id: string;
  task_type: string;
  status: string;
  priority: number;
  sku_id: string | null;
  sku_code: string | null;
  barcode: string | null;
  product_name: string | null;
  quantity_milli: string | null;
  from_code: string | null;
  from_short_code: string | null;
  to_code: string | null;
  to_short_code: string | null;
  wave_id: string | null;
  cluster_slot: string | null;
  instructions: Record<string, unknown>;
  verifiedScans: string[];
};

type ScanKind = "FROM_LOCATION" | "SKU" | "TO_LOCATION";

type OfflineAction = {
  id: string;
  path: string;
  method: "POST";
  body?: Record<string, unknown>;
};

const QUEUE_KEY = "corebiz_wms_mobile_queue_v1";

function readQueue(): OfflineAction[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(QUEUE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: OfflineAction[]) {
  window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-200)));
}

export default function WmsMobilePage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [task, setTask] = useState<MobileTask | null>(null);
  const [scanValue, setScanValue] = useState("");
  const [online, setOnline] = useState(true);
  const [queueCount, setQueueCount] = useState(0);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const scannerRef = useRef<HTMLInputElement>(null);

  const refreshQueueCount = useCallback(() => {
    setQueueCount(readQueue().length);
  }, []);

  const flushQueue = useCallback(async () => {
    if (typeof navigator !== "undefined" && !navigator.onLine) return;

    const queue = readQueue();
    if (!queue.length) {
      setQueueCount(0);
      return;
    }

    const remaining: OfflineAction[] = [];

    for (let index = 0; index < queue.length; index += 1) {
      const action = queue[index]!;
      try {
        await apiRequest(action.path, {
          method: action.method,
          body: action.body ? JSON.stringify(action.body) : undefined
        });
      } catch {
        remaining.push(...queue.slice(index));
        break;
      }
    }

    writeQueue(remaining);
    setQueueCount(remaining.length);

    if (!remaining.length) {
      setMessage("Офлайн-очередь синхронизирована.");
    }
  }, []);

  useEffect(() => {
    setOnline(navigator.onLine);
    refreshQueueCount();

    const onOnline = () => {
      setOnline(true);
      void flushQueue();
    };
    const onOffline = () => setOnline(false);

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/wms-sw.js").catch(() => {});
    }

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [flushQueue, refreshQueueCount]);

  useEffect(() => {
    void apiRequest<Warehouse[]>("/wms/warehouses")
      .then((rows) => {
        const enabled = rows.filter(
          (row) =>
            row.wms_status === "ACTIVE" &&
            row.stock_tracking_state === "LOCATION_LEDGER"
        );
        setWarehouses(enabled);
        if (!warehouseId && enabled[0]) {
          setWarehouseId(enabled[0].id);
        }
      })
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить склады"
        )
      );
  }, [warehouseId]);

  const loadNext = useCallback(async () => {
    if (!warehouseId) return;
    if (!navigator.onLine) {
      setError("Нет сети. Новую задачу можно получить после подключения.");
      return;
    }

    setBusy("next");
    setError("");
    setMessage("");

    try {
      const next = await apiRequest<MobileTask | null>(
        "/wms/mobile/warehouses/" + warehouseId + "/next"
      );
      setTask(next);
      setScanValue("");
      if (!next) {
        setMessage("Свободных задач сейчас нет.");
      }
      setTimeout(() => scannerRef.current?.focus(), 50);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось получить задачу"
      );
    } finally {
      setBusy("");
    }
  }, [warehouseId]);

  useEffect(() => {
    if (warehouseId && !task && navigator.onLine) {
      void loadNext();
    }
  }, [warehouseId, task, loadNext]);

  const requiredScans = useMemo<ScanKind[]>(() => {
    if (!task) return [];
    const result: ScanKind[] = [];
    if (task.from_code) result.push("FROM_LOCATION");
    if (task.sku_code) result.push("SKU");
    if (task.to_code && task.to_code !== task.from_code) {
      result.push("TO_LOCATION");
    }
    return result;
  }, [task]);

  const nextScan = useMemo(
    () =>
      requiredScans.find(
        (kind) => !task?.verifiedScans.includes(kind)
      ) ?? null,
    [requiredScans, task]
  );

  function enqueue(action: OfflineAction) {
    const queue = readQueue();
    queue.push(action);
    writeQueue(queue);
    setQueueCount(queue.length);
  }

  async function submitScan() {
    if (!task || !nextScan) return;
    const value = scanValue.trim();
    if (!value) return;

    const body = {
      kind: nextScan,
      value,
      idempotencyKey: crypto.randomUUID()
    };

    if (!navigator.onLine) {
      enqueue({
        id: crypto.randomUUID(),
        path: "/wms/mobile/tasks/" + task.id + "/scan",
        method: "POST",
        body
      });
      setTask({
        ...task,
        verifiedScans: [...task.verifiedScans, nextScan]
      });
      setScanValue("");
      setMessage("Скан сохранён офлайн и будет проверен после подключения.");
      scannerRef.current?.focus();
      return;
    }

    setBusy("scan");
    setError("");

    try {
      await apiRequest(
        "/wms/mobile/tasks/" + task.id + "/scan",
        {
          method: "POST",
          body: JSON.stringify(body)
        }
      );
      setTask({
        ...task,
        verifiedScans: [...task.verifiedScans, nextScan]
      });
      setScanValue("");
      scannerRef.current?.focus();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Скан не прошёл проверку"
      );
      setScanValue("");
      scannerRef.current?.focus();
    } finally {
      setBusy("");
    }
  }

  function completeEndpoint(taskType: string) {
    if (taskType === "PUTAWAY") return "complete-putaway";
    if (taskType === "PICK") return "complete-pick";
    if (taskType === "PACK") return "complete-pack";
    if (taskType === "SHIP") return "complete-ship";
    if (taskType === "REPLENISH") return "complete-replenishment";
    return null;
  }

  async function completeTask() {
    if (!task) return;

    if (nextScan) {
      setError("Сначала выполните обязательные сканы.");
      scannerRef.current?.focus();
      return;
    }

    let path = "";
    let body: Record<string, unknown> | undefined;

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
        setError("Некорректный фактический остаток.");
        return;
      }
      path = "/wms/tasks/" + task.id + "/complete-count";
      body = {
        countedMilli: String(Math.round(quantity * 1000))
      };
    } else {
      const endpoint = completeEndpoint(task.task_type);
      if (!endpoint) {
        setError("Этот тип задачи пока нельзя завершить с ТСД.");
        return;
      }
      path = "/wms/tasks/" + task.id + "/" + endpoint;
    }

    if (!navigator.onLine) {
      enqueue({
        id: crypto.randomUUID(),
        path,
        method: "POST",
        body
      });
      setTask(null);
      setMessage(
        "Завершение поставлено в офлайн-очередь. Следующая задача появится после синхронизации."
      );
      return;
    }

    setBusy("complete");
    setError("");

    try {
      await apiRequest(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined
      });
      setTask(null);
      setMessage("Задача завершена.");
      await loadNext();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось завершить задачу"
      );
    } finally {
      setBusy("");
    }
  }

  async function reportProblem() {
    if (!task) return;

    const type = (
      window.prompt(
        "Тип: STOCK_MISMATCH, LOCATION_BLOCKED, BARCODE_MISMATCH, DAMAGE, EQUIPMENT, OTHER",
        "STOCK_MISMATCH"
      ) ?? ""
    ).toUpperCase();

    if (
      ![
        "STOCK_MISMATCH",
        "LOCATION_BLOCKED",
        "BARCODE_MISMATCH",
        "DAMAGE",
        "EQUIPMENT",
        "OTHER"
      ].includes(type)
    ) {
      return;
    }

    const detail = window.prompt("Что произошло?", "") ?? "";
    const path = "/wms/mobile/tasks/" + task.id + "/problem";
    const body = {
      exceptionType: type,
      message: detail
    };

    if (!navigator.onLine) {
      enqueue({
        id: crypto.randomUUID(),
        path,
        method: "POST",
        body
      });
      setTask(null);
      setMessage("Проблема сохранена в офлайн-очередь.");
      return;
    }

    setBusy("problem");
    try {
      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify(body)
      });
      setTask(null);
      setMessage("Задача заблокирована и отправлена диспетчеру.");
      await loadNext();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось сообщить о проблеме"
      );
    } finally {
      setBusy("");
    }
  }

  const scanLabel =
    nextScan === "FROM_LOCATION"
      ? "Сканируйте исходную ячейку"
      : nextScan === "SKU"
        ? "Сканируйте товар / штрихкод"
        : nextScan === "TO_LOCATION"
          ? "Сканируйте целевую ячейку"
          : "Все обязательные сканы выполнены";

  return (
    <main className="wms-mobile">
      <header className="wms-mobile-topbar">
        <div>
          <strong>Business OS · WMS</strong>
          <span className={online ? "online" : "offline"}>
            {online ? "онлайн" : "офлайн"}
            {queueCount ? " · очередь " + queueCount : ""}
          </span>
        </div>

        <select
          value={warehouseId}
          onChange={(event) => {
            setWarehouseId(event.target.value);
            setTask(null);
          }}
        >
          {warehouses.map((warehouse) => (
            <option key={warehouse.id} value={warehouse.id}>
              {warehouse.name}
            </option>
          ))}
        </select>
      </header>

      <section className="wms-mobile-main">
        {error ? (
          <div className="wms-mobile-error">{error}</div>
        ) : null}
        {message ? (
          <div className="wms-mobile-message">{message}</div>
        ) : null}

        {!task ? (
          <div className="wms-mobile-empty">
            <span>Очередь склада</span>
            <h1>Готовы к следующей задаче?</h1>
            <button
              onClick={() => void loadNext()}
              disabled={!warehouseId || busy !== ""}
              type="button"
            >
              {busy === "next" ? "Получаем…" : "Следующая задача"}
            </button>
          </div>
        ) : (
          <>
            <article className="wms-mobile-task">
              <div className="wms-mobile-task-head">
                <div>
                  <span>
                    {task.task_type}
                    {task.cluster_slot
                      ? " · тележка " + task.cluster_slot
                      : ""}
                  </span>
                  <h1>
                    {task.product_name ||
                      (task.task_type === "PACK"
                        ? "Упаковка заказа"
                        : task.task_type === "SHIP"
                          ? "Отгрузка заказа"
                          : "Складская задача")}
                  </h1>
                </div>
                {task.quantity_milli ? (
                  <strong>
                    {Number(task.quantity_milli) / 1000}
                  </strong>
                ) : null}
              </div>

              <div className="wms-mobile-route">
                <div>
                  <span>Откуда</span>
                  <strong>{task.from_code || "—"}</strong>
                </div>
                <b>→</b>
                <div>
                  <span>Куда</span>
                  <strong>{task.to_code || "—"}</strong>
                </div>
              </div>

              {task.sku_code ? (
                <div className="wms-mobile-sku">
                  <span>SKU</span>
                  <strong>{task.sku_code}</strong>
                  {task.barcode ? <small>{task.barcode}</small> : null}
                </div>
              ) : null}
            </article>

            {requiredScans.length ? (
              <section className="wms-mobile-scan">
                <div className="wms-mobile-scan-progress">
                  {requiredScans.map((kind) => (
                    <span
                      key={kind}
                      className={
                        task.verifiedScans.includes(kind)
                          ? "done"
                          : kind === nextScan
                            ? "current"
                            : ""
                      }
                    >
                      {kind === "FROM_LOCATION"
                        ? "Откуда"
                        : kind === "SKU"
                          ? "Товар"
                          : "Куда"}
                    </span>
                  ))}
                </div>

                <label>
                  <span>{scanLabel}</span>
                  <input
                    ref={scannerRef}
                    autoFocus
                    autoComplete="off"
                    inputMode="none"
                    value={scanValue}
                    onChange={(event) =>
                      setScanValue(event.target.value)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void submitScan();
                      }
                    }}
                    placeholder="Сканер или код + Enter"
                  />
                </label>

                <button
                  className="secondary"
                  type="button"
                  disabled={!scanValue.trim() || busy === "scan"}
                  onClick={() => void submitScan()}
                >
                  Проверить скан
                </button>
              </section>
            ) : null}

            <div className="wms-mobile-actions">
              <button
                className="problem"
                type="button"
                disabled={busy !== ""}
                onClick={() => void reportProblem()}
              >
                Проблема
              </button>
              <button
                className="complete"
                type="button"
                disabled={Boolean(nextScan) || busy !== ""}
                onClick={() => void completeTask()}
              >
                {busy === "complete" ? "Проводим…" : "Готово"}
              </button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
