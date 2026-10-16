"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);

    try {
      await apiRequest("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password })
      });
      const pendingInvite=window.sessionStorage.getItem("corebiz.pending_invite");
      // Only our known internal portal path may be used as a return target.
      // This is not an open redirect to an arbitrary site.
      const requested=new URLSearchParams(window.location.search).get("next");
      let route=pendingInvite?"/invite":(requested==="/portal/dance"||requested==="/portal/trainer")
        ?requested:"/app";
      if(!pendingInvite&&route==="/app"){
        try{
          const context=await apiRequest<{roles:string[]}>("/workspace/context");
          if(context.roles.includes("DANCE_CUSTOMER"))route="/portal/dance";
          else if(context.roles.includes("DANCE_TRAINER"))route="/portal/trainer";
        }catch{ /* Keep standard app login for accounts without workspace metadata. */ }
      }
      router.push(route);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось войти");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <a className="brand" href="/">BUSINESS OS</a>
        <p className="muted">Вход в рабочее пространство</p>
        <h1>С возвращением</h1>

        <form onSubmit={submit} className="auth-form">
          <label>
            Email
            <input
              autoComplete="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label>
            Пароль
            <input
              autoComplete="current-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <button disabled={pending} type="submit">
            {pending ? "Входим…" : "Войти"}
          </button>
        </form>

        <p className="auth-footer">
          <a href="/forgot-password">Забыли пароль?</a>
          {" · "}
          Нет аккаунта? <a href="/signup">Создать бесплатно</a>
        </p>
      </section>
    </main>
  );
}
