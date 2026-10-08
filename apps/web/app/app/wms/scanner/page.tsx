"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiRequest } from "../../../../lib/api";

type Warehouse = {
  id: string;
  name: string;
  code: string;
  wms_status: string | null;
  stock_tracking_state: string | null;
};

type ScanType = "FROM_LOCATION" | "TO_LOCATION" | "SKU" | "ORDER";

type ScannerTask = {
  id: string;
  warehouseId: string;
  taskType: string;
  status: string;
  priority: number;
  skuId: string | null;
  skuCode: string | null;
  barcode: string | null;
  productName: string | null;
  quantityMilli: string | null;
  fromLocationId: string | null;
  fromCode: string | null;
  toLocationId: string | null;
  toCode: string | null;
  orderNumber: string | null;
  waveId: string | null;
  clusterSlot: string | null;
  instructions: Record<string, unknown>;
  requiredScans: ScanType[];
  completedScans: ScanType[];
  nextScan: ScanType | null;
};

const SCAN_LABEL: Record<ScanType, string> = {
  FROM_LOCATION: "Сканируйте исходную ячейку",
  TO_LOCATION: "Сканируйте целевую ячейку",
  SKU: "Сканируйте товар",
  ORDER: "Сканируйте заказ"
};

function qty(value: string | null): string {
  if (!value) return "—";
  return (Number(value) / 1000).toLocaleString("ru-RU", {
    maximumFractionDigits: 3
  });
}

export default function WmsScannerPage() {
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [task, setTask] = useState<ScannerTask | null>(null);
  const [scan, setScan] = useState("");
  const [counted, setCounted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [online, setOnline] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setOnline(navigator.onLine);

    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/wms-sw.js");
    }

    void apiRequest<Warehouse[]>("/wms/warehouses")
      .then((rows) => {
        const active = rows.filter(
          (row) =>
            row.wms_status === "ACTIVE" &&
            row.stock_tracking_state === "LOCATION_LEDGER"
        );
        setWarehouses(active);

        const saved = window.localStorage.getItem("corebiz_wms_warehouse");
        const initial =
          active.find((row) => row.id === saved)?.id ??
          active[0]?.id ??
          "";
        setWarehouseId(initial);
      })
      .catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить склады"
        );
      });

    return () => {
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  useEffect(() => {
    if (!warehouseId) return;
    window.localStorage.setItem("corebiz_wms_warehouse", warehouseId);
    setTask(null);
    void nextTask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warehouseId]);

  useEffect(() => {
    if (!busy && task?.nextScan) {
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 80);
      return () => window.clearTimeout(timer);
    }
  }, [busy, task?.nextScan]);

  const scanHint = useMemo(() => {
    if (!task?.nextScan) return null;
    if (task.nextScan === "FROM_LOCATION") return task.fromCode;
    if (task.nextScan === "TO_LOCATION") return task.toCode;
    if (task.nextScan === "SKU") return task.skuCode;
    return task.orderNumber;
  }, [task]);

  async function nextTask() {
    if (!warehouseId || busy || !online) return;

    setBusy(true);
    setError("");
    setScan("");
    setCounted("");

    try {
      const next = await apiRequest<ScannerTask | null>(
        "/wms/warehouses/" + warehouseId + "/scanner/next",
        { method: "POST" }
      );
      setTask(next);
      if (next && navigator.vibrate) navigator.vibrate(30);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось получить задачу"
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitScan(event: FormEvent) {
    event.preventDefault();
    if (!task?.nextScan || !scan.trim() || busy || !online) return;

    setBusy(true);
    setError("");

    try {
      const updated = await apiRequest<ScannerTask>(
        "/wms/scanner/tasks/" + task.id + "/scan",
        {
          method: "POST",
          body: JSON.stringify({
            scanType: task.nextScan,
            value: scan.trim()
          })
        }
      );
      setTask(updated);
      setScan("");
      if (navigator.vibrate) navigator.vibrate([30, 30, 30]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Скан не принят"
      );
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    if (!task || task.nextScan || busy || !online) return;

    if (task.taskType === "COUNT" && !/^\d+(?:[.,]\d{1,3})?$/.test(counted)) {
      setError("Укажите фактическое количество");
      return;
    }

    setBusy(true);
    setError("");

    try {
      await apiRequest(
        "/wms/scanner/tasks/" + task.id + "/complete",
        {
          method: "POST",
          body: JSON.stringify({
            countedMilli:
              task.taskType === "COUNT"
                ? String(
                    Math.round(
                      Number(counted.replace(",", ".")) * 1000
                    )
                  )
                : undefined
          })
        }
      );

      if (navigator.vibrate) navigator.vibrate([50, 30, 80]);
      setTask(null);
      await nextTask();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось завершить задачу"
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="scanner-shell">
      <header className="scanner-header">
        <div>
          <span>CoreBiz WMS</span>
          <strong>Сканер</strong>
        </div>

        <select
          value={warehouseId}
          onChange={(event) => setWarehouseId(event.target.value)}
          disabled={busy}
        >
          {warehouses.map((warehouse) => (
            <option key={warehouse.id} value={warehouse.id}>
              {warehouse.name}
            </option>
          ))}
        </select>
      </header>

      {!online ? (
        <div className="scanner-offline">
          Нет сети. Экран доступен, но складские операции отправляются только
          после восстановления соединения.
        </div>
      ) : null}

      {error ? (
        <div className="scanner-error">
          <strong>Проверьте операцию</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {!warehouseId ? (
        <section className="scanner-empty">
          <strong>Нет активного адресного WMS</strong>
          <span>
            Сначала включите ячеечный учёт для склада в полном интерфейсе.
          </span>
        </section>
      ) : task ? (
        <section className="scanner-task">
          <div className="scanner-task-top">
            <div>
              <span>{task.taskType}</span>
              <strong>
                {task.productName ??
                  (task.taskType === "PACK"
                    ? "Упаковать заказ"
                    : task.taskType === "SHIP"
                      ? "Отгрузить заказ"
                      : "Складская задача")}
              </strong>
            </div>

            {task.clusterSlot ? (
              <b className="scanner-cluster">{task.clusterSlot}</b>
            ) : null}
          </div>

          <div className="scanner-facts">
            {task.skuCode ? (
              <div>
                <span>SKU</span>
                <strong>{task.skuCode}</strong>
              </div>
            ) : null}
            {task.quantityMilli ? (
              <div>
                <span>Количество</span>
                <strong>{qty(task.quantityMilli)}</strong>
              </div>
            ) : null}
            {task.fromCode ? (
              <div>
                <span>Откуда</span>
                <strong>{task.fromCode}</strong>
              </div>
            ) : null}
            {task.toCode ? (
              <div>
                <span>Куда</span>
                <strong>{task.toCode}</strong>
              </div>
            ) : null}
            {task.orderNumber ? (
              <div>
                <span>Заказ</span>
                <strong>{task.orderNumber}</strong>
              </div>
            ) : null}
          </div>

          <div className="scanner-progress">
            {task.requiredScans.map((item) => (
              <span
                key={item}
                className={
                  task.completedScans.includes(item) ? "done" : ""
                }
              >
                {task.completedScans.includes(item) ? "✓" : "○"}{" "}
                {SCAN_LABEL[item].replace("Сканируйте ", "")}
              </span>
            ))}
          </div>

          {task.nextScan ? (
            <form className="scanner-scan" onSubmit={submitScan}>
              <label>
                <span>{SCAN_LABEL[task.nextScan]}</span>
                {scanHint ? <small>Ожидается: {scanHint}</small> : null}
                <input
                  ref={inputRef}
                  value={scan}
                  onChange={(event) => setScan(event.target.value)}
                  placeholder="Сканируйте или введите код"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  disabled={busy || !online}
                />
              </label>
              <button
                type="submit"
                disabled={!scan.trim() || busy || !online}
              >
                {busy ? "Проверяем…" : "Подтвердить скан"}
              </button>
            </form>
          ) : (
            <div className="scanner-complete">
              {task.taskType === "COUNT" ? (
                <label>
                  <span>Фактическое количество</span>
                  <input
                    value={counted}
                    onChange={(event) => setCounted(event.target.value)}
                    inputMode="decimal"
                    placeholder="0"
                  />
                </label>
              ) : null}

              <button
                onClick={() => void complete()}
                disabled={busy || !online}
                type="button"
              >
                {busy ? "Завершаем…" : "Готово"}
              </button>
            </div>
          )}
        </section>
      ) : (
        <section className="scanner-empty">
          <strong>{busy ? "Ищем задачу…" : "Свободных задач нет"}</strong>
          <span>
            Как только диспетчер выпустит wave или появится складская операция,
            она появится здесь.
          </span>
          <button
            onClick={() => void nextTask()}
            disabled={busy || !online}
            type="button"
          >
            Обновить
          </button>
        </section>
      )}
    </main>
  );
}
