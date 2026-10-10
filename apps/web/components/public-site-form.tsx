"use client";

import { useRef, useState } from "react";

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
  booking = false,
  danceBooking = false
}: {
  publicKey: string;
  heading?: string;
  booking?: boolean;
  danceBooking?: boolean;
}) {
  // Keep the same submission key after a network timeout: retries
  // must not create a second lead or appointment.
  const submissionKey = useRef<string | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [bookingDay, setBookingDay] = useState("");
  const [slots, setSlots] = useState<Array<{
    resourceId:string;
    resourceName:string;
    startsAt:string;
    lessonId?:string;
    groupName?:string;
    spotsLeft?:number;
    waitlist?:number;
  }>>([]);
  const [resourceId, setResourceId] = useState("");
  const [lessonId, setLessonId] = useState("");
  const [childName, setChildName] = useState("");
  const [childBirthDate, setChildBirthDate] = useState("");
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [honeypot, setHoneypot] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  async function loadSlots() {
    if(!bookingDay) return;
    const from=new Date(bookingDay+"T00:00:00");
    const to=new Date(from);
    to.setDate(to.getDate()+1);
    if(!Number.isFinite(from.getTime())) {
      setError("Некорректная дата");
      return;
    }
    setLoadingSlots(true);
    setSlots([]);
    setStartsAt("");
    setResourceId("");
    setError("");
    try {
      const query=new URLSearchParams({from:from.toISOString(),to:to.toISOString()});
      const response=await fetch(API_URL+"/site-forms/availability/"+encodeURIComponent(publicKey)+"?"+query);
      const data=await response.json() as ApiResponse<Array<{
        resourceId:string;
        resourceName:string;
        startsAt:string;
        lessonId?:string;
        groupName?:string;
        spotsLeft?:number;
        waitlist?:number;
      }>>;
      if(!response.ok || !data.ok) throw new Error(!data.ok?data.error.message:"Расписание недоступно");
      setSlots(data.data);
    } catch (cause) {
      setError(cause instanceof Error?cause.message:"Не удалось загрузить расписание");
    } finally {
      setLoadingSlots(false);
    }
  }

  async function send() {
    if (!publicKey) return;
    setBusy(true);
    setError("");

    try {
      if (!submissionKey.current) submissionKey.current = crypto.randomUUID();
      const result = await submit<{
        accepted: boolean;
        reason?: string;
      }>(publicKey, {
        idempotencyKey: submissionKey.current,
        name: name.trim(),
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        message: message.trim() || undefined,
        startsAt: booking && !danceBooking && startsAt ? startsAt : undefined,
        resourceId: booking && !danceBooking ? resourceId : undefined,
        childName: danceBooking ? childName.trim() : undefined,
        childBirthDate: danceBooking ? childBirthDate : undefined,
        lessonId: danceBooking ? lessonId : undefined,
        honeypot
      });

      if (!result.accepted) {
        throw new Error(
          result.reason === "rate_limited"
            ? "Слишком много запросов. Попробуйте немного позже."
            : "Заявка не принята."
        );
      }

      submissionKey.current = null;
      setSuccess(
        danceBooking
          ? "Ребёнок записан. Если группа заполнена, заявка поставлена в лист ожидания."
          : booking
            ? "Запись создана. Компания увидит её в расписании."
            : "Заявка отправлена. Компания увидит её в CRM."
      );
      setName("");
      setPhone("");
      setEmail("");
      setMessage("");
      setStartsAt("");
      setResourceId("");
      setLessonId("");
      setChildName("");
      setChildBirthDate("");
      setSlots([]);
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
          <span>{danceBooking ? "Родитель / плательщик *" : "Имя *"}</span>
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

        {danceBooking ? (
          <div className="public-form-two">
            <label>
              <span>Имя ребёнка *</span>
              <input
                value={childName}
                onChange={(event) => setChildName(event.target.value)}
              />
            </label>
            <label>
              <span>Дата рождения *</span>
              <input
                type="date"
                value={childBirthDate}
                onChange={(event) => setChildBirthDate(event.target.value)}
              />
            </label>
          </div>
        ) : null}

        {booking ? (
          <div>
            <label>
              <span>Дата *</span>
              <input
                type="date"
                value={bookingDay}
                onChange={(e) => {
                  setBookingDay(e.target.value);
                  setStartsAt("");
                  setResourceId("");
                  setLessonId("");
                  setSlots([]);
                }}
              />
            </label>
            <button type="button" disabled={!bookingDay||loadingSlots} onClick={() => void loadSlots()}>
              {loadingSlots ? "Ищем свободное время…" : "Показать свободное время"}
            </button>
            {slots.length ? (
              <label>
                <span>{danceBooking ? "Занятие *" : "Специалист и время *"}</span>
                <select
                  value={
                    danceBooking
                      ? lessonId
                      : startsAt + "|" + resourceId
                  }
                  onChange={(e) => {
                    if (danceBooking) {
                      const slot = slots.find(
                        (item) => item.lessonId === e.target.value
                      );
                      setLessonId(e.target.value);
                      setStartsAt(slot?.startsAt ?? "");
                      setResourceId(slot?.resourceId ?? "");
                      return;
                    }
                    const [start,resource]=e.target.value.split("|");
                    setStartsAt(start||"");
                    setResourceId(resource||"");
                  }}
                >
                  <option value={danceBooking ? "" : "|"}>Выбрать время</option>
                  {slots.map((slot) => (
                    <option
                      key={(slot.lessonId ?? slot.resourceId)+slot.startsAt}
                      value={
                        danceBooking
                          ? slot.lessonId ?? ""
                          : slot.startsAt+"|"+slot.resourceId
                      }
                    >
                      {danceBooking
                        ? (slot.groupName ?? "Группа") +
                          " · " +
                          new Date(slot.startsAt).toLocaleTimeString(
                            "ru-RU",
                            {hour:"2-digit",minute:"2-digit"}
                          ) +
                          " · " +
                          ((slot.spotsLeft ?? 0) > 0
                            ? "мест: " + slot.spotsLeft
                            : "лист ожидания")
                        : slot.resourceName +
                          " · " +
                          new Date(slot.startsAt).toLocaleTimeString(
                            "ru-RU",
                            {hour:"2-digit",minute:"2-digit"}
                          )}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
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
            (booking && !danceBooking && (!startsAt || !resourceId)) ||
            (danceBooking && (
              childName.trim().length < 2 ||
              !childBirthDate ||
              !lessonId
            ))
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
