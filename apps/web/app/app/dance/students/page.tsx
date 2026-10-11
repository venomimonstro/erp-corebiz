"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { DanceWorkspaceNav } from "../../../../components/dance-workspace-nav";
import { StudioModal } from "../../../../components/studio-modal";
import { apiRequest } from "../../../../lib/api";

type Customer = {
  id: string;
  displayName: string;
  phone: string | null;
};

type Student = {
  id: string;
  party_id: string;
  display_name: string;
  birth_date: string | null;
  training_level: string | null;
  status: string;
  payer_party_id: string | null;
  payer_name: string | null;
  debt_minor: string;
  active_groups: number;
};

type Charge = {
  id: string;
  student_id: string;
  student_name: string;
  payer_party_id: string;
  payer_name: string;
  source_type: string;
  amount_minor: string;
  due_at: string | null;
  status: string;
  obligation_id: string;
  invoice_number: string | null;
  settled_minor: string;
  remaining_minor: string;
};

type Plan = {
  id: string;
  name: string;
  package_kind: string;
  visit_limit: number | null;
  duration_days: number;
  price_minor: string;
  currency: string;
};

type MakeupCredit = {
  id: string;
  student_id: string;
  student_name: string;
  expires_at: string;
  program_name: string | null;
  group_name: string | null;
  status: string;
};

type Pack = {
  id: string;
  party_id: string;
  beneficiary_party_ids?: string[];
  plan_name: string;
  package_kind_snapshot: string;
  expires_at: string;
  available_visits: number | null;
  status: string;
};

function money(value: string) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0
  }).format(Number(value) / 100);
}

export default function DanceStudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [charges, setCharges] = useState<Charge[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [packages, setPackages] = useState<Pack[]>([]);
  const [makeupCredits, setMakeupCredits] = useState<MakeupCredit[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [studentModal, setStudentModal] = useState(false);
  const [studentPartyId, setStudentPartyId] = useState("");
  const [studentBirthDate, setStudentBirthDate] = useState("");
  const [studentPayerId, setStudentPayerId] = useState("");
  const [payerModal, setPayerModal] = useState(false);
  const [payerPartyId, setPayerPartyId] = useState("");
  const [chargeModal, setChargeModal] = useState(false);
  const [chargeRub, setChargeRub] = useState("");
  const [chargeDueAt, setChargeDueAt] = useState(new Date().toISOString().slice(0,10));
  const [chargeNote, setChargeNote] = useState("");
  const [packageModal, setPackageModal] = useState(false);
  const [packagePlanId, setPackagePlanId] = useState("");

  const load = useCallback(async () => {
    setError("");
    try {
      const [
        studentRows,
        customerRows,
        chargeRows,
        planRows,
        packageRows,
        makeupRows
      ] = await Promise.all([
          apiRequest<Student[]>("/dance/students"),
          apiRequest<Customer[]>("/crm/customers"),
          apiRequest<Charge[]>("/dance/charges"),
          apiRequest<Plan[]>("/service/package-plans"),
          apiRequest<Pack[]>("/service/packages"),
          apiRequest<MakeupCredit[]>("/dance/makeup-credits")
        ]);
      setStudents(studentRows);
      setCustomers(customerRows);
      setCharges(chargeRows);
      setPlans(planRows);
      setPackages(packageRows);
      setMakeupCredits(makeupRows);
      setSelectedId((current) =>
        studentRows.some((item) => item.id === current)
          ? current
          : studentRows[0]?.id ?? ""
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить учеников");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = students.find((item) => item.id === selectedId) ?? null;
  const selectedCharges = charges.filter((item) => item.student_id === selectedId);
  const selectedPackages = packages.filter(
    (item) =>
      selected &&
      (
        item.party_id === selected.party_id ||
        item.beneficiary_party_ids?.includes(selected.party_id)
      )
  );
  const selectedMakeups = makeupCredits.filter(
    (item) => item.student_id === selectedId
  );

  const payerOpenCharges = useMemo(() => {
    if (!selected?.payer_party_id) return [];
    return charges
      .filter(
        (item) =>
          item.payer_party_id === selected.payer_party_id &&
          BigInt(item.remaining_minor || "0") > 0n
      )
      .sort((a, b) =>
        String(a.due_at ?? "9999").localeCompare(String(b.due_at ?? "9999"))
      );
  }, [charges, selected]);

  function openStudentModal() {
    if (!customers.length) {
      setError("Сначала создайте клиента или родителя в CRM");
      return;
    }
    setStudentPartyId("");
    setStudentBirthDate("");
    setStudentPayerId("");
    setStudentModal(true);
  }

  async function addStudent() {
    if (!studentPartyId) {
      setError("Выберите ученика из CRM");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      const created = await apiRequest<{ id: string }>("/dance/students", {
        method: "POST",
        body: JSON.stringify({
          partyId: studentPartyId,
          birthDate: studentBirthDate || undefined,
          payerPartyId: studentPayerId || undefined,
          payerRelation: studentPayerId ? "PARENT" : undefined
        })
      });
      setStudentModal(false);
      setNotice("Ученик добавлен в студию.");
      await load();
      setSelectedId(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось добавить ученика");
    } finally {
      setPending(false);
    }
  }

  function openPayerModal() {
    if (!selected) return;
    setPayerPartyId(selected.payer_party_id ?? "");
    setPayerModal(true);
  }

  async function addPayer() {
    if (!selected || !payerPartyId) {
      setError("Выберите плательщика");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(`/dance/students/${selected.id}/relationships`, {
        method: "POST",
        body: JSON.stringify({
          partyId: payerPartyId,
          relationType: "PAYER",
          isPrimary: true
        })
      });
      setPayerModal(false);
      setNotice("Плательщик назначен.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось назначить плательщика");
    } finally {
      setPending(false);
    }
  }

  function openChargeModal() {
    if (!selected) return;
    setChargeRub("");
    setChargeDueAt(new Date().toISOString().slice(0,10));
    setChargeNote("");
    setChargeModal(true);
  }

  async function addCharge() {
    if (!selected) return;
    const amountRub = Number(chargeRub.replace(",", "."));
    if (!Number.isFinite(amountRub) || amountRub <= 0) {
      setError("Укажите корректную сумму начисления");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(`/dance/students/${selected.id}/charges`, {
        method: "POST",
        body: JSON.stringify({
          payerPartyId: selected.payer_party_id ?? undefined,
          sourceType: "OTHER",
          amountMinor: String(Math.round(amountRub * 100)),
          dueAt: chargeDueAt || undefined,
          note: chargeNote.trim() || undefined
        })
      });
      setChargeModal(false);
      setNotice("Начисление создано.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать начисление");
    } finally {
      setPending(false);
    }
  }

  async function payFamilyDebt() {
    if (!selected?.payer_party_id || !payerOpenCharges.length) return;
    const totalOpen = payerOpenCharges.reduce(
      (sum, item) => sum + BigInt(item.remaining_minor),
      0n
    );
    const rub = Number(
      (
        window.prompt(
          "Сумма оплаты семьи, ₽",
          String(Number(totalOpen) / 100)
        ) ?? "0"
      ).replace(",", ".")
    );
    if (!Number.isFinite(rub) || rub <= 0) return;

    let left = BigInt(Math.round(rub * 100));
    const allocations: Array<{ obligationId: string; amountMinor: string }> = [];
    for (const charge of payerOpenCharges) {
      if (left <= 0n) break;
      const open = BigInt(charge.remaining_minor);
      const amount = open < left ? open : left;
      allocations.push({
        obligationId: charge.obligation_id,
        amountMinor: amount.toString()
      });
      left -= amount;
    }
    if (left > 0n) {
      setError("Оплата превышает общую задолженность семьи");
      return;
    }

    setPending(true);
    try {
      await apiRequest("/finance/allocated-payment", {
        method: "POST",
        body: JSON.stringify({
          partyId: selected.payer_party_id,
          allocations,
          idempotencyKey: crypto.randomUUID(),
          note: "Оплата семьи через студию"
        })
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось провести семейную оплату");
    } finally {
      setPending(false);
    }
  }

  function openPackageModal() {
    if (!selected) return;
    setPackagePlanId(plans[0]?.id ?? "");
    setPackageModal(true);
  }

  async function issuePackage() {
    if (!selected || !packagePlanId) {
      setError("Выберите тариф");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest("/service/packages", {
        method: "POST",
        body: JSON.stringify({
          planId: packagePlanId,
          partyId: selected.party_id,
          payerPartyId: selected.payer_party_id ?? selected.party_id,
          startsAt: new Date().toISOString()
        })
      });
      setPackageModal(false);
      setNotice("Абонемент выдан ученику.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось выдать абонемент");
    } finally {
      setPending(false);
    }
  }

  async function addFamilyBeneficiary(pack: Pack) {
    if (pack.package_kind_snapshot !== "FAMILY") return;
    const candidates = students.filter((item) => item.id !== selectedId);
    if (!candidates.length) return;
    const child = candidates[
      Number(window.prompt(
        "Добавить ребёнка в семейный абонемент:\n" +
          candidates.map((item, index) => `${index + 1}. ${item.display_name}`).join("\n"),
        "1"
      )) - 1
    ];
    if (!child) return;

    try {
      await apiRequest(`/dance/packages/${pack.id}/beneficiaries`, {
        method: "POST",
        body: JSON.stringify({ studentId: child.id })
      });
      window.alert("Ребёнок добавлен в семейный абонемент");
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось добавить бенефициара"
      );
    }
  }

  async function freezePackage(pack: Pack) {
    const startsOn = window.prompt(
      "Начало заморозки YYYY-MM-DD",
      new Date().toISOString().slice(0, 10)
    );
    if (!startsOn) return;
    const endsOn = window.prompt("Конец заморозки YYYY-MM-DD", startsOn);
    if (!endsOn) return;

    const cancelFutureReservations = window.confirm(
      "Снять записи на занятия внутри периода заморозки? OK = снять и вернуть посещения, Отмена = оставить существующие записи."
    );

    try {
      const result = await apiRequest<{
        cancelledReservations: number;
        promotedFromWaitlist: number;
      }>(`/dance/packages/${pack.id}/freeze`, {
        method: "POST",
        body: JSON.stringify({
          startsOn,
          endsOn,
          reason: window.prompt("Причина", "Отпуск / болезнь") || undefined,
          cancelFutureReservations
        })
      });
      if (cancelFutureReservations) {
        window.alert(
          `Снято будущих записей: ${result.cancelledReservations}. Мест передано из waitlist: ${result.promotedFromWaitlist}.`
        );
      }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось заморозить абонемент");
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="dance-students" />
      <section className="workspace workspace-wide studio-premium">
        <header className="studio-hero compact">
          <div>
            <span className="studio-eyebrow">Клиенты и финансы</span>
            <h1>Ученики и семьи</h1>
            <p>
              Ребёнок, плательщик, абонементы, начисления, долг и отработки
              собраны в одной рабочей карточке.
            </p>
          </div>
          <div className="studio-hero-actions">
            <a className="secondary-button" href="/app/service/packages">Тарифы</a>
            <button onClick={openStudentModal} type="button">+ Ученик</button>
          </div>
        </header>

        <DanceWorkspaceNav active="students" />

        {error ? <div className="studio-message error"><strong>Ученики</strong><span>{error}</span></div> : null}
        {notice ? <div className="studio-message success"><strong>Готово</strong><span>{notice}</span></div> : null}

        <section className="studio-client-switcher">
          <div>
            <span>Карточка ученика</span>
            <strong>{students.length} учеников в студии</strong>
          </div>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>
            <option value="">Выберите ученика</option>
            {students.map((student) => (
              <option key={student.id} value={student.id}>
                {student.display_name} · долг {money(student.debt_minor)}
              </option>
            ))}
          </select>
        </section>

        {selected ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Ученик</span>
                <strong>{selected.display_name}</strong>
                <small>{selected.status} · {selected.training_level ?? "уровень не задан"}</small>
              </article>
              <article className="owner-kpi">
                <span>Плательщик</span>
                <strong>{selected.payer_name ?? "Сам ученик"}</strong>
                <small>{selected.payer_party_id ? "семейный контур" : "личная оплата"}</small>
              </article>
              <article className="owner-kpi">
                <span>Долг ученика</span>
                <strong>{money(selected.debt_minor)}</strong>
                <small>{selectedCharges.filter((item) => BigInt(item.remaining_minor) > 0n).length} открытых начислений</small>
              </article>
              <article className="owner-kpi">
                <span>Группы</span>
                <strong>{selected.active_groups}</strong>
                <small>{selectedPackages.filter((item) => item.status === "ACTIVE").length} активных абонементов</small>
              </article>
            </div>

            <div className="header-actions" style={{ marginBottom: 20, flexWrap: "wrap" }}>
              <button className="secondary-button" onClick={openPayerModal} type="button">
                Плательщик
              </button>
              <button className="secondary-button" onClick={openPackageModal} type="button">
                + Абонемент
              </button>
              <button className="secondary-button" onClick={openChargeModal} type="button">
                + Начисление
              </button>
              <button disabled={pending || !payerOpenCharges.length} onClick={() => void payFamilyDebt()} type="button">
                Оплатить долги семьи
              </button>
            </div>

            <section className="section-block">
              <div className="section-heading"><div><p className="muted">Финансы</p><h2>Начисления ученика</h2></div></div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>За что</th><th>Плательщик</th><th>Начислено</th><th>Оплачено</th><th>Осталось</th><th>Срок</th><th>Статус</th></tr></thead>
                  <tbody>
                    {selectedCharges.map((charge) => (
                      <tr key={charge.id}>
                        <td><strong>{charge.source_type}</strong><small>{charge.invoice_number ?? charge.id}</small></td>
                        <td>{charge.payer_name}</td>
                        <td>{money(charge.amount_minor)}</td>
                        <td>{money(charge.settled_minor)}</td>
                        <td><strong>{money(charge.remaining_minor)}</strong></td>
                        <td>{charge.due_at ? new Date(charge.due_at).toLocaleDateString("ru-RU") : "—"}</td>
                        <td><span className="status-pill">{charge.status}</span></td>
                      </tr>
                    ))}
                    {!selectedCharges.length ? (
                      <tr><td colSpan={7}><div className="table-empty"><strong>Начислений нет</strong></div></td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Отработки</p>
                  <h2>Компенсационные занятия</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Статус</th>
                      <th>Направление</th>
                      <th>Группа</th>
                      <th>Использовать до</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedMakeups.map((credit) => (
                      <tr key={credit.id}>
                        <td><span className="status-pill">{credit.status}</span></td>
                        <td>{credit.program_name ?? "Любое направление"}</td>
                        <td>{credit.group_name ?? "Любая подходящая группа"}</td>
                        <td>{new Date(credit.expires_at).toLocaleDateString("ru-RU")}</td>
                      </tr>
                    ))}
                    {!selectedMakeups.length ? (
                      <tr>
                        <td colSpan={4}>
                          <div className="table-empty">
                            <strong>Отработок нет</strong>
                            <span>Они появятся после уважительного пропуска по тарифу с разрешённой отработкой.</span>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="section-block">
              <div className="section-heading"><div><p className="muted">Абонементы</p><h2>Права на занятия</h2></div></div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead><tr><th>Абонемент</th><th>Тип</th><th>Осталось</th><th>Действует до</th><th>Статус</th><th></th></tr></thead>
                  <tbody>
                    {selectedPackages.map((pack) => (
                      <tr key={pack.id}>
                        <td><strong>{pack.plan_name}</strong></td>
                        <td>{pack.package_kind_snapshot}</td>
                        <td>{pack.available_visits === null ? "∞" : pack.available_visits}</td>
                        <td>{new Date(pack.expires_at).toLocaleDateString("ru-RU")}</td>
                        <td><span className="status-pill">{pack.status}</span></td>
                        <td>
                          <div className="table-actions">
                            {pack.package_kind_snapshot === "FAMILY" ? (
                              <button className="secondary-button" onClick={() => void addFamilyBeneficiary(pack)} type="button">
                                + Ребёнок
                              </button>
                            ) : null}
                            {pack.status === "ACTIVE" ? (
                              <button className="secondary-button" onClick={() => void freezePackage(pack)} type="button">
                                Заморозить
                              </button>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!selectedPackages.length ? (
                      <tr><td colSpan={6}><div className="table-empty"><strong>Абонементов нет</strong></div></td></tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        ) : (
          <div className="table-empty">
            <strong>Учеников пока нет</strong>
            <span>Создайте клиента в CRM и добавьте его как ученика студии.</span>
          </div>
        )}
        {studentModal ? (
          <StudioModal
            eyebrow="Новый ученик"
            title="Добавить ученика в студию"
            description="Выберите клиента из CRM. Родителя-плательщика можно назначить сразу."
            onClose={() => setStudentModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setStudentModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void addStudent()}>{pending ? "Сохраняем…" : "Добавить ученика"}</button>
              </>
            }
          >
            <div className="studio-form-section">
              <div className="studio-form-grid">
                <label>
                  <span>Ученик / клиент CRM</span>
                  <select value={studentPartyId} onChange={(event) => setStudentPartyId(event.target.value)}>
                    <option value="">Выберите клиента</option>
                    {customers.map((customer) => (
                      <option key={customer.id} value={customer.id}>
                        {customer.displayName}{customer.phone ? " · " + customer.phone : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Дата рождения</span>
                  <input type="date" value={studentBirthDate} onChange={(event) => setStudentBirthDate(event.target.value)} />
                </label>
              </div>
              <label>
                <span>Родитель / плательщик</span>
                <select value={studentPayerId} onChange={(event) => setStudentPayerId(event.target.value)}>
                  <option value="">Ученик платит сам / назначить позже</option>
                  {customers.filter((customer) => customer.id !== studentPartyId).map((customer) => (
                    <option key={customer.id} value={customer.id}>{customer.displayName}</option>
                  ))}
                </select>
              </label>
            </div>
          </StudioModal>
        ) : null}

        {payerModal && selected ? (
          <StudioModal
            eyebrow="Семья"
            title="Кто оплачивает занятия"
            description={"Основной плательщик для " + selected.display_name + ". Новые начисления будут связаны с ним."}
            onClose={() => setPayerModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setPayerModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void addPayer()}>{pending ? "Сохраняем…" : "Назначить"}</button>
              </>
            }
          >
            <label>
              <span>Плательщик</span>
              <select value={payerPartyId} onChange={(event) => setPayerPartyId(event.target.value)}>
                <option value="">Выберите клиента</option>
                {customers.filter((customer) => customer.id !== selected.party_id).map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.displayName}{customer.phone ? " · " + customer.phone : ""}
                  </option>
                ))}
              </select>
            </label>
          </StudioModal>
        ) : null}

        {chargeModal && selected ? (
          <StudioModal
            eyebrow="Финансы"
            title="Новое начисление"
            description={"Начисление для " + selected.display_name + (selected.payer_name ? ". Плательщик: " + selected.payer_name : "")}
            onClose={() => setChargeModal(false)}
            footer={
              <>
                <button className="secondary-button" type="button" onClick={() => setChargeModal(false)}>Отмена</button>
                <button disabled={pending} type="button" onClick={() => void addCharge()}>{pending ? "Сохраняем…" : "Начислить"}</button>
              </>
            }
          >
            <div className="studio-form-grid">
              <label>
                <span>Сумма, ₽</span>
                <input autoFocus inputMode="decimal" placeholder="6 000" value={chargeRub} onChange={(event) => setChargeRub(event.target.value)} />
              </label>
              <label>
                <span>Оплатить до</span>
                <input type="date" value={chargeDueAt} onChange={(event) => setChargeDueAt(event.target.value)} />
              </label>
            </div>
            <label>
              <span>За что начисление</span>
              <input placeholder="Например, обучение за октябрь" value={chargeNote} onChange={(event) => setChargeNote(event.target.value)} />
            </label>
          </StudioModal>
        ) : null}

        {packageModal && selected ? (
          <StudioModal
            eyebrow="Абонемент"
            title="Выдать готовый тариф"
            description="Цена, срок и правила посещения уже заданы в конструкторе тарифов."
            onClose={() => setPackageModal(false)}
            footer={
              <>
                <a className="secondary-button" href="/app/service/packages">Настроить тарифы</a>
                <button disabled={pending || !packagePlanId} type="button" onClick={() => void issuePackage()}>{pending ? "Выдаём…" : "Выдать абонемент"}</button>
              </>
            }
          >
            <label>
              <span>Тариф</span>
              <select value={packagePlanId} onChange={(event) => setPackagePlanId(event.target.value)}>
                <option value="">Выберите тариф</option>
                {plans.map((plan) => (
                  <option key={plan.id} value={plan.id}>
                    {plan.name} · {plan.visit_limit === null ? "безлимит" : plan.visit_limit + " посещ."} · {money(plan.price_minor)}
                  </option>
                ))}
              </select>
            </label>
            <div className="student-package-summary">
              <span>Ученик</span><strong>{selected.display_name}</strong>
              <span>Плательщик</span><strong>{selected.payer_name ?? selected.display_name}</strong>
            </div>
          </StudioModal>
        ) : null}

      </section>
    </main>
  );
}
