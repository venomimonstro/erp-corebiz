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

type Binding = {
  id: string;
  name: string;
  public_key: string;
  action: "CRM_LEAD" | "BOOKING";
  status: string;
};

type ServiceItem = {
  id: string;
  name: string;
  duration_minutes: number;
};

type SiteDomain = {
  id: string;
  hostname: string;
  status: "PENDING" | "VERIFIED" | "ACTIVE" | "DISABLED";
  is_primary: boolean;
  verified_at: string | null;
  activated_at: string | null;
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
    meta_robots?: string | null;
    canonical_path?: string | null;
    og_title?: string | null;
    og_description?: string | null;
    og_image_url?: string | null;
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
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [domains, setDomains] = useState<SiteDomain[]>([]);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [title, setTitle] = useState("");
  const [meta, setMeta] = useState("");
  const [robots, setRobots] = useState("index,follow");
  const [canonical, setCanonical] = useState("");
  const [ogTitle, setOgTitle] = useState("");
  const [ogDescription, setOgDescription] = useState("");
  const [ogImage, setOgImage] = useState("");
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

    if (!siteId) {
      setBindings([]);
      return;
    }

    void Promise.all([
      apiRequest<Binding[]>("/site-forms/site/" + siteId),
      apiRequest<ServiceItem[]>("/service/catalog"),
      apiRequest<SiteDomain[]>("/site-domains/site/" + siteId)
    ])
      .then(([bindingRows, serviceRows, domainRows]) => {
        setBindings(bindingRows);
        setServices(serviceRows);
        setDomains(domainRows);
      })
      .catch((cause) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Не удалось загрузить связки сайта"
        );
      });
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

  async function createLeadBinding() {
    if (!siteId) return;
    const name = window.prompt("Название формы", "Заявка с сайта");
    if (!name?.trim()) return;

    try {
      await apiRequest("/site-forms/site/" + siteId, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          action: "CRM_LEAD"
        })
      });
      setBindings(await apiRequest<Binding[]>("/site-forms/site/" + siteId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать форму");
    }
  }

  async function createBookingBinding() {
    if (!siteId) return;

    if (!services.length) {
      setError("Сначала создайте хотя бы одну услугу в разделе «Сервис».");
      return;
    }

    const list = services
      .map((service, index) =>
        (index + 1) + ". " + service.name + " · " + service.duration_minutes + " мин."
      )
      .join("\n");

    const selectedIndex =
      Number(window.prompt("Выберите услугу:\n" + list, "1")) - 1;
    const service = services[selectedIndex];
    if (!service) return;

    const name = window.prompt(
      "Название формы записи",
      "Запись: " + service.name
    );
    if (!name?.trim()) return;

    try {
      await apiRequest("/site-forms/site/" + siteId, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          action: "BOOKING",
          serviceId: service.id,
          resourceIds: []
        })
      });
      setBindings(await apiRequest<Binding[]>("/site-forms/site/" + siteId));
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Не удалось создать форму онлайн-записи"
      );
    }
  }

  async function addDomain() {
    if (!siteId) return;
    const hostname = window.prompt("Домен без https://", "example.ru");
    if (!hostname?.trim()) return;

    try {
      const created = await apiRequest<{
        id: string;
        verificationHost: string;
        verificationValue: string;
      }>("/site-domains/site/" + siteId, {
        method: "POST",
        body: JSON.stringify({ hostname: hostname.trim() })
      });

      window.alert(
        "Добавьте DNS TXT запись:\n" +
        created.verificationHost +
        "\nЗначение:\n" +
        created.verificationValue
      );
      setDomains(
        await apiRequest<SiteDomain[]>("/site-domains/site/" + siteId)
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось добавить домен");
    }
  }

  async function verifyDomain(domain: SiteDomain) {
    try {
      const result = await apiRequest<{ verified: boolean }>(
        "/site-domains/" + domain.id + "/verify",
        { method: "POST" }
      );
      if (!result.verified) {
        setError("TXT-запись пока не найдена. DNS может обновляться некоторое время.");
      } else {
        setError("");
      }
      setDomains(
        await apiRequest<SiteDomain[]>("/site-domains/site/" + siteId)
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось проверить домен");
    }
  }

  async function activateDomain(domain: SiteDomain) {
    try {
      await apiRequest("/site-domains/" + domain.id + "/activate", {
        method: "POST",
        body: JSON.stringify({ primary: true })
      });
      setDomains(
        await apiRequest<SiteDomain[]>("/site-domains/site/" + siteId)
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось активировать домен");
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
      setRobots(data.version.meta_robots ?? "index,follow");
      setCanonical(data.version.canonical_path ?? "");
      setOgTitle(data.version.og_title ?? "");
      setOgDescription(data.version.og_description ?? "");
      setOgImage(data.version.og_image_url ?? "");
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
              metaDescription: meta,
              metaRobots: robots,
              canonicalPath: canonical || undefined,
              ogTitle: ogTitle || undefined,
              ogDescription: ogDescription || undefined,
              ogImageUrl: ogImage || undefined
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
                <button
                  className="site-store-enable"
                  onClick={() => void createLeadBinding()}
                  type="button"
                >
                  + Форма заявки
                  <small>Создаёт клиента и сделку в CRM</small>
                </button>
                <button
                  className="site-store-enable"
                  onClick={() => void createBookingBinding()}
                  type="button"
                >
                  + Онлайн-запись
                  <small>Создаёт клиента и запись на услугу</small>
                </button>
                <button
                  className="site-store-enable"
                  onClick={() => void addDomain()}
                  type="button"
                >
                  + Свой домен
                  <small>DNS TXT → проверка → активация</small>
                </button>
                {domains.map((domain) => (
                  <div className="site-domain-mini" key={domain.id}>
                    <strong>{domain.hostname}</strong>
                    <small>
                      {domain.status}
                      {domain.is_primary ? " · основной" : ""}
                    </small>
                    {domain.status === "PENDING" ? (
                      <button
                        className="secondary-button"
                        onClick={() => void verifyDomain(domain)}
                        type="button"
                      >
                        Проверить DNS
                      </button>
                    ) : null}
                    {domain.status === "VERIFIED" ? (
                      <button
                        onClick={() => void activateDomain(domain)}
                        type="button"
                      >
                        Активировать
                      </button>
                    ) : null}
                  </div>
                ))}
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
                  <label>
                    <span>Robots</span>
                    <select
                      value={robots}
                      onChange={(event) => setRobots(event.target.value)}
                    >
                      <option value="index,follow">index, follow</option>
                      <option value="noindex,follow">noindex, follow</option>
                      <option value="index,nofollow">index, nofollow</option>
                      <option value="noindex,nofollow">noindex, nofollow</option>
                    </select>
                  </label>
                  <label>
                    <span>Canonical path</span>
                    <input
                      placeholder="/"
                      value={canonical}
                      onChange={(event) => setCanonical(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Open Graph title</span>
                    <input
                      value={ogTitle}
                      onChange={(event) => setOgTitle(event.target.value)}
                    />
                  </label>
                  <label>
                    <span>Open Graph image URL</span>
                    <input
                      value={ogImage}
                      onChange={(event) => setOgImage(event.target.value)}
                    />
                  </label>
                  <label className="site-meta-wide">
                    <span>Open Graph description</span>
                    <textarea
                      value={ogDescription}
                      onChange={(event) => setOgDescription(event.target.value)}
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
                        bindings={bindings}
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
  bindings,
  onChange
}: {
  block: Block;
  bindings: Binding[];
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

  if (block.block_type === "FORM" || block.block_type === "BOOKING") {
    const action = block.block_type === "FORM" ? "CRM_LEAD" : "BOOKING";
    const available = bindings.filter((binding) => binding.action === action);

    return (
      <div className="builder-field-grid">
        <Field
          label="Заголовок"
          value={c.heading ?? ""}
          onChange={(v) => set("heading", v)}
        />
        <label className="builder-field">
          <span>Связка формы</span>
          <select
            value={c.bindingId ?? ""}
            onChange={(event) => set("bindingId", event.target.value)}
          >
            <option value="">Выберите связку</option>
            {available.map((binding) => (
              <option key={binding.id} value={binding.public_key}>
                {binding.name}
              </option>
            ))}
          </select>
        </label>
        {!available.length ? (
          <p className="builder-hint">
            Создайте связку слева: «Форма заявки» или «Онлайн-запись».
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="builder-field-grid">
      <Field
        label="Заголовок"
        value={c.heading ?? ""}
        onChange={(v) => set("heading", v)}
      />
      <Field
        label="Лимит элементов"
        value={String(c.limit ?? 12)}
        onChange={(v) => set("limit", Number(v) || 12)}
      />
      <p className="builder-hint">
        Блок использует актуальные данные ERP.
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
