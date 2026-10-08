export async function GET(
  request: Request,
  context: { params: Promise<{ publicSlug: string }> }
) {
  const { publicSlug } = await context.params;
  const origin = new URL(request.url).origin;
  const sitemap =
    origin +
    "/s/" +
    encodeURIComponent(publicSlug) +
    "/sitemap.xml";

  return new Response(
    "User-agent: *\nAllow: /\nSitemap: " + sitemap + "\n",
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300"
      }
    }
  );
}
