"use client";

import {
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { apiRequest } from "../lib/api";

type SearchItem = {
  type: "PARTY" | "DEAL" | "SALES_ORDER" | "SKU" | "PURCHASE_ORDER";
  id: string;
  title: string;
  subtitle: string;
  href: string;
};

type SearchResponse = {
  query: string;
  items: SearchItem[];
  quickActions: Array<{
    key: string;
    label: string;
    href: string;
  }>;
};

type PaletteRow =
  | {
      kind: "action";
      key: string;
      title: string;
      subtitle: string;
      href: string;
    }
  | {
      kind: "result";
      key: string;
      title: string;
      subtitle: string;
      href: string;
    };

const TYPE_LABELS: Record<SearchItem["type"], string> = {
  PARTY: "Клиент",
  DEAL: "Сделка",
  SALES_ORDER: "Заказ",
  SKU: "Товар",
  PURCHASE_ORDER: "Закупка"
};

export function GlobalCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function handleKey(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setData(null);
      setLoading(false);
      setSelected(0);
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await apiRequest<SearchResponse>(
          "/search?q=" + encodeURIComponent(trimmed)
        );
        if (!cancelled) {
          setData(result);
          setSelected(0);
        }
      } catch {
        if (!cancelled) setData(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const rows = useMemo<PaletteRow[]>(() => {
    if (!data) return [];

    return [
      ...data.quickActions.map((action) => ({
        kind: "action" as const,
        key: "action:" + action.key,
        title: action.label,
        subtitle: "Быстрое действие",
        href: action.href
      })),
      ...data.items.map((item) => ({
        kind: "result" as const,
        key: item.type + ":" + item.id,
        title: item.title,
        subtitle: TYPE_LABELS[item.type] + " · " + item.subtitle,
        href: item.href
      }))
    ];
  }, [data]);

  function navigate(href: string) {
    setOpen(false);
    setQuery("");
    window.location.href = href;
  }

  function handleInputKey(event: KeyboardEvent<HTMLInputElement>) {
    if (!rows.length) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((value) => (value + 1) % rows.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((value) => (value - 1 + rows.length) % rows.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[selected];
      if (row) navigate(row.href);
    }
  }

  return (
    <>
      <button
        className="sidebar-command-trigger"
        type="button"
        onClick={() => setOpen(true)}
      >
        <span>Найти или создать</span>
        <kbd>⌘K</kbd>
      </button>

      {open ? (
        <div
          className="command-palette-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setOpen(false);
          }}
        >
          <section
            className="command-palette"
            role="dialog"
            aria-modal="true"
            aria-label="Поиск и быстрые действия"
          >
            <div className="command-search">
              <span>⌕</span>
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleInputKey}
                placeholder="Клиент, сделка, заказ, SKU…"
              />
              <kbd>Esc</kbd>
            </div>

            <div className="command-results">
              {query.trim().length < 2 ? (
                <div className="command-empty">
                  <strong>Начните вводить</strong>
                  <span>
                    Поиск работает только по данным, которые доступны вашей роли.
                  </span>
                </div>
              ) : loading ? (
                <div className="command-empty">
                  <strong>Ищем…</strong>
                </div>
              ) : rows.length ? (
                rows.map((row, index) => (
                  <button
                    key={row.key}
                    className={
                      index === selected
                        ? "command-row selected"
                        : "command-row"
                    }
                    type="button"
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => navigate(row.href)}
                  >
                    <div>
                      <strong>{row.title}</strong>
                      <span>{row.subtitle}</span>
                    </div>
                    <b>↵</b>
                  </button>
                ))
              ) : (
                <div className="command-empty">
                  <strong>Ничего не найдено</strong>
                  <span>Попробуйте название, номер заказа или SKU.</span>
                </div>
              )}
            </div>

            <footer className="command-footer">
              <span>↑↓ выбрать</span>
              <span>Enter открыть</span>
              <span>Esc закрыть</span>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
