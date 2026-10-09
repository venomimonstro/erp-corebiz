type ApiResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string } };

type RouteRow = {
  pageSlug: string;
  publishedAt: string;
};

// Server-side fetch requires an absolute private upstream, not the public
// browser API path (/api/v1). Never derive the upstream from request Host.
const API_URL =
  process.env.API_INTERNAL_URL ??
  (process.env.COREBIZ_API_PROXY_ORIGIN ?? "http://127.0.0.1:4000")
    .replace(/\/$/, "") + "/api/v1";

export async function GET(
  request: Request,
  context: { params: Promise<{ publicSlug: string }> }
) {
  const { publicSlug } = await context.params;
  const response = await fetch(
    API_URL +
      "/sites/public/" +
      encodeURIComponent(publicSlug) +
      "/routes",
    { next: { revalidate: 300 } }
  );

  if (!response.ok) {
    return new Response("Not found", { status: 404 });
  }

  const payload = (await response.json()) as ApiResponse<RouteRow[]>;
  if (!payload.ok) {
    return new Response("Not found", { status: 404 });
  }

  const origin = new URL(request.url).origin;
  const base = origin + "/s/" + encodeURIComponent(publicSlug);

  const urls = payload.data.map((row) => {
    const loc =
      base +
      (row.pageSlug === "/" ? "" : row.pageSlug);
    return (
      "<url><loc>" +
      escapeXml(loc) +
      "</loc><lastmod>" +
      escapeXml(new Date(row.publishedAt).toISOString()) +
      "</lastmod></url>"
    );
  });

  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.join("") +
    "</urlset>";

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=300"
    }
  });
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
