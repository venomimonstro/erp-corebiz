"use client";

import { useCallback, useEffect, useState } from "react";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type Check = {
  code: string;
  title: string;
  ok: boolean;
  blocking: boolean;
  detail: string;
  href: string;
};

type Readiness = {
  profile: string;
  ready: boolean;
  stage: "PREPARING" | "HYPERCARE" | "LIVE";
  goLiveAt: string | null;
  hypercareUntil: string | null;
  blockers: Check[];
  warnings: Check[];
  checks: Check[];
  history: Array<{
    id: string;
    decision: "GO" | "NO_GO";
    note: string | null;
    reviewed_at: string;
  }>;
};

export default function GoLivePage() {
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading,setLoading]=useState(true);
  const [pendingDecision,setPendingDecision]=useState<"GO"|"NO_GO"|"LIVE"|null>(null);
  const [reviewNote,setReviewNote]=useState("");
  const [acknowledged,setAcknowledged]=useState(false);

  const load = useCallback(async () => {
    // Never preserve an old GO snapshot when the current check fails.
    setData(null);
    setLoading(true);
    setError("");
    try {
      setData(await apiRequest<Readiness>("/go-live/readiness"));
    } catch (cause) {
      setError(
        (cause instanceof Error
          ? cause.message
          : "Не удалось проверить готовность")+
        ". Решения о запуске заблокированы до успешной перепроверки."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function requestDecision(decision:"GO"|"NO_GO"|"LIVE"){
    if(!data || busy || loading)return;
    if((decision==="GO"||decision==="LIVE")&&!data.ready)return;
    if(decision==="LIVE"&&data.stage!=="HYPERCARE")return;
    setPendingDecision(decision);
    setReviewNote("");
    setAcknowledged(false);
    setError("");
  }

  async function submitDecision(event:React.FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(!pendingDecision||!data||busy||loading)return;
    if(!acknowledged)return;
    if(pendingDecision!=="LIVE"&&reviewNote.trim().length<12){
      setError("Укажите причину или основание решения (не менее 12 символов).");
      return;
    }
    if((pendingDecision==="GO"||pendingDecision==="LIVE")&&!data.ready){
      setError("Обязательная перепроверка не пройдена. Запуск заблокирован.");
      return;
    }
    setBusy(true);
    setError("");
    try{
      if(pendingDecision==="LIVE"){
        await apiRequest("/go-live/finish-hypercare",{method:"POST"});
      }else{
        await apiRequest("/go-live/review",{
          method:"POST",
          body:JSON.stringify({
            decision:pendingDecision,
            note:reviewNote.trim(),
            hypercareDays:14
          })
        });
      }
      setPendingDecision(null);
      setAcknowledged(false);
      setReviewNote("");
      await load();
    }catch(cause){
      setError(
        (cause instanceof Error?cause.message:"Не удалось сохранить решение")+
        ". Проверьте текущее состояние до повторного подтверждения."
      );
      // An uncertain response must not leave stale GO displayed.
      setData(null);
    }finally{
      setBusy(false);
    }
  }

  return (
    <main className="app-shell">
      <AppSidebar active="go-live" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Управление / Запуск</p>
            <h1>Готовность к запуску</h1>
            <p className="workspace-summary">
              Проверка запуска отдельной компании: бизнес-сценарии, релиз и,
              для торговых ниш, подтверждённые платежи, чеки и отгрузка.
              Это не разрешение на публичную продажу SaaS, не deploy и не
              подтверждение налогового соответствия без реальных E2E.
            </p>
          </div>

          <div className="header-actions">
            <button
              className="secondary-button"
              type="button"
              disabled={busy||loading}
              onClick={() => void load()}
            >
              {loading?"Проверяем…":"Перепроверить"}
            </button>
            <button
              className="secondary-button"
              disabled={busy||loading||!data}
              type="button"
              onClick={() => requestDecision("NO_GO")}
            >
              NO-GO
            </button>
            <button
              disabled={busy||loading||!data?.ready}
              type="button"
              onClick={() => requestDecision("GO")}
            >
              GO
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Go-Live</strong>
            <span>{error}</span>
          </div>
        ) : null}

        {loading?<p role="status" className="muted">Проверяем готовность вашей компании…</p>:null}

        {pendingDecision&&data?(
          <section className="section-block go-live-decision" aria-label="Подтверждение решения">
            <h2>{pendingDecision==="GO"?"Начать контролируемый запуск":
              pendingDecision==="NO_GO"?"Зафиксировать проблемы запуска":
                "Подтвердить переход в рабочий режим"}</h2>
            <p className="muted">
              {pendingDecision==="GO"
                ?"Это переведёт компанию в период усиленного контроля HYPERCARE. "
                 +"Никакой deploy или фискальный запуск автоматически не выполняется."
                :pendingDecision==="NO_GO"
                  ?"Решение сохранит причины и список блокеров. Данные бизнеса не удаляются."
                  :"Переход в LIVE допустим только после завершения периода наблюдения "
                   +"и успешной повторной проверки на сервере."}
            </p>
            <form onSubmit={event=>void submitDecision(event)} className="go-live-decision-form">
              {pendingDecision!=="LIVE"?(
                <label>Основание решения
                  <textarea rows={3} minLength={12} maxLength={2000} required
                    placeholder="Что проверено и почему принято решение"
                    value={reviewNote}
                    onChange={event=>setReviewNote(event.target.value)}/>
                </label>
              ):null}
              <label className="go-live-decision-consent">
                <input type="checkbox" checked={acknowledged}
                  onChange={event=>setAcknowledged(event.target.checked)}/>
                <span>Понимаю последствия решения и подтверждаю, что проверил(а)
                  актуальный статус своей компании.</span>
              </label>
              <div className="go-live-decision-actions">
                <button type="submit" disabled={busy||!acknowledged||
                  ((pendingDecision==="GO"||pendingDecision==="LIVE")&&!data.ready)||
                  (pendingDecision!=="LIVE"&&reviewNote.trim().length<12)}>
                  {busy?"Сохраняем…":"Подтвердить решение"}
                </button>
                <button type="button" className="secondary-button"
                  disabled={busy} onClick={()=>setPendingDecision(null)}>Отмена</button>
              </div>
            </form>
          </section>
        ):null}

        {data ? (
          <>
            <div className="owner-kpi-grid">
              <article className="owner-kpi">
                <span>Readiness</span>
                <strong>{data.ready ? "GO" : "NO-GO"}</strong>
                <small>
                  {data.blockers.length} blockers · {data.warnings.length} warnings
                </small>
              </article>
              <article className="owner-kpi">
                <span>Stage</span>
                <strong>{data.stage}</strong>
                <small>Профиль: {data.profile}</small>
              </article>
              <article className="owner-kpi">
                <span>Go-live</span>
                <strong>
                  {data.goLiveAt
                    ? new Date(data.goLiveAt).toLocaleDateString("ru-RU")
                    : "—"}
                </strong>
                <small>Первый формальный GO</small>
              </article>
              <article className="owner-kpi">
                <span>Hypercare до</span>
                <strong>
                  {data.hypercareUntil
                    ? new Date(data.hypercareUntil).toLocaleDateString("ru-RU")
                    : "—"}
                </strong>
                <small>Контроль после запуска</small>
              </article>
            </div>

            {data.blockers.length ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Что нужно исправить</p>
                    <h2>Что мешает запуску</h2>
                  </div>
                </div>

                <div className="action-queue">
                  {data.blockers.map((check) => (
                    <a className="action-item" href={check.href} key={check.code}>
                      <span className="severity-dot critical" />
                      <div>
                        <small>{check.code}</small>
                        <strong>{check.title}</strong>
                        <span>{check.detail}</span>
                      </div>
                      <b>Исправить →</b>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}

            {data.warnings.length ? (
              <section className="section-block">
                <div className="section-heading">
                  <div>
                    <p className="muted">Non-blocking</p>
                    <h2>Предупреждения</h2>
                  </div>
                </div>

                <div className="action-queue">
                  {data.warnings.map((check) => (
                    <a className="action-item" href={check.href} key={check.code}>
                      <span className="severity-dot warning" />
                      <div>
                        <small>{check.code}</small>
                        <strong>{check.title}</strong>
                        <span>{check.detail}</span>
                      </div>
                      <b>Открыть →</b>
                    </a>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">All checks</p>
                  <h2>Матрица готовности</h2>
                </div>
              </div>

              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Проверка</th>
                      <th>Статус</th>
                      <th>Тип</th>
                      <th>Деталь</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.checks.map((check) => (
                      <tr key={check.code}>
                        <td>
                          <strong>{check.title}</strong>
                          <small>{check.code}</small>
                        </td>
                        <td>
                          <span className="status-pill">
                            {check.ok ? "PASS" : "FAIL"}
                          </span>
                        </td>
                        <td>{check.blocking ? "BLOCKER" : "WARNING"}</td>
                        <td>{check.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {data.stage === "HYPERCARE" ? (
              <div className="quality-banner">
                <strong>Tenant в HYPERCARE</strong>
                <span>
                  После стабильной работы повторите проверки и завершите hypercare.
                </span>
                <button
                  type="button"
                  disabled={busy||loading||!data.ready}
                  onClick={() => requestDecision("LIVE")}
                >
                  Перевести в LIVE
                </button>
              </div>
            ) : null}

            <section className="section-block">
              <div className="section-heading">
                <div>
                  <p className="muted">Immutable history</p>
                  <h2>История решений</h2>
                </div>
              </div>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Дата</th>
                      <th>Решение</th>
                      <th>Комментарий</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.history.map((row) => (
                      <tr key={row.id}>
                        <td>
                          {new Date(row.reviewed_at).toLocaleString("ru-RU")}
                        </td>
                        <td>
                          <span className="status-pill">{row.decision}</span>
                        </td>
                        <td>{row.note ?? "—"}</td>
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
