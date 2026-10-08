import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import {
  PublicSiteView,
  type PublicPageData
} from "../../../components/public-site-view";

type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

type Props = {
  params: Promise<{ slug?: string[] }>;
};

const API_URL =
  process.env.API_INTERNAL_URL ??
  process.env.NEXT_PUBLIC_API_URL ??
  "http://localhost:4000/api/v1";

async function loadByHost(parts?: string[]): Promise<PublicPageData | null> {
  const requestHeaders = await headers();
  const rawHost =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "";
  const host = rawHost.split(",")[0]!.trim().split(":")[0]!.toLowerCase();
  if (!host) return null;

  const slug = parts?.length ? parts.join("/") : "/";
  const response = await fetch(
    API_URL +
      "/site-domains/public/page?host=" +
      encodeURIComponent(host) +
      "&slug=" +
      encodeURIComponent(slug),
    { next: { revalidate: 60 } }
  );

  if (!response.ok) return null;
  const payload = (await response.json()) as ApiResponse<PublicPageData>;
  return payload.ok ? payload.data : null;
}

function buildMetadata(data: PublicPageData): Metadata {
  const robots = (data.version.metaRobots ?? "index,follow")
    .toLowerCase()
    .split(",")
    .map((item) => item.trim());

  const path =
    data.version.canonicalPath ||
    (data.page.slug === "/" ? "/" : data.page.slug);

  const canonical = data.site.hostname
    ? "https://" + data.site.hostname + path
    : undefined;

  return {
    title: data.version.title || data.page.name,
    description: data.version.metaDescription ?? undefined,
    robots: {
      index: robots.includes("index"),
      follow: robots.includes("follow")
    },
    alternates: canonical ? { canonical } : undefined,
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
  const data = await loadByHost(resolved.slug);
  return data ? buildMetadata(data) : {};
}

export default async function HostedSitePage({ params }: Props) {
  const resolved = await params;
  const data = await loadByHost(resolved.slug);
  if (!data) notFound();

  return <PublicSiteView data={data} />;
}
