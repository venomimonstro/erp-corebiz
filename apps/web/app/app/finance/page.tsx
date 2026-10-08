"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type FinanceSummary = {
  accounts: Array<{
    id: string;
    name: string;
    kind: string;
    currency: string;
    balanceMinor: string;
    isDefault: boolean;
  }>;
  receivableMinor: string;
  payableMinor: string;
  overdueReceivableMinor: string;
  overduePayableMinor: string;
};

type Obligation = {
  id: string;
  direction: "RECEIVABLE" | "PAYABLE";
  partyName: string | null;
  sourceType: string;
  sourceId: string;
  amountMinor: string;
  settledMinor: string;
  remainingMinor: string;
  currency: string;
  status: string;
  dueAt: string | null;
};

type Payment = {
  id: string;
  number: string;
  accountName: string;
  partyName: string | null;
  direction: "IN" | "OUT";
  kind: "PAYMENT" | "REFUND";
  amountMinor: string;
  currency: string;
  status: string;
  postedAt: string;
  note: string | null;
};

function money(value: string, currency = "RUB"): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(Number(value) / 100);
}

export default function FinancePage() {
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [obligations, setObligations] = useState<Obligation[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const [summaryData, obligationData, paymentData] = await Promise.all([
        apiRequest<FinanceSummary>("/finance/summary"),
        apiRequest<Obligation[]>("/finance/obligations"),
        apiRequest<Payment[]>("/finance/payments")
      ]);

      setSummary(summaryData);
      setObligations(obligationData);
      setPayments(paymentData);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить финансы");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totalCash = useMemo(
    () =>
      summary?.accounts.reduce(
        (sum, account) => sum + BigInt(account.balanceMinor),
        0n
      ) ?? 0n,
    [summary]
  );

  async function createAccount() {
    const name = window.prompt("Название денежного счёта");
    if (!name?.trim()) return;

    const openingRub = Number(
      (window.prompt("Начальный остаток, ₽", "0") ?? "0").replace(",", ".")
    );

    if (!Number.isFinite(openingRub)) {
      setError("Некорректный начальный остаток");
      return;
    }

    try {
      await apiRequest("/finance/accounts", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          openingBalanceMinor: String(Math.round(openingRub * 100))
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать счёт");
    }
  }

  async function settle(obligation: Obligation) {
    const remainingRub = Number(obligation.remainingMinor) / 100;
    const raw = window.prompt(
      obligation.direction === "RECEIVABLE"
        ? `Получено от клиента, ₽\nОсталось: ${remainingRub}`
        : `Оплачено поставщику, ₽\nОсталось: ${remainingRub}`,
      String(remainingRub)
    );

    if (raw === null) return;

    const amountRub = Number(raw.replace(",", "."));
    if (
      !Number.isFinite(amountRub) ||
      amountRub <= 0 ||
      amountRub > remainingRub
    ) {
      setError("Некорректная сумма платежа");
      return;
    }

    try {
      const path =
        obligation.direction === "RECEIVABLE"
          ? "/finance/sales-payment"
          : "/finance/supplier-payment";

      const body =
        obligation.direction === "RECEIVABLE"
          ? {
              orderId: obligation.sourceId,
              amountMinor: String(Math.round(amountRub * 100)),
              idempotencyKey: crypto.randomUUID()
            }
          : {
              purchaseOrderId: obligation.sourceId,
              amountMinor: String(Math.round(amountRub * 100)),
              idempotencyKey: crypto.randomUUID()
            };

      await apiRequest(path, {
        method: "POST",
        body: JSON.stringify(body)
      });

      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось провести платёж");
    }
  }

  async function refund(obligation: Obligation) {
    if (obligation.direction !== "RECEIVABLE") return;

    const settledRub = Number(obligation.settledMinor) / 100;
    if (settledRub <= 0) {
      setError("По этому заказу пока нечего возвращать");
      return;
    }

    const raw = window.prompt(
      `Сумма возврата клиенту, ₽\nПолучено ранее: ${settledRub}`,
      String(settledRub)
    );
    if (raw === null) return;

    const amountRub = Number(raw.replace(",", "."));
    if (
      !Number.isFinite(amountRub) ||
      amountRub <= 0 ||
      amountRub > settledRub
    ) {
      setError("Некорректная сумма возврата");
      return;
    }

    try {
      await apiRequest("/finance/sales-refund", {
        method: "POST",
        body: JSON.stringify({
          orderId: obligation.sourceId,
          amountMinor: String(Math.round(amountRub * 100)),
          idempotencyKey: crypto.randomUUID()
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось провести возврат");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="finance" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Финансы / Управленческий учёт</p>
            <h1>Деньги</h1>
            <p className="workspace-summary">
              Деньги ≠ прибыль. Здесь только денежные счета и обязательства.
            </p>
          </div>

          <button onClick={createAccount} type="button">+ Счёт</button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Не удалось выполнить действие</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading ? <div className="board-loading">Загружаем финансы…</div> : null}

        {!loading && summary ? (
          <>
            <div className="metric-grid">
              <article className="metric-card">
                <span>Деньги на счетах</span>
                <strong>{money(totalCash.toString())}</strong>
                <small>{summary.accounts.length} денежных счетов</small>
              </article>

              <article className="metric-card">
                <span>Нам должны</span>
                <strong>{money(summary.receivableMinor)}</strong>
                <small>
                  Просрочено {money(summary.overdueReceivableMinor)}
                </small>
              </article>

              <article className="metric-card">
                <span>Мы должны</span>
                <strong>{money(summary.payableMinor)}</strong>
                <small>
                  Просрочено {money(summary.overduePayableMinor)}
                </small>
              </article>
            </div>

            <div className="finance-accounts">
              {summary.accounts.map((account) => (
                <article className="account-card" key={account.id}>
                  <div>
                    <strong>{account.name}</strong>
                    <span>{account.kind}</span>
                  </div>
                  <strong>{money(account.balanceMinor, account.currency)}</strong>
                </article>
              ))}
            </div>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">AR / AP</p>
                  <h2>Обязательства</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Тип</th>
                      <th>Контрагент</th>
                      <th>Сумма</th>
                      <th>Оплачено</th>
                      <th>Осталось</th>
                      <th>Статус</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {obligations.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.direction === "RECEIVABLE"
                            ? "Дебиторка"
                            : "Кредиторка"}
                        </td>
                        <td>{item.partyName ?? "Без контрагента"}</td>
                        <td>{money(item.amountMinor, item.currency)}</td>
                        <td>{money(item.settledMinor, item.currency)}</td>
                        <td><strong>{money(item.remainingMinor, item.currency)}</strong></td>
                        <td><span className="status-pill">{item.status}</span></td>
                        <td className="table-actions">
                          {BigInt(item.remainingMinor) > 0n ? (
                            <button onClick={() => void settle(item)} type="button">
                              {item.direction === "RECEIVABLE" ? "Получить" : "Оплатить"}
                            </button>
                          ) : null}

                          {item.direction === "RECEIVABLE" &&
                          BigInt(item.settledMinor) > 0n ? (
                            <button
                              className="secondary-button"
                              onClick={() => void refund(item)}
                              type="button"
                            >
                              Возврат
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}

                    {obligations.length === 0 ? (
                      <tr>
                        <td colSpan={7}>
                          <div className="table-empty">
                            <strong>Обязательств пока нет</strong>
                            <span>
                              Они появятся после подтверждения продаж и закупок.
                            </span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Cash flow</p>
                  <h2>Последние платежи</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Платёж</th>
                      <th>Счёт</th>
                      <th>Контрагент</th>
                      <th>Направление</th>
                      <th>Сумма</th>
                      <th>Дата</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.slice(0, 100).map((payment) => (
                      <tr key={payment.id}>
                        <td>
                          <strong>{payment.number}</strong>
                          <small>{payment.kind}</small>
                        </td>
                        <td>{payment.accountName}</td>
                        <td>{payment.partyName ?? "—"}</td>
                        <td>{payment.direction === "IN" ? "Поступление" : "Списание"}</td>
                        <td>
                          <strong>
                            {payment.direction === "IN" ? "+" : "-"}
                            {money(payment.amountMinor, payment.currency)}
                          </strong>
                        </td>
                        <td>{new Date(payment.postedAt).toLocaleString("ru-RU")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : null}
      </section>
    </main>
  );
}
