"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../../lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setPending(true);

    try {
      await apiRequest("/auth/register", {
        method: "POST",
        body: JSON.stringify({ companyName, email, password })
      });
      router.push("/app");
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Не удалось создать аккаунт"
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-card">
        <a className="brand" href="/">BUSINESS OS</a>
        <p className="muted">Запуск компании без внедрения</p>
        <h1>Создайте рабочее пространство</h1>

        <form onSubmit={submit} className="auth-form">
          <label>
            Компания
            <input
              value={companyName}
              onChange={(event) => setCompanyName(event.target.value)}
              placeholder="ООО Альфа"
              required
            />
          </label>

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
              autoComplete="new-password"
              type="password"
              minLength={10}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? <p className="form-error">{error}</p> : null}

          <button disabled={pending} type="submit">
            {pending ? "Создаём…" : "Начать бесплатно"}
          </button>
        </form>

        <p className="auth-footer">
          Уже есть аккаунт? <a href="/login">Войти</a>
        </p>
      </section>
    </main>
  );
}
