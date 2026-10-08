import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicStorefront } from "../../../../components/public-storefront";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

type PublicPageData = {
  site: {
    id: string;
    name: string;
    publicSlug: string;
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
    publishedAt: string;
  };
  blocks: Array<{
    id: string;
    type: string;
    sortOrder: number;
    config: Record<string, any>;
  }>;
};

type Props = {
  params: Promise<{
    publicSlug: string;
    slug?: string[];
  }>;
};

const API_URL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000/api/v1";

async function loadPage(
  publicSlug: string,
  parts?: string[]
): Promise<PublicPageData | null> {
  const pageSlug = parts?.length ? parts.join("/") : "/";
  const response = await fetch(
    API_URL +
      "/sites/public/" +
      encodeURIComponent(publicSlug) +
      "/page?slug=" +
      encodeURIComponent(pageSlug),
    {
      next: { revalidate: 60 }
    }
  );

  if (!response.ok) return null;

  const payload = (await response.json()) as ApiResponse<PublicPageData>;
  return payload.ok ? payload.data : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const resolved = await params;
  const data = await loadPage(resolved.publicSlug, resolved.slug);
  if (!data) return {};

  return {
    title: data.version.title || data.page.name,
    description: data.version.metaDescription ?? undefined,
    robots: {
      index: true,
      follow: true
    }
  };
}

export default async function PublicSitePage({ params }: Props) {
  const resolved = await params;
  const data = await loadPage(resolved.publicSlug, resolved.slug);

  if (!data) notFound();

  return (
    <main className="public-site">
      <header className="public-site-header">
        <a href={"/s/" + data.site.publicSlug} className="public-brand">
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

  return (
    <section className="public-block public-dynamic-placeholder">
      <strong>{c.heading || "Раздел"}</strong>
      <span>Динамические данные подключаются к ERP.</span>
    </section>
  );
}
