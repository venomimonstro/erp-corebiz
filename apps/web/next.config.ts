import type { NextConfig } from "next";

// The public storefront and forms use a same-origin API path even on a
// tenant's custom domain. The upstream is configured by the deployment
// operator; never derive it from an incoming Host or user-controlled URL.
const apiUpstream = (
  process.env.COREBIZ_API_PROXY_ORIGIN ?? "http://127.0.0.1:4000"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: apiUpstream + "/api/v1/:path*"
      }
    ];
  }
};

export default nextConfig;
