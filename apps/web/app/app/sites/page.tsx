"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AppSidebar } from "../../../components/app-sidebar";
import { apiRequest } from "../../../lib/api";

type Site = {
  id: string;
  name: string;
  code: string;
  public_slug: string;
  status: string;
  pages: number;
};

type Page = {
  id: string;
  name: string;
  slug: string;
  page_type: string;
  published_version_id: string | null;
  latest_version_no: number;
  drafts: number;
};

type Block = {
  id?: string;
  block_type: string;
  sort_order?: number;
  config: Record<string, unknown>;
};

type Editor = {
  page: Page & {
    site_id: string;
    site_name: string;
    public_slug: string;
  };
  version: {
    id: string;
    version_no: number;
    status: string;
    title: string;
    meta_description: string | null;
  };
  blocks: Block[];
};

const TYPES = [
  "HERO",
  "TEXT",
  "FEATURES",
  "CTA",
  "IMAGE",
  "FORM",
  "BOOKING",
  "CATALOG",
  "PRODUCT_GRID",
  "SPACER"
];

const LABELS: Record<string,string> = {
  HERO: "Обложка",
  TEXT: "Текст",
  FEATURES: "Преимущества",
  CTA: "Призыв к действию",
  IMAGE: "Изображение",
  FORM: "Форма заявки",
  BOOKING: "Онлайн-запись",
  CATALOG: "Каталог",
  PRODUCT_GRID: "Товары",
  SPACER: "Отступ"
};

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState("");
  const [pages, setPages] = useState<Page[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [title, setTitle] = useState("");
  const [meta, setMeta] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const loadSites = useCallback(async () => {
    try {
      const rows = await apiRequest<Site[]>("/sites");
      setSites(rows);
      if (!siteId && rows[0]) setSiteId(rows[0].id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить сайты");
    }
  }, [siteId]);

  useEffect(() => {
    void loadSites();
  }, [loadSites]);

  const loadPages = useCallback(async (id: string) => {
    if (!id) {
      setPages([]);
      return;
    }
    try {
      setPages(await apiRequest<Page[]>("/sites/" + id + "/pages"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить страницы");
    }
  }, []);

  useEffect(() => {
    void loadPages(siteId);
  }, [siteId, loadPages]);

  async function createSite() {
    const name = window.prompt("Название сайта", "Основной сайт");
    if (!name?.trim()) return;

    const suggested = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const publicSlug = window.prompt(
      "Публичный адрес латиницей. Можно оставить пустым — система создаст автоматически.",
      suggested
    );

    try {
      const created = await apiRequest<{
        id: string;
        pageId: string;
      }>("/sites", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          publicSlug: publicSlug?.trim() || undefined
        })
      });
      await loadSites();
      setSiteId(created.id);
      await loadPages(created.id);
      await openPage(created.pageId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать сайт");
    }
  }

  async function enableStore() {
    if (!siteId) return;
    try {
      await apiRequest("/storefront/site/" + siteId + "/config", {
        method: "PUT",
        body: JSON.stringify({
          enabled: true,
          currency: "RUB"
        })
      });
      window.alert("Интернет-магазин включён. Добавьте блок «Товары» или «Каталог» и опубликуйте страницу.");
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось включить интернет-магазин"
      );
    }
  }

  async function createPage() {
    if (!siteId) return;
    const name = window.prompt("Название страницы", "О компании");
    if (!name?.trim()) return;

    const slug = window.prompt(
      "Адрес страницы",
      name
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/giu, "-")
        .replace(/^-|-$/g, "")
    );
    if (slug === null) return;

    try {
      const created = await apiRequest<{ id: string }>(
        "/sites/" + siteId + "/pages",
        {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(),
            slug: slug.trim(),
            pageType: "CONTENT"
          })
        }
      );
      await loadPages(siteId);
      await openPage(created.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать страницу");
    }
  }

  async function openPage(pageId: string) {
    setBusy("open");
    try {
      let data = await apiRequest<Editor>("/sites/pages/" + pageId + "/editor");
      if (data.version.status !== "DRAFT") {
        const draft = await apiRequest<{ versionId: string }>(
          "/sites/pages/" + pageId + "/draft",
          { method: "POST" }
        );
        data = await apiRequest<Editor>(
          "/sites/pages/" + pageId + "/editor?versionId=" + draft.versionId
        );
      }
      setEditor(data);
      setBlocks(data.blocks.map((block) => ({
        ...block,
        config: { ...block.config }
      })));
      setTitle(data.version.title);
      setMeta(data.version.meta_description ?? "");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось открыть редактор");
    } finally {
      setBusy("");
    }
  }

  function addBlock() {
    const type = (
      window.prompt(
        "Выберите блок: " +
          TYPES.map((type) => LABELS[type] + " (" + type + ")").join(", "),
        "TEXT"
      ) ?? ""
    ).toUpperCase();

    if (!TYPES.includes(type)) return;

    const defaults: Record<string,Record<string,unknown>> = {
      HERO: {
        heading: "Заголовок",
        text: "Коротко объясните ценность предложения.",
        buttonLabel: "Подробнее",
        buttonHref: "#"
      },
      TEXT: {
        heading: "Заголовок",
        text: "Текст блока"
      },
      FEATURES: {
        heading: "Преимущества",
        items: [
          { title: "Преимущество 1", text: "Описание" },
          { title: "Преимущество 2", text: "Описание" },
          { title: "Преимущество 3", text: "Описание" }
        ]
      },
      CTA: {
        heading: "Готовы начать?",
        text: "Оставьте заявку.",
        buttonLabel: "Связаться",
        buttonHref: "#"
      },
      IMAGE: {
        src: "https://",
        alt: "Изображение",
        caption: ""
      },
      FORM: { heading: "Оставить заявку", bindingId: "", limit: 12 },
      BOOKING: { heading: "Записаться", bindingId: "", limit: 12 },
      CATALOG: { heading: "Каталог", bindingId: "", limit: 12 },
      PRODUCT_GRID: { heading: "Товары", bindingId: "", limit: 12 },
      SPACER: { size: 32 }
    };

    setBlocks((current) => [
      ...current,
      { block_type: type, config: defaults[type] ?? {} }
    ]);
  }

  function updateBlock(index: number, config: Record<string,unknown>) {
    setBlocks((current) =>
      current.map((block, position) =>
        position === index ? { ...block, config } : block
      )
    );
  }

  function move(index: number, delta: number) {
    setBlocks((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const a = next[index]!;
      next[index] = next[target]!;
      next[target] = a;
      return next;
    });
  }

  async function save() {
    if (!editor) return;
    setBusy("save");
    try {
      await Promise.all([
        apiRequest(
          "/sites/pages/" +
            editor.page.id +
            "/versions/" +
            editor.version.id +
            "/meta",
          {
            method: "PUT",
            body: JSON.stringify({
              title,
              metaDescription: meta
            })
          }
        ),
        apiRequest(
          "/sites/pages/" +
            editor.page.id +
            "/versions/" +
            editor.version.id +
            "/blocks",
          {
            method: "PUT",
            body: JSON.stringify({
              blocks: blocks.map((block) => ({
                type: block.block_type,
                config: block.config
              }))
            })
          }
        )
      ]);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить");
      throw cause;
    } finally {
      setBusy("");
    }
  }

  async function publish() {
    if (!editor) return;
    setBusy("publish");
    try {
      await save();
      const result = await apiRequest<{ publicUrl: string }>(
        "/sites/pages/" +
          editor.page.id +
          "/versions/" +
          editor.version.id +
          "/publish",
        { method: "POST" }
      );
      await loadPages(siteId);
      window.open(result.publicUrl, "_blank", "noopener,noreferrer");
      await openPage(editor.page.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось опубликовать");
    } finally {
      setBusy("");
    }
  }

  const selectedSite = useMemo(
    () => sites.find((site) => site.id === siteId) ?? null,
    [sites, siteId]
  );

  return (
    <main className="app-shell">
      <AppSidebar active="sites" />

      <section className="workspace">
        <header className="workspace-header">
          <div>
            <p className="muted">Сайт / Конструктор</p>
            <h1>Сайты</h1>
            <p className="workspace-summary">
              Соберите страницу из понятных блоков. Никакого кода и произвольного JavaScript.
            </p>
          </div>

          <div className="header-actions">
            <button className="secondary-button" onClick={() => void createSite()}>
              + Сайт
            </button>
            <button onClick={() => void createPage()} disabled={!siteId}>
              + Страница
            </button>
          </div>
        </header>

        {error ? (
          <div className="inline-error">
            <strong>Конструктор</strong>
            <span>{error}</span>
          </div>
        ) : null}

        <div className="site-builder-layout">
          <aside className="site-list">
            <strong>Сайты</strong>
            {sites.map((site) => (
              <button
                key={site.id}
                className={siteId === site.id ? "active" : ""}
                onClick={() => {
                  setSiteId(site.id);
                  setEditor(null);
                }}
              >
                {site.name}
                <small>{site.pages} стр. · /s/{site.public_slug}</small>
              </button>
            ))}

            <strong>Страницы</strong>
            {pages.map((page) => (
              <button
                key={page.id}
                onClick={() => void openPage(page.id)}
              >
                {page.name}
                <small>
                  {page.slug} · v{page.latest_version_no}
                  {page.published_version_id ? " · опубликовано" : ""}
                </small>
              </button>
            ))}

            {selectedSite ? (
              <>
                <button
                  className="site-store-enable"
                  onClick={() => void enableStore()}
                  type="button"
                >
                  Включить интернет-магазин
                  <small>Каталог, корзина и checkout</small>
                </button>
                <a
                  className="site-public-link"
                href={"/s/" + selectedSite.public_slug}
                target="_blank"
                rel="noreferrer"
              >
                Открыть сайт ↗
                </a>
              </>
            ) : null}
          </aside>

          <section className="site-editor">
            {editor ? (
              <>
                <div className="site-editor-header">
                  <div>
                    <small>
                      DRAFT · v{editor.version.version_no}
                    </small>
                    <h2>{editor.page.name}</h2>
                  </div>

                  <div className="builder-actions">
                    <button className="secondary-button" onClick={addBlock}>
                      + Блок
                    </button>
                    <button
                      className="secondary-button"
                      onClick={() => void save()}
                      disabled={busy !== ""}
                    >
                      {busy === "save" ? "Сохраняем…" : "Сохранить"}
                    </button>
                    <button
                      onClick={() => void publish()}
                      disabled={busy !== ""}
                    >
                      {busy === "publish" ? "Публикуем…" : "Опубликовать"}
                    </button>
                  </div>
                </div>

                <div className="site-meta-grid">
                  <label>
                    <span>SEO title</span>
                    <input
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Meta description</span>
                    <textarea
                      value={meta}
                      onChange={(event) => setMeta(event.target.value)}
                    />
                  </label>
                </div>

                <div className="block-editor-list">
                  {blocks.map((block, index) => (
                    <article className="block-editor" key={index}>
                      <header>
                        <div>
                          <small>Блок {index + 1}</small>
                          <strong>{LABELS[block.block_type] ?? block.block_type}</strong>
                        </div>
                        <div className="builder-actions">
                          <button
                            className="secondary-button"
                            disabled={index === 0}
                            onClick={() => move(index, -1)}
                          >
                            ↑
                          </button>
                          <button
                            className="secondary-button"
                            disabled={index === blocks.length - 1}
                            onClick={() => move(index, 1)}
                          >
                            ↓
                          </button>
                          <button
                            className="secondary-button"
                            onClick={() =>
                              setBlocks((current) =>
                                current.filter((_, position) => position !== index)
                              )
                            }
                          >
                            Удалить
                          </button>
                        </div>
                      </header>

                      <BlockFields
                        block={block}
                        onChange={(config) => updateBlock(index, config)}
                      />
                    </article>
                  ))}

                  {!blocks.length ? (
                    <div className="table-empty">
                      <strong>Страница пустая</strong>
                      <span>Добавьте первый блок.</span>
                    </div>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="table-empty">
                <strong>{busy === "open" ? "Открываем…" : "Выберите страницу"}</strong>
                <span>Редактирование всегда идёт в DRAFT.</span>
              </div>
            )}
          </section>

          <aside className="site-preview">
            <div className="preview-browser-bar">
              <span />
              <span />
              <span />
              <b>Предпросмотр</b>
            </div>
            {blocks.length ? (
              blocks.map((block, index) => (
                <Preview key={index} block={block} />
              ))
            ) : (
              <div className="preview-placeholder">
                Здесь будет выглядеть страница.
              </div>
            )}
          </aside>
        </div>
      </section>
    </main>
  );
}

function BlockFields({
  block,
  onChange
}: {
  block: Block;
  onChange: (config: Record<string,unknown>) => void;
}) {
  const c = block.config as Record<string, any>;
  const set = (key: string, value: unknown) =>
    onChange({ ...c, [key]: value });

  if (block.block_type === "HERO") {
    return (
      <div className="builder-field-grid">
        <Field label="Заголовок" value={c.heading ?? ""} onChange={(v) => set("heading", v)} />
        <Field label="Подзаголовок" value={c.text ?? ""} multiline onChange={(v) => set("text", v)} />
        <Field label="Текст кнопки" value={c.buttonLabel ?? ""} onChange={(v) => set("buttonLabel", v)} />
        <Field label="Ссылка кнопки" value={c.buttonHref ?? ""} onChange={(v) => set("buttonHref", v)} />
        <Field label="URL изображения" value={c.imageUrl ?? ""} onChange={(v) => set("imageUrl", v)} />
      </div>
    );
  }

  if (block.block_type === "TEXT") {
    return (
      <div className="builder-field-grid">
        <Field label="Заголовок" value={c.heading ?? ""} onChange={(v) => set("heading", v)} />
        <Field label="Текст" value={c.text ?? ""} multiline onChange={(v) => set("text", v)} />
      </div>
    );
  }

  if (block.block_type === "CTA") {
    return (
      <div className="builder-field-grid">
        <Field label="Заголовок" value={c.heading ?? ""} onChange={(v) => set("heading", v)} />
        <Field label="Текст" value={c.text ?? ""} multiline onChange={(v) => set("text", v)} />
        <Field label="Кнопка" value={c.buttonLabel ?? ""} onChange={(v) => set("buttonLabel", v)} />
        <Field label="Ссылка" value={c.buttonHref ?? ""} onChange={(v) => set("buttonHref", v)} />
      </div>
    );
  }

  if (block.block_type === "IMAGE") {
    return (
      <div className="builder-field-grid">
        <Field label="URL изображения" value={c.src ?? ""} onChange={(v) => set("src", v)} />
        <Field label="Описание изображения" value={c.alt ?? ""} onChange={(v) => set("alt", v)} />
        <Field label="Подпись" value={c.caption ?? ""} onChange={(v) => set("caption", v)} />
      </div>
    );
  }

  if (block.block_type === "FEATURES") {
    const rows = Array.isArray(c.items) ? c.items : [];
    const text = rows
      .map((item: any) => (item.title ?? "") + " | " + (item.text ?? ""))
      .join("\n");

    return (
      <div className="builder-field-grid">
        <Field label="Заголовок" value={c.heading ?? ""} onChange={(v) => set("heading", v)} />
        <Field
          label="Преимущества — одна строка: Заголовок | Описание"
          value={text}
          multiline
          onChange={(value) =>
            set(
              "items",
              value
                .split("\n")
                .map((row) => row.trim())
                .filter(Boolean)
                .map((row) => {
                  const [title, ...rest] = row.split("|");
                  return {
                    title: title?.trim() ?? "",
                    text: rest.join("|").trim()
                  };
                })
            )
          }
        />
      </div>
    );
  }

  if (block.block_type === "SPACER") {
    return (
      <label className="builder-range">
        <span>Высота отступа: {Number(c.size ?? 32)} px</span>
        <input
          type="range"
          min="8"
          max="160"
          value={Number(c.size ?? 32)}
          onChange={(event) => set("size", Number(event.target.value))}
        />
      </label>
    );
  }

  return (
    <div className="builder-field-grid">
      <Field label="Заголовок" value={c.heading ?? ""} onChange={(v) => set("heading", v)} />
      <Field
        label="Связка"
        value={c.bindingId ?? ""}
        onChange={(v) => set("bindingId", v)}
      />
      <Field
        label="Лимит элементов"
        value={String(c.limit ?? 12)}
        onChange={(v) => set("limit", Number(v) || 12)}
      />
      <p className="builder-hint">
        Этот динамический блок будет подключён к данным ERP на следующем спринте.
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  multiline,
  onChange
}: {
  label: string;
  value: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="builder-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}

function Preview({ block }: { block: Block }) {
  const c = block.config as any;

  if (block.block_type === "HERO") {
    return (
      <section className="preview-block preview-hero">
        <h2>{c.heading}</h2>
        <p>{c.text}</p>
        {c.buttonLabel ? <span className="preview-button">{c.buttonLabel}</span> : null}
      </section>
    );
  }

  if (block.block_type === "TEXT") {
    return (
      <section className="preview-block">
        {c.heading ? <h3>{c.heading}</h3> : null}
        <p>{c.text}</p>
      </section>
    );
  }

  if (block.block_type === "IMAGE") {
    return (
      <section className="preview-block">
        {c.src && c.src !== "https://" ? (
          <img className="preview-image" src={c.src} alt={c.alt ?? ""} />
        ) : (
          <div className="preview-image-placeholder">Изображение</div>
        )}
        {c.caption ? <small>{c.caption}</small> : null}
      </section>
    );
  }

  if (block.block_type === "FEATURES") {
    return (
      <section className="preview-block">
        <h3>{c.heading}</h3>
        <div className="preview-features">
          {(c.items ?? []).map((item: any, index: number) => (
            <article key={index}>
              <strong>{item.title}</strong>
              <p>{item.text}</p>
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (block.block_type === "CTA") {
    return (
      <section className="preview-block preview-cta">
        <h3>{c.heading}</h3>
        <p>{c.text}</p>
        {c.buttonLabel ? <span className="preview-button">{c.buttonLabel}</span> : null}
      </section>
    );
  }

  if (block.block_type === "SPACER") {
    return <div style={{ height: Number(c.size ?? 32) }} />;
  }

  return (
    <section className="preview-block">
      <div className="preview-placeholder">
        {LABELS[block.block_type] ?? block.block_type}
      </div>
    </section>
  );
}
