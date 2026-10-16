"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiRequest } from "../../lib/api";

export default function ResetPasswordPage() {
  const [token,setToken]=useState("");
  const [password,setPassword]=useState("");
  const [pending,setPending]=useState(false);
  const [changed,setChanged]=useState(false);
  const [error,setError]=useState("");

  useEffect(()=>{
    const url=new URL(window.location.href);
    const value=url.searchParams.get("token")??"";
    setToken(value);
    // Keep recovery secrets out of browser history, subsequent URL copies,
    // referrer URLs and accidental screen captures.
    url.searchParams.delete("token");
    window.history.replaceState(null,"",url.pathname+url.search+url.hash);
  },[]);

  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      await apiRequest("/auth/password-reset/complete",{
        method:"POST",body:JSON.stringify({token,password})
      });
      setChanged(true);
      setToken("");
      setPassword("");
    } catch(cause) {
      setError(cause instanceof Error?cause.message:"Не удалось изменить пароль");
    } finally {
      setPending(false);
    }
  }

  return <main className="auth-page"><section className="auth-card">
    <a className="brand" href="/">CoreBiz</a>
    <h1>Новый пароль</h1>
    {changed?<p>Пароль изменён. Все прежние сеансы завершены.
      <a href="/login"> Войти с новым паролем</a>.</p>:
      <form className="auth-form" onSubmit={submit}>
        <label>Пароль (не менее 10 символов)
          <input type="password" minLength={10} maxLength={200}
            required autoComplete="new-password"
            value={password} onChange={e=>setPassword(e.target.value)}/>
        </label>
        {error?<p className="form-error" role="alert">{error}</p>:null}
        <button type="submit" disabled={!token||pending}>
          {pending?"Сохранение…":"Сменить пароль"}</button>
        {!token?<p>Ссылка не найдена. <a href="/forgot-password">
          Запросить новую</a>.</p>:null}
      </form>}
  </section></main>;
}
