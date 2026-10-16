"use client";

import { FormEvent, useState } from "react";
import { apiRequest } from "../../lib/api";

export default function ForgotPasswordPage() {
  const [email,setEmail]=useState("");
  const [pending,setPending]=useState(false);
  const [sent,setSent]=useState(false);
  const [error,setError]=useState("");

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await apiRequest("/auth/password-reset/request", {
        method:"POST",body:JSON.stringify({email})
      });
      setSent(true);
    } catch(cause) {
      setError(cause instanceof Error ? cause.message : "Запрос не отправлен");
    } finally {
      setPending(false);
    }
  }

  return <main className="auth-page"><section className="auth-card">
    <a className="brand" href="/">CoreBiz</a>
    <h1>Восстановление пароля</h1>
    {sent ? <p>Если аккаунт существует, на почту отправлена ссылка.
      Проверьте входящие и папку «Спам». Ссылка действует 30 минут.</p>
      : <form className="auth-form" onSubmit={submit}>
        <label>Email
          <input required type="email" autoComplete="email" value={email}
            onChange={e=>setEmail(e.target.value)}/>
        </label>
        {error?<p className="form-error" role="alert">{error}</p>:null}
        <button type="submit" disabled={pending}>
          {pending?"Отправка…":"Отправить ссылку"}</button>
      </form>}
    <p className="auth-footer"><a href="/login">Вернуться ко входу</a></p>
  </section></main>;
}
