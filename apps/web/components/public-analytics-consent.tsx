"use client";

import { useEffect, useState } from "react";

declare global {
  interface Window {
    corebizAnalyticsConsent?: "GRANTED" | "DENIED";
    corebizTrack?: (name: string, props?: Record<string, unknown>) => void;
  }
}

// A tenant custom domain must use the same-origin API proxy.
const API_URL = "/api/v1";

export function PublicAnalyticsConsent({
  trackerKey
}: {
  trackerKey: string | null;
}) {
  const [choice, setChoice] = useState<"UNKNOWN" | "GRANTED" | "DENIED">(
    "UNKNOWN"
  );

  useEffect(() => {
    if (!trackerKey) return;

    const stored = window.localStorage.getItem(
      "corebiz_analytics_consent"
    );

    if (stored === "GRANTED") {
      setChoice("GRANTED");
      enable(trackerKey);
    } else if (stored === "DENIED") {
      window.corebizAnalyticsConsent = "DENIED";
      setChoice("DENIED");
    }
  }, [trackerKey]);

  function enable(key: string) {
    window.corebizAnalyticsConsent = "GRANTED";

    const id = "corebiz-first-party-tracker";
    if (document.getElementById(id)) return;

    const script = document.createElement("script");
    script.id = id;
    script.src =
      API_URL +
      "/tracker/script.js?key=" +
      encodeURIComponent(key);
    script.async = true;
    document.body.appendChild(script);
  }

  function accept() {
    if (!trackerKey) return;
    window.localStorage.setItem(
      "corebiz_analytics_consent",
      "GRANTED"
    );
    setChoice("GRANTED");
    enable(trackerKey);
  }

  function deny() {
    window.localStorage.setItem(
      "corebiz_analytics_consent",
      "DENIED"
    );
    window.corebizAnalyticsConsent = "DENIED";
    setChoice("DENIED");
  }

  if (!trackerKey || choice !== "UNKNOWN") return null;

  return (
    <aside
      className="public-consent"
      role="dialog"
      aria-label="Настройки аналитики"
    >
      <div>
        <strong>Аналитика сайта</strong>
        <span>
          Разрешить анонимную first-party аналитику, чтобы компания понимала,
          какие страницы и реклама приводят клиентов?
        </span>
      </div>
      <div className="public-consent-actions">
        <button
          className="public-consent-secondary"
          type="button"
          onClick={deny}
        >
          Не разрешать
        </button>
        <button type="button" onClick={accept}>
          Разрешить
        </button>
      </div>
    </aside>
  );
}
