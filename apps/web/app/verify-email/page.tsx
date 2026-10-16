"use client";

import { useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";

export default function VerifyEmailPage() {
  const [state, setState] = useState<"checking"|"verified"|"invalid">("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    const url = new URL(window.location.href);
    const token = url.searchParams.get("token") ?? "";
    url.searchParams.delete("token");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (!token) {
      setState("invalid");
      setError("Ссылка подтверждения не найдена.");
      return;
    }
    void apiRequest<{verified:true}>("/auth/email-verification/complete", {
      method: "POST",
      body: JSON.stringify({token})
    }).then(() => {
      if (mounted) setState("verified");
    }).catch(cause => {
      if (!mounted) return;
      setState("invalid");
      setError(cause instanceof Error ? cause.message : "Ссылка не действует");
    });
    return () => {mounted = false;};
  }, []);

  return <main className="auth-page"><section className="auth-card">
    <a className="brand" href="/">CoreBiz</a>
    <h1>Подтверждение электронной почты</h1>
    {state === "checking" ? <p>Проверяем ссылку…</p> : null}
    {state === "verified" ? <p>Адрес подтверждён. Можно продолжать
      пользоваться CoreBiz и оплачивать тариф.</p> : null}
    {state === "invalid" ? <p className="form-error" role="alert">{error}
      {" "}Получите новую ссылку в личном кабинете.</p> : null}
    <p className="auth-footer">
      <a href="/app/verify-email">В настройки почты</a>
      {" · "}<a href="/login">Войти</a>
    </p>
  </section></main>;
}
