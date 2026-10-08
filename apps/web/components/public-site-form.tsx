"use client";

import { useState } from "react";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

// A tenant custom domain must use the same-origin API proxy.
const API_URL = "/api/v1";

async function submit<T>(
  publicKey: string,
  body: Record<string, unknown>
): Promise<T> {
  const response = await fetch(
    API_URL +
      "/site-forms/submit/" +
      encodeURIComponent(publicKey),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  const payload = (await response.json()) as ApiResponse<T>;
  if (!payload.ok) throw new Error(payload.error.message);
  return payload.data;
}

export function PublicSiteForm({
  publicKey,
  heading,
  booking = false
}: {
  publicKey: string;
  heading?: string;
  booking?: boolean;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [honeypot, setHoneypot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function send() {
    if (!publicKey) return;
    setBusy(true);
    setError("");

    try {
      const result = await submit<{
        accepted: boolean;
        reason?: string;
      }>(publicKey, {
        idempotencyKey: crypto.randomUUID(),
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        message: message.trim() || undefined,
        startsAt: booking && startsAt
          ? new Date(startsAt).toISOString()
          : undefined,
        honeypot
      });

      if (!result.accepted) {
        throw new Error(
          result.reason === "rate_limited"
            ? "Слишком много запросов. Попробуйте немного позже."
            : "Заявка не принята."
        );
      }

      setSuccess(
        booking
          ? "Запись создана. Компания увидит её в расписании."
          : "Заявка отправлена. Компания увидит её в CRM."
      );
      setName("");
      setPhone("");
      setEmail("");
      setMessage("");
      setStartsAt("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось отправить форму"
      );
    } finally {
      setBusy(false);
    }
  }

  if (!publicKey) {
    return (
      <section className="public-block public-dynamic-placeholder">
        <strong>{heading || (booking ? "Онлайн-запись" : "Форма заявки")}</strong>
        <span>Форма ещё не настроена владельцем сайта.</span>
      </section>
    );
  }

  return (
    <section className="public-block public-form-block">
      <div className="public-form-copy">
        <h2>{heading || (booking ? "Записаться" : "Оставить заявку")}</h2>
        <p>
          {booking
            ? "Выберите удобное время и оставьте контакты."
            : "Оставьте контакты — заявка сразу попадёт в систему компании."}
        </p>
      </div>

      <div className="public-form-card">
        {error ? <div className="public-store-error">{error}</div> : null}
        {success ? <div className="public-store-success">{success}</div> : null}

        <label>
          <span>Имя *</span>
          <input
            autoComplete="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <div className="public-form-two">
          <label>
            <span>Телефон</span>
            <input
              autoComplete="tel"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          </label>
          <label>
            <span>Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
        </div>

        {booking ? (
          <label>
            <span>Дата и время *</span>
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(event) => setStartsAt(event.target.value)}
            />
          </label>
        ) : null}

        <label>
          <span>{booking ? "Комментарий" : "Что нужно?"}</span>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
        </label>

        <label className="public-form-honeypot" aria-hidden="true">
          <span>Company</span>
          <input
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(event) => setHoneypot(event.target.value)}
          />
        </label>

        <button
          type="button"
          className="public-primary-button"
          disabled={
            busy ||
            name.trim().length < 2 ||
            (!phone.trim() && !email.trim()) ||
            (booking && !startsAt)
          }
          onClick={() => void send()}
        >
          {busy
            ? "Отправляем…"
            : booking
              ? "Записаться"
              : "Отправить заявку"}
        </button>
      </div>
    </section>
  );
}
