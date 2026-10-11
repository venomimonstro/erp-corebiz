"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { apiRequest } from "../../lib/api";

export default function SignupPage() {
  const router = useRouter();
  const [companyName, setCompanyName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [verticalCode, setVerticalCode] = useState("DANCE_FITNESS");
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
      // Registration is completed before profile setup. Keep a recovery path
      // if the second request fails: never suggest the whole account failed.
      try {
        await apiRequest("/customization/business-vertical", {
          method: "PUT",
          body: JSON.stringify({ verticalCode })
        });
        window.dispatchEvent(new Event("corebiz-capabilities-changed"));
      } catch {
        router.push("/app/start?vertical=" + encodeURIComponent(verticalCode));
        router.refresh();
        return;
      }
      router.push("/app/start");
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
            Чем занимается компания?
            <select value={verticalCode}
              onChange={(event) => setVerticalCode(event.target.value)}
              aria-label="Основной вид бизнеса">
              <option value="DANCE_FITNESS">Студия танцев или фитнес</option>
              <option value="BEAUTY_SALON">Салон красоты</option>
              <option value="NAIL_SALON">Маникюрная студия</option>
              <option value="BARBERSHOP">Барбершоп</option>
              <option value="AUTO_SERVICE">Автосервис</option>
              <option value="AUTO_PARTS_DISMANTLING">Авторазбор и запчасти</option>
              <option value="ECOMMERCE_STORE">Свой интернет-магазин</option>
              <option value="MARKETPLACE_SELLER">Продавец Ozon / Wildberries</option>
              <option value="RETAIL_STORE">Розничный магазин</option>
              <option value="WHOLESALE_B2B">Оптовая торговля B2B</option>
              <option value="WAREHOUSE_3PL">Склад или 3PL</option>
              <option value="PROFESSIONAL_SERVICES">IT или профессиональные услуги</option>
              <option value="WEB_STUDIO">Веб-студия</option>
              <option value="WEB_MARKETING_AGENCY">Digital-агентство</option>
              <option value="MARKETING_AGENCY">Маркетинговое агентство</option>
              <option value="GENERAL">Другой вид бизнеса</option>
            </select>
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
