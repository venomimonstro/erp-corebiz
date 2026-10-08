import { NextRequest, NextResponse } from "next/server";

function hostname(value: string | null): string {
  if (!value) return "";
  return value
    .split(",")[0]!
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "");
}

function configuredAppHost(): string {
  const raw = process.env.NEXT_PUBLIC_APP_HOST?.trim();
  if (!raw) return "";

  try {
    return hostname(
      raw.includes("://")
        ? new URL(raw).host
        : raw
    );
  } catch {
    return hostname(raw);
  }
}

export function middleware(request: NextRequest) {
  const appHost = configuredAppHost();

  // Fail open to the main application when deployment did not explicitly
  // configure the canonical host.
  if (!appHost) return NextResponse.next();

  const host = hostname(
    request.headers.get("x-forwarded-host") ??
    request.headers.get("host")
  );

  if (
    !host ||
    host === appHost ||
    host === "localhost" ||
    host === "127.0.0.1"
  ) {
    return NextResponse.next();
  }

  const pathname = request.nextUrl.pathname;

  if (
    pathname.startsWith("/_next/") ||
    pathname.startsWith("/api/") ||
    pathname === "/favicon.ico"
  ) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();

  if (pathname === "/sitemap.xml") {
    url.pathname = "/__site_host_sitemap";
    return NextResponse.rewrite(url);
  }

  if (pathname === "/robots.txt") {
    url.pathname = "/__site_host_robots";
    return NextResponse.rewrite(url);
  }

  url.pathname =
    "/__site_host" +
    (pathname === "/" ? "" : pathname);

  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image).*)"]
};
