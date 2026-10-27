"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { AppSidebar } from "../../../../components/app-sidebar";
import { apiRequest } from "../../../../lib/api";

type MfaStatus = {
  required:boolean;
  enabled:boolean;
  verified:boolean;
  recoveryCodesRemaining:number;
};

type MfaSetup = {
  secret:string;
  otpauthUri:string;
};

type Session = {
  id: string;
  current: boolean;
  active: boolean;
  membershipId: string | null;
  expiresAt: string;
  revokedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  userAgent: string | null;
};

type AuditRow = {
  id: string;
  email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  before_data: unknown;
  after_data: unknown;
  reason: string | null;
  trace_id: string | null;
  created_at: string;
};

export default function SecurityCenterPage() {
  const router=useRouter();
  const [mfa,setMfa]=useState<MfaStatus|null>(null);
  const [mfaSetup,setMfaSetup]=useState<MfaSetup|null>(null);
  const [mfaCode,setMfaCode]=useState("");
  const [recoveryCodes,setRecoveryCodes]=useState<string[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [action, setAction] = useState("");
  const [resourceType, setResourceType] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const loadMfa = useCallback(async () => {
    try {
      setMfa(await apiRequest<MfaStatus>("/auth/mfa/status"));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось проверить двухфакторную защиту"
      );
    }
  }, []);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await apiRequest<Session[]>("/security-center/sessions"));
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить сессии"
      );
    }
  }, []);

  const loadAudit = useCallback(async () => {
    try {
      const query = new URLSearchParams();
      if (action.trim()) query.set("action", action.trim());
      if (resourceType.trim()) query.set("resourceType", resourceType.trim());
      query.set("limit", "200");

      setAudit(
        await apiRequest<AuditRow[]>(
          "/security-center/audit?" + query.toString()
        )
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось загрузить журнал действий"
      );
    }
  }, [action, resourceType]);

  useEffect(() => {
    void loadMfa();
  }, [loadMfa]);

  useEffect(() => {
    if (!mfa?.verified) return;
    void loadSessions();
    void loadAudit();
  }, [loadSessions, loadAudit, mfa?.verified]);

  async function beginMfa() {
    setBusy("mfa-begin");
    setError("");
    setRecoveryCodes([]);
    try {
      setMfaSetup(await apiRequest<MfaSetup>("/auth/mfa/begin", {
        method:"POST"
      }));
    } catch (cause) {
      setError(cause instanceof Error?cause.message:"Не удалось начать настройку MFA");
    } finally {
      setBusy("");
    }
  }

  async function confirmMfa() {
    if(!mfaSetup||!/^\d{6}$/.test(mfaCode.trim())) {
      setError("Введите шестизначный код из приложения-аутентификатора");
      return;
    }
    setBusy("mfa-confirm");
    setError("");
    try {
      const result=await apiRequest<{recoveryCodes:string[]}>(
        "/auth/mfa/confirm",
        {method:"POST",body:JSON.stringify({code:mfaCode.trim()})}
      );
      setRecoveryCodes(result.recoveryCodes);
      setMfaSetup(null);
      setMfaCode("");
      await loadMfa();
    } catch (cause) {
      setError(cause instanceof Error?cause.message:"Не удалось включить MFA");
    } finally {
      setBusy("");
    }
  }

  async function verifyMfaSession() {
    if(!mfaCode.trim())return;
    setBusy("mfa-verify");
    setError("");
    try {
      await apiRequest("/auth/mfa/verify-session", {
        method:"POST",body:JSON.stringify({code:mfaCode.trim()})
      });
      setMfaCode("");
      await loadMfa();
    } catch (cause) {
      setError(cause instanceof Error?cause.message:"Код не подтверждён");
    } finally {
      setBusy("");
    }
  }

  async function rotateRecoveryCodes() {
    if(!/^\d{6}$/.test(mfaCode.trim())) {
      setError("Для перевыпуска введите текущий шестизначный код");
      return;
    }
    setBusy("mfa-rotate");
    setError("");
    try {
      const result=await apiRequest<{recoveryCodes:string[]}>(
        "/auth/mfa/recovery/rotate",
        {method:"POST",body:JSON.stringify({code:mfaCode.trim()})}
      );
      setRecoveryCodes(result.recoveryCodes);
      setMfaCode("");
      await loadMfa();
    } catch (cause) {
      setError(cause instanceof Error?cause.message:"Не удалось перевыпустить коды");
    } finally {
      setBusy("");
    }
  }

  async function disableMfa() {
    if(!mfa||mfa.required)return;
    if(!mfaCode.trim()){
      setError("Подтвердите отключение кодом MFA");
      return;
    }
    if(!window.confirm("Отключить двухфакторную защиту и завершить остальные сессии?"))
      return;
    setBusy("mfa-disable");
    setError("");
    try {
      await apiRequest("/auth/mfa/disable", {
        method:"POST",body:JSON.stringify({code:mfaCode.trim()})
      });
      setMfaCode("");
      setRecoveryCodes([]);
      await loadMfa();
    } catch (cause) {
      setError(cause instanceof Error?cause.message:"Не удалось отключить MFA");
    } finally {
      setBusy("");
    }
  }

  async function continueAfterMfa() {
    const vertical=window.sessionStorage.getItem("corebiz.pending_vertical");
    if(vertical){
      try{
        await apiRequest("/customization/business-vertical",{
          method:"PUT",body:JSON.stringify({verticalCode:vertical})
        });
        window.dispatchEvent(new Event("corebiz-capabilities-changed"));
      }catch{
        // First-day setup can safely resume the same vertical selection.
      }finally{
        window.sessionStorage.removeItem("corebiz.pending_vertical");
      }
    }
    router.push(vertical
      ?"/app/start?vertical="+encodeURIComponent(vertical)
      :"/app/start");
    router.refresh();
  }

  async function revoke(session: Session) {
    const text = session.current
      ? "Отозвать текущую сессию? После следующего запроса потребуется войти снова."
      : "Отозвать эту сессию?";
    if (!window.confirm(text)) return;

    setBusy(session.id);
    try {
      await apiRequest(
        "/security-center/sessions/" + session.id + "/revoke",
        { method: "POST" }
      );
      await loadSessions();
      if (session.current) window.location.href = "/login";
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось отозвать сессию"
      );
    } finally {
      setBusy("");
    }
  }

  async function revokeOthers() {
    if (!window.confirm("Завершить все остальные активные сессии?")) return;

    setBusy("others");
    try {
      const result = await apiRequest<{ revoked: number }>(
        "/security-center/sessions/revoke-others",
        { method: "POST" }
      );
      window.alert("Завершено сессий: " + result.revoked);
      await loadSessions();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось завершить сессии"
      );
    } finally {
      setBusy("");
    }
  }

  const activeCount = useMemo(
    () => sessions.filter((session) => session.active).length,
    [sessions]
  );

  function device(userAgent: string | null): string {
    if (!userAgent) return "Неизвестное устройство";
    const browser =
      userAgent.includes("Chrome")
        ? "Chrome"
        : userAgent.includes("Firefox")
          ? "Firefox"
          : userAgent.includes("Safari")
            ? "Safari"
            : "Браузер";
    const os =
      userAgent.includes("Windows")
        ? "Windows"
        : userAgent.includes("Mac OS")
          ? "macOS"
          : userAgent.includes("Android")
            ? "Android"
            : userAgent.includes("iPhone") || userAgent.includes("iPad")
              ? "iOS"
              : "";
    return [browser, os].filter(Boolean).join(" · ");
  }

  return (
    <main className="app-shell">
      <AppSidebar active="security-center" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Настройки / Безопасность</p>
            <h1>Безопасность и аудит</h1>
            <p className="workspace-summary">
              Активные входы и журнал действий внутри текущей компании.
            </p>
          </div>

          <button
            className="secondary-button"
            disabled={Boolean(busy) || activeCount <= 1}
            onClick={() => void revokeOthers()}
            type="button"
          >
            Завершить остальные сессии
          </button>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Security Center</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">
                {mfa?.required
                  ?"Обязательна для вашей роли"
                  :"Дополнительная защита аккаунта"}
              </p>
              <h2>Двухфакторная защита</h2>
            </div>
            {mfa ? (
              <span className="status-pill">
                {mfa.enabled
                  ?(mfa.verified?"ACTIVE":"REQUIRES CODE")
                  :"NOT ENABLED"}
              </span>
            ) : null}
          </div>

          {!mfa ? <p>Проверяем состояние MFA…</p> : null}

          {mfa&&!mfa.enabled ? (
            <div className="settings-card">
              <p>
                Для входа будет нужен одноразовый код из любого TOTP-аутентификатора.
                Секрет хранится в CoreBiz только в зашифрованном виде.
              </p>
              {!mfaSetup ? (
                <button type="button" disabled={Boolean(busy)}
                  onClick={()=>void beginMfa()}>
                  Настроить двухфакторную защиту
                </button>
              ) : (
                <>
                  <p>
                    Откройте ссылку на устройстве с аутентификатором или добавьте
                    секрет вручную.
                  </p>
                  <p>
                    <a className="secondary-button" href={mfaSetup.otpauthUri}>
                      Открыть в аутентификаторе
                    </a>
                  </p>
                  <p><strong>Секрет:</strong> <code>{mfaSetup.secret}</code></p>
                  <label>
                    Код из приложения
                    <input inputMode="numeric" autoComplete="one-time-code"
                      value={mfaCode}
                      onChange={event=>setMfaCode(event.target.value)}
                      placeholder="123456"/>
                  </label>
                  <button type="button" disabled={busy==="mfa-confirm"}
                    onClick={()=>void confirmMfa()}>
                    Подтвердить и включить
                  </button>
                </>
              )}
            </div>
          ) : null}

          {mfa?.enabled&&!mfa.verified ? (
            <div className="settings-card">
              <h3>Подтвердите текущую сессию</h3>
              <p>
                Введите шестизначный код или один резервный код. До подтверждения
                бизнес-данные и административные операции закрыты.
              </p>
              <input autoComplete="one-time-code" value={mfaCode}
                onChange={event=>setMfaCode(event.target.value)}
                placeholder="Код MFA"/>
              <button type="button" disabled={busy==="mfa-verify"}
                onClick={()=>void verifyMfaSession()}>Подтвердить сессию</button>
            </div>
          ) : null}

          {recoveryCodes.length ? (
            <div className="settings-card success-banner">
              <h3>Сохраните резервные коды сейчас</h3>
              <p>
                Каждый код работает один раз. После закрытия этой страницы CoreBiz
                не сможет показать их снова.
              </p>
              <pre className="audit-json">{recoveryCodes.join("\n")}</pre>
              <button type="button" onClick={()=>void continueAfterMfa()}>
                Я сохранил коды · продолжить
              </button>
            </div>
          ) : null}

          {mfa?.enabled&&mfa.verified&&!recoveryCodes.length ? (
            <div className="settings-card">
              <p>
                Резервных кодов осталось: <strong>{mfa.recoveryCodesRemaining}</strong>.
                Для перевыпуска или отключения введите текущий код приложения.
              </p>
              <input inputMode="numeric" autoComplete="one-time-code"
                value={mfaCode}
                onChange={event=>setMfaCode(event.target.value)}
                placeholder="123456"/>
              <div className="header-actions">
                <button className="secondary-button" type="button"
                  disabled={Boolean(busy)}
                  onClick={()=>void rotateRecoveryCodes()}>
                  Перевыпустить резервные коды
                </button>
                {!mfa.required ? (
                  <button className="secondary-button" type="button"
                    disabled={Boolean(busy)}
                    onClick={()=>void disableMfa()}>
                    Отключить MFA
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        {mfa?.verified ? <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">{activeCount} активных</p>
              <h2>Сессии</h2>
            </div>
          </div>

          <div className="settings-grid">
            {sessions.map((session) => (
              <article className="settings-card" key={session.id}>
                <div className="growth-site-heading">
                  <div>
                    <span className="status-pill">
                      {session.active ? "ACTIVE" : "CLOSED"}
                    </span>
                    <h3>{device(session.userAgent)}</h3>
                  </div>
                  {session.current ? <b>Текущая</b> : null}
                </div>

                <dl className="growth-site-meta">
                  <div>
                    <dt>Последняя активность</dt>
                    <dd>
                      {session.lastSeenAt
                        ? new Date(session.lastSeenAt).toLocaleString("ru-RU")
                        : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>Создана</dt>
                    <dd>{new Date(session.createdAt).toLocaleString("ru-RU")}</dd>
                  </div>
                  <div>
                    <dt>Истекает</dt>
                    <dd>{new Date(session.expiresAt).toLocaleString("ru-RU")}</dd>
                  </div>
                </dl>

                {session.active ? (
                  <button
                    className="secondary-button"
                    disabled={busy === session.id}
                    onClick={() => void revoke(session)}
                    type="button"
                  >
                    Завершить сессию
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </section> : null}

        {mfa?.verified ? <section className="section-block">
          <div className="section-heading">
            <div>
              <p className="muted">До 200 последних событий</p>
              <h2>Журнал действий</h2>
            </div>

            <div className="header-actions">
              <input
                placeholder="Действие, например auth.login"
                value={action}
                onChange={(event) => setAction(event.target.value)}
              />
              <input
                placeholder="Тип объекта"
                value={resourceType}
                onChange={(event) => setResourceType(event.target.value)}
              />
              <button
                className="secondary-button"
                onClick={() => void loadAudit()}
                type="button"
              >
                Найти
              </button>
            </div>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Кто</th>
                  <th>Действие</th>
                  <th>Объект</th>
                  <th>Причина / trace</th>
                  <th>Изменения</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.created_at).toLocaleString("ru-RU")}</td>
                    <td>{row.email ?? "Система"}</td>
                    <td><code>{row.action}</code></td>
                    <td>
                      <strong>{row.resource_type}</strong>
                      <small>{row.resource_id ?? "—"}</small>
                    </td>
                    <td>
                      {row.reason ?? "—"}
                      {row.trace_id ? <small>{row.trace_id}</small> : null}
                    </td>
                    <td>
                      <details>
                        <summary>Открыть</summary>
                        <pre className="audit-json">
                          {JSON.stringify(
                            {
                              before: row.before_data,
                              after: row.after_data
                            },
                            null,
                            2
                          )}
                        </pre>
                      </details>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section> : null}
      </section>
    </main>
  );
}
