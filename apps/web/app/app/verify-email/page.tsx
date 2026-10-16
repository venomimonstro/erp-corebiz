"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../../lib/api";

type VerificationStatus = { email: string; verified: boolean };

export default function EmailSettingsPage() {
  const [status, setStatus] = useState<VerificationStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void apiRequest<VerificationStatus>("/auth/email-verification/status")
      .then(data => {if (active) setStatus(data);})
      .catch(cause => {if (active) setError(
        cause instanceof Error ? cause.message : "Не удалось загрузить статус"
      );});
    return () => {active = false;};
  }, []);

  async function resend() {
    setPending(true);
    setNotice("");
    setError("");
    try {
      const result = await apiRequest<{sent:boolean;verified:boolean}>(
        "/auth/email-verification/request", {method:"POST"}
      );
      if (result.verified) {
        setStatus(old => old ? {...old, verified:true} : old);
        setNotice("Адрес уже подтверждён.");
      } else if (result.sent) {
        setNotice("Письмо принято почтовым сервисом. Проверьте входящие и «Спам».");
      } else {
        setNotice("Письмо уже запрошено. Проверьте почту или повторите позже.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Отправка не выполнена");
    } finally {
      setPending(false);
    }
  }

  return <main className="app-shell"><section className="workspace">
    <header className="workspace-header">
      <div>
        <p className="muted">Аккаунт / Безопасность</p>
        <h1>Подтверждение почты</h1>
      </div>
      <a href="/app/settings/billing">К тарифу</a>
    </header>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
    {status ? <section className="studio-section">
      <p><strong>{status.email}</strong></p>
      <p>{status.verified ? "Адрес подтверждён." :
        "Подтвердите адрес перед оплатой подписки. Работу в пробном тарифе можно продолжить."}</p>
      {!status.verified ? <button type="button" disabled={pending}
        onClick={() => void resend()}>
        {pending ? "Отправка…" : "Отправить письмо подтверждения"}
      </button> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section> : !error ? <p>Загрузка…</p> : null}
  </section></main>;
}
