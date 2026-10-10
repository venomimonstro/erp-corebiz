"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type LegalEntity = {
  id: string;
  name: string;
  inn: string | null;
  kpp: string | null;
};

type Organization = {
  legalEntities: LegalEntity[];
};

type Period = {
  id: string;
  date_from: string;
  date_to: string;
  state: string;
};

type TrialRow = {
  id: string;
  code: string;
  name: string;
  debit_minor: string;
  credit_minor: string;
  net_debit_minor: string;
};

type Entry = {
  id: string;
  business_date: string;
  source_type: string;
  source_id: string;
  posting_key: string;
  rule_code: string;
  rule_version: number;
  amount_minor: string;
  posted_at: string;
};

type VatDocument = {
  id: string;
  document_kind: string;
  document_number: string;
  document_date: string;
  taxable_base_minor: string;
  vat_amount_minor: string;
  rate_code: string;
  status: string;
};

type VatRegister = {
  id: string;
  event_date: string;
  register_kind: string;
  amount_minor: string;
  document_number: string;
};

type PayrollBatch = {
  id: string;
  period_from: string;
  period_to: string;
  status: string;
  currency: string;
  employees: number;
  gross_minor: string;
  deduction_minor: string;
  approved_at: string | null;
};

type CloseCheck = {
  code: string;
  status: string;
  note: string | null;
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yearStart(): string {
  const now = new Date();
  return now.getUTCFullYear() + "-01-01";
}

function money(value: string, currency = "RUB"): string {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency,
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function AccountingPage() {
  const [entities, setEntities] = useState<LegalEntity[]>([]);
  const [legalEntityId, setLegalEntityId] = useState("");
  const [from, setFrom] = useState(yearStart());
  const [to, setTo] = useState(today());
  const [periods, setPeriods] = useState<Period[]>([]);
  const [trial, setTrial] = useState<TrialRow[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [vatDocs, setVatDocs] = useState<VatDocument[]>([]);
  const [vatRegister, setVatRegister] = useState<VatRegister[]>([]);
  const [payroll, setPayroll] = useState<PayrollBatch[]>([]);
  const [checks, setChecks] = useState<CloseCheck[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [tab, setTab] = useState<"overview"|"journal"|"vat"|"payroll">("overview");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void apiRequest<Organization>("/organization")
      .then((data) => {
        setEntities(data.legalEntities);
        if (data.legalEntities[0]) {
          setLegalEntityId(data.legalEntities[0].id);
        }
      })
      .catch((cause) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить юрлица"
        )
      );
  }, []);

  const load = useCallback(async () => {
    if (!legalEntityId) return;
    setBusy(true);
    setError("");

    try {
      const [
        periodRows,
        trialRows,
        entryRows,
        vatDocRows,
        vatRegisterRows,
        payrollRows
      ] = await Promise.all([
        apiRequest<Period[]>(
          "/accounting/periods?legalEntityId=" +
            encodeURIComponent(legalEntityId)
        ),
        apiRequest<TrialRow[]>(
          "/accounting/trial-balance?legalEntityId=" +
            encodeURIComponent(legalEntityId) +
            "&dateFrom=" +
            encodeURIComponent(from) +
            "&dateTo=" +
            encodeURIComponent(to)
        ),
        apiRequest<Entry[]>(
          "/accounting/entries?legalEntityId=" +
            encodeURIComponent(legalEntityId)
        ),
        apiRequest<VatDocument[]>(
          "/accounting/vat/documents?legalEntityId=" +
            encodeURIComponent(legalEntityId)
        ),
        apiRequest<VatRegister[]>(
          "/accounting/vat/register?legalEntityId=" +
            encodeURIComponent(legalEntityId)
        ),
        apiRequest<PayrollBatch[]>(
          "/accounting/payroll/batches?legalEntityId=" +
            encodeURIComponent(legalEntityId)
        )
      ]);

      setPeriods(periodRows);
      setTrial(trialRows);
      setEntries(entryRows);
      setVatDocs(vatDocRows);
      setVatRegister(vatRegisterRows);
      setPayroll(payrollRows);

      const nextPeriod =
        periodRows.find((period) => period.id === selectedPeriod) ??
        periodRows[0] ??
        null;
      setSelectedPeriod(nextPeriod?.id ?? "");

      if (nextPeriod) {
        setChecks(
          await apiRequest<CloseCheck[]>(
            "/accounting/periods/checks?periodId=" +
              encodeURIComponent(nextPeriod.id)
          )
        );
      } else {
        setChecks([]);
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить бухгалтерию"
      );
    } finally {
      setBusy(false);
    }
  }, [legalEntityId, from, to, selectedPeriod]);

  useEffect(() => {
    void load();
  }, [load]);

  async function choosePeriod(id: string) {
    setSelectedPeriod(id);
    if (!id) {
      setChecks([]);
      return;
    }
    try {
      setChecks(
        await apiRequest<CloseCheck[]>(
          "/accounting/periods/checks?periodId=" +
            encodeURIComponent(id)
        )
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить закрытие месяца"
      );
    }
  }

  async function createPeriod() {
    if (!legalEntityId) return;
    const dateFrom = window.prompt("Начало периода YYYY-MM-DD", from);
    if (!dateFrom) return;
    const dateTo = window.prompt("Конец периода YYYY-MM-DD", to);
    if (!dateTo) return;

    try {
      await apiRequest("/accounting/periods", {
        method: "POST",
        body: JSON.stringify({
          legalEntityId,
          dateFrom,
          dateTo
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось создать период"
      );
    }
  }

  async function markCheck(code: string, status: "DONE"|"PENDING"|"BLOCKED") {
    if (!selectedPeriod) return;
    try {
      await apiRequest("/accounting/periods/checks", {
        method: "POST",
        body: JSON.stringify({
          periodId: selectedPeriod,
          code,
          status
        })
      });
      await choosePeriod(selectedPeriod);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось обновить проверку"
      );
    }
  }

  async function lockPeriod() {
    if (!selectedPeriod) return;
    const targetState = window.confirm(
      "OK — HARD_LOCKED. Отмена — SOFT_LOCKED."
    )
      ? "HARD_LOCKED"
      : "SOFT_LOCKED";
    const reason = window.prompt(
      "Причина блокировки периода (обязательно)",
      "Период проверен и закрыт ответственным бухгалтером."
    );
    if (!reason?.trim()) return;

    try {
      await apiRequest("/accounting/periods/lock", {
        method: "POST",
        body: JSON.stringify({
          periodId: selectedPeriod,
          targetState,
          reason: reason.trim()
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось закрыть период"
      );
    }
  }

  async function createPayrollBatch() {
    if (!legalEntityId) return;
    const periodFrom = window.prompt("Начало payroll-периода", from);
    if (!periodFrom) return;
    const periodTo = window.prompt("Конец payroll-периода", to);
    if (!periodTo) return;

    try {
      await apiRequest("/accounting/payroll/batches", {
        method: "POST",
        body: JSON.stringify({
          legalEntityId,
          periodFrom,
          periodTo
        })
      });
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать payroll batch"
      );
    }
  }

  const currentEntity = useMemo(
    () => entities.find((entity) => entity.id === legalEntityId) ?? null,
    [entities, legalEntityId]
  );

  const selected = useMemo(
    () => periods.find((period) => period.id === selectedPeriod) ?? null,
    [periods, selectedPeriod]
  );

  const vatDrafts = vatDocs.filter((document) => document.status === "DRAFT").length;
  const payrollDrafts = payroll.filter((batch) => batch.status === "DRAFT").length;

  return (
    <main className="app-shell">
      <AppSidebar active="accounting" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Финансы / Бухгалтерия РФ</p>
            <h1>Бухгалтерия</h1>
            <p className="workspace-summary">
              Периоды, проводки, НДС и payroll в одном рабочем месте. Закрытие
              периода не изменяет историю задним числом.
            </p>
          </div>

          <div className="header-actions">
            <select
              value={legalEntityId}
              onChange={(event) => setLegalEntityId(event.target.value)}
            >
              {entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.name}
                </option>
              ))}
            </select>
            <button
              className="secondary-button"
              onClick={() => void load()}
              disabled={busy}
              type="button"
            >
              Обновить
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Бухгалтерия</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {!currentEntity ? (
          <div className="table-empty">
            <strong>Нет юридического лица</strong>
            <span>Создайте юрлицо в настройках организации.</span>
          </div>
        ) : (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Юрлицо</span>
                <strong>{currentEntity.name}</strong>
                <small>
                  ИНН {currentEntity.inn ?? "не указан"}
                </small>
              </article>
              <article className="owner-kpi">
                <span>Периоды</span>
                <strong>{periods.length}</strong>
                <small>
                  открыто {periods.filter((period) => period.state === "OPEN").length}
                </small>
              </article>
              <article className="owner-kpi">
                <span>НДС требует внимания</span>
                <strong>{vatDrafts}</strong>
                <small>документов в DRAFT</small>
              </article>
              <article className="owner-kpi">
                <span>Payroll draft</span>
                <strong>{payrollDrafts}</strong>
                <small>расчётов не утверждено</small>
              </article>
            </div>

            <div className="accounting-tabs">
              {[
                ["overview","ОСВ и закрытие"],
                ["journal","Проводки"],
                ["vat","НДС"],
                ["payroll","Зарплата"]
              ].map(([key,label]) => (
                <button
                  key={key}
                  className={tab === key ? "active" : ""}
                  onClick={() => setTab(key as typeof tab)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>

            {tab === "overview" ? (
              <>
                <section className="section-block">
                  <div className="section-heading">
                    <div>
                      <p className="muted">Trial balance</p>
                      <h2>Оборотно-сальдовая ведомость</h2>
                    </div>
                    <div className="header-actions">
                      <input
                        type="date"
                        value={from}
                        onChange={(event) => setFrom(event.target.value)}
                      />
                      <input
                        type="date"
                        value={to}
                        onChange={(event) => setTo(event.target.value)}
                      />
                    </div>
                  </div>

                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Счёт</th>
                          <th>Название</th>
                          <th>Дебет</th>
                          <th>Кредит</th>
                          <th>Сальдо</th>
                        </tr>
                      </thead>
                      <tbody>
                        {trial.map((row) => (
                          <tr key={row.id}>
                            <td><strong>{row.code}</strong></td>
                            <td>{row.name}</td>
                            <td>{money(row.debit_minor)}</td>
                            <td>{money(row.credit_minor)}</td>
                            <td>{money(row.net_debit_minor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="section-block">
                  <div className="section-heading">
                    <div>
                      <p className="muted">Month close</p>
                      <h2>Закрытие периода</h2>
                    </div>
                    <button onClick={() => void createPeriod()} type="button">
                      + Период
                    </button>
                  </div>

                  <div className="accounting-period-grid">
                    <label>
                      <span>Период</span>
                      <select
                        value={selectedPeriod}
                        onChange={(event) => void choosePeriod(event.target.value)}
                      >
                        <option value="">Выберите период</option>
                        {periods.map((period) => (
                          <option key={period.id} value={period.id}>
                            {period.date_from} — {period.date_to} · {period.state}
                          </option>
                        ))}
                      </select>
                    </label>

                    {selected ? (
                      <button
                        className="secondary-button"
                        disabled={selected.state !== "OPEN"}
                        onClick={() => void lockPeriod()}
                        type="button"
                      >
                        Заблокировать период
                      </button>
                    ) : null}
                  </div>

                  <div className="action-queue">
                    {checks.map((check) => (
                      <article className="action-item" key={check.code}>
                        <span
                          className={
                            "severity-dot " +
                            (check.status === "BLOCKED" ? "critical" : "")
                          }
                        />
                        <div>
                          <small>Month close</small>
                          <strong>{check.code}</strong>
                          <span>{check.note ?? "Комментария нет"}</span>
                        </div>
                        <div className="table-actions">
                          <button
                            className="secondary-button"
                            onClick={() => void markCheck(check.code, "PENDING")}
                          >
                            PENDING
                          </button>
                          <button
                            onClick={() => void markCheck(check.code, "DONE")}
                          >
                            DONE
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              </>
            ) : null}

            {tab === "journal" ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Double entry</p>
                    <h2>Журнал проводок</h2>
                  </div>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Дата</th>
                        <th>Источник</th>
                        <th>Правило</th>
                        <th>Сумма</th>
                        <th>Posting key</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((entry) => (
                        <tr key={entry.id}>
                          <td>{entry.business_date}</td>
                          <td>{entry.source_type}</td>
                          <td>{entry.rule_code} v{entry.rule_version}</td>
                          <td>{money(entry.amount_minor)}</td>
                          <td><small>{entry.posting_key}</small></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}

            {tab === "vat" ? (
              <>
                <section className="section-block">
                  <div className="section-heading">
                    <div>
                      <p className="muted">VAT documents</p>
                      <h2>Документы НДС</h2>
                    </div>
                  </div>
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Дата</th>
                          <th>Документ</th>
                          <th>Вид</th>
                          <th>База</th>
                          <th>НДС</th>
                          <th>Статус</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vatDocs.map((doc) => (
                          <tr key={doc.id}>
                            <td>{doc.document_date}</td>
                            <td><strong>{doc.document_number}</strong></td>
                            <td>{doc.document_kind}</td>
                            <td>{money(doc.taxable_base_minor)}</td>
                            <td>{money(doc.vat_amount_minor)}</td>
                            <td><span className="status-pill">{doc.status}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>

                <section className="section-block">
                  <div className="section-heading">
                    <div>
                      <p className="muted">VAT register</p>
                      <h2>Регистр НДС</h2>
                    </div>
                  </div>
                  <div className="data-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Дата</th>
                          <th>Документ</th>
                          <th>Регистр</th>
                          <th>Сумма</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vatRegister.map((row) => (
                          <tr key={row.id}>
                            <td>{row.event_date}</td>
                            <td>{row.document_number}</td>
                            <td>{row.register_kind}</td>
                            <td>{money(row.amount_minor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </>
            ) : null}

            {tab === "payroll" ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Payroll staging</p>
                    <h2>Начисления зарплаты</h2>
                  </div>
                  <button onClick={() => void createPayrollBatch()} type="button">
                    + Расчёт
                  </button>
                </div>
                <div className="data-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Период</th>
                        <th>Статус</th>
                        <th>Сотрудники</th>
                        <th>Начислено</th>
                        <th>Удержания</th>
                        <th>К выплате</th>
                      </tr>
                    </thead>
                    <tbody>
                      {payroll.map((batch) => (
                        <tr key={batch.id}>
                          <td>{batch.period_from} — {batch.period_to}</td>
                          <td><span className="status-pill">{batch.status}</span></td>
                          <td>{batch.employees}</td>
                          <td>{money(batch.gross_minor, batch.currency)}</td>
                          <td>{money(batch.deduction_minor, batch.currency)}</td>
                          <td>
                            {money(
                              (
                                BigInt(batch.gross_minor) -
                                BigInt(batch.deduction_minor)
                              ).toString(),
                              batch.currency
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ) : null}
          </>
        )}
      </section>
    </main>
  );
}
