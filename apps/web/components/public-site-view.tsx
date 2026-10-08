import { PublicStorefront } from "./public-storefront";
import { PublicSiteForm } from "./public-site-form";
import { PublicAnalyticsConsent } from "./public-analytics-consent";

export type PublicPageData = {
  site: {
    id: string;
    name: string;
    code?: string;
    publicSlug: string;
    hostname?: string | null;
    theme: Record<string, unknown>;
    settings: Record<string, unknown>;
  };
  page: {
    id: string;
    name: string;
    slug: string;
    pageType: string;
  };
  version: {
    id: string;
    versionNo: number;
    title: string;
    metaDescription: string | null;
    metaRobots?: string | null;
    canonicalPath?: string | null;
    ogTitle?: string | null;
    ogDescription?: string | null;
    ogImageUrl?: string | null;
    publishedAt: string;
  };
  analytics?: {
    trackerKey: string | null;
  };
  blocks: Array<{
    id: string;
    type: string;
    sortOrder: number;
    config: Record<string, any>;
  }>;
};

export function PublicSiteView({
  data
}: {
  data: PublicPageData;
}) {
  return (
    <main className="public-site">
      <header className="public-site-header">
        <a href="/" className="public-brand">
          {data.site.name}
        </a>
      </header>

      <div className="public-site-content">
        {data.blocks.map((block) => (
          <PublicBlock
            key={block.id}
            block={block}
            publicSlug={data.site.publicSlug}
          />
        ))}
      </div>

      <footer className="public-site-footer">
        <span>{data.site.name}</span>
      </footer>

      <PublicAnalyticsConsent
        trackerKey={data.analytics?.trackerKey ?? null}
      />
    </main>
  );
}

function PublicBlock({
  block,
  publicSlug
}: {
  block: PublicPageData["blocks"][number];
  publicSlug: string;
}) {
  const c = block.config;

  if (block.type === "HERO") {
    return (
      <section className="public-block public-hero">
        <div className="public-hero-copy">
          <h1>{c.heading}</h1>
          {c.text ? <p>{c.text}</p> : null}
          {c.buttonLabel && c.buttonHref ? (
            <a className="public-primary-button" href={c.buttonHref}>
              {c.buttonLabel}
            </a>
          ) : null}
        </div>
        {c.imageUrl ? (
          <img
            className="public-hero-image"
            src={c.imageUrl}
            alt=""
          />
        ) : null}
      </section>
    );
  }

  if (block.type === "TEXT") {
    return (
      <section className="public-block public-text">
        {c.heading ? <h2>{c.heading}</h2> : null}
        <p>{c.text}</p>
      </section>
    );
  }

  if (block.type === "FEATURES") {
    return (
      <section className="public-block">
        {c.heading ? <h2>{c.heading}</h2> : null}
        <div className="public-feature-grid">
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

  if (block.type === "CTA") {
    return (
      <section className="public-block public-cta">
        <h2>{c.heading}</h2>
        {c.text ? <p>{c.text}</p> : null}
        <a className="public-primary-button" href={c.buttonHref}>
          {c.buttonLabel}
        </a>
      </section>
    );
  }

  if (block.type === "IMAGE") {
    return (
      <figure className="public-block public-image-block">
        <img src={c.src} alt={c.alt ?? ""} />
        {c.caption ? <figcaption>{c.caption}</figcaption> : null}
      </figure>
    );
  }

  if (block.type === "SPACER") {
    return <div style={{ height: Number(c.size ?? 32) }} />;
  }

  if (block.type === "PRODUCT_GRID" || block.type === "CATALOG") {
    return (
      <PublicStorefront
        publicSlug={publicSlug}
        heading={c.heading}
        limit={Number(c.limit ?? 12)}
      />
    );
  }

  if (block.type === "FORM") {
    return (
      <PublicSiteForm
        publicKey={String(c.bindingId ?? "")}
        heading={c.heading}
      />
    );
  }

  if (block.type === "BOOKING") {
    return (
      <PublicSiteForm
        publicKey={String(c.bindingId ?? "")}
        heading={c.heading}
        booking
      />
    );
  }

  return (
    <section className="public-block public-dynamic-placeholder">
      <strong>{c.heading || "Раздел"}</strong>
      <span>Динамические данные подключаются к ERP.</span>
    </section>
  );
}
