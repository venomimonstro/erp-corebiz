import { headers } from "next/headers";

export async function GET() {
  const h = await headers();
  const rawHost =
    h.get("x-forwarded-host") ??
    h.get("host") ??
    "";
  const host = rawHost.split(",")[0]!.trim().split(":")[0]!.toLowerCase();

  if (!host) return new Response("Not found", { status: 404 });

  return new Response(
    "User-agent: *\nAllow: /\nSitemap: https://" +
      host +
      "/sitemap.xml\n",
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    }
  );
}
