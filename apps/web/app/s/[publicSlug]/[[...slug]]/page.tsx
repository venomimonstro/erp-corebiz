import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  PublicSiteView,
  type PublicPageData
} from "../../../../components/public-site-view";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

type Props = {
  params: Promise<{
    publicSlug: string;
    slug?: string[];
  }>;
};

// Server-side fetch requires an absolute private upstream, not the public
// browser API path (/api/v1). Never derive the upstream from request Host.
const API_URL =
  process.env.API_INTERNAL_URL ??
  (process.env.COREBIZ_API_PROXY_ORIGIN ?? "http://127.0.0.1:4000")
    .replace(/\/$/, "") + "/api/v1";

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
    { next: { revalidate: 60 } }
  );

  if (!response.ok) return null;
  const payload = (await response.json()) as ApiResponse<PublicPageData>;
  return payload.ok ? payload.data : null;
}

function metadata(data: PublicPageData): Metadata {
  const robots = (data.version.metaRobots ?? "index,follow")
    .toLowerCase()
    .split(",")
    .map((item) => item.trim());

  const canonicalPath =
    data.version.canonicalPath ||
    (data.page.slug === "/" ? "/" : data.page.slug);

  const canonical = data.site.hostname
    ? "https://" + data.site.hostname + canonicalPath
    : "/s/" +
      data.site.publicSlug +
      (canonicalPath === "/" ? "" : canonicalPath);

  return {
    title: data.version.title || data.page.name,
    description: data.version.metaDescription ?? undefined,
    robots: {
      index: robots.includes("index"),
      follow: robots.includes("follow")
    },
    alternates: { canonical },
    openGraph: {
      title:
        data.version.ogTitle ||
        data.version.title ||
        data.page.name,
      description:
        data.version.ogDescription ||
        data.version.metaDescription ||
        undefined,
      images: data.version.ogImageUrl
        ? [{ url: data.version.ogImageUrl }]
        : undefined,
      type: "website"
    }
  };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const resolved = await params;
  const data = await loadPage(resolved.publicSlug, resolved.slug);
  return data ? metadata(data) : {};
}

export default async function PublicSitePage({ params }: Props) {
  const resolved = await params;
  const data = await loadPage(resolved.publicSlug, resolved.slug);
  if (!data) notFound();

  return <PublicSiteView data={data} />;
}
