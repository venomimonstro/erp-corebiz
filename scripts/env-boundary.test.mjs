import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
async function source(path) {
  return readFile(resolve(root, path), "utf8");
}

test("client API uses same-origin path by default", async () => {
  const client = await source("apps/web/lib/api.ts");
  assert.match(client, /["']\/api\/v1["']/);
  assert.doesNotMatch(client, /"http:\/\/localhost:4000\/api\/v1"/);
  const env = await source(".env.example");
  assert.match(env, /^NEXT_PUBLIC_API_URL=\/api\/v1$/m);
});

test("server-side public pages and sitemaps use a private absolute upstream", async () => {
  const serverFiles = [
    "apps/web/app/__site_host_sitemap/route.ts",
    "apps/web/app/s/[publicSlug]/sitemap.xml/route.ts",
    "apps/web/app/__site_host/[[...slug]]/page.tsx",
    "apps/web/app/s/[publicSlug]/[[...slug]]/page.tsx"
  ];
  for (const file of serverFiles) {
    const text = await source(file);
    assert.doesNotMatch(text, /process\.env\.NEXT_PUBLIC_API_URL/,
      file + " cannot use a browser-relative URL during server-side fetch");
    assert.match(text, /COREBIZ_API_PROXY_ORIGIN/, file + " should use private API upstream");
  }
});

test("proxy trust is explicit and cannot default to trusting everyone", async () => {
  const main = await source("apps/api/src/main.ts");
  assert.match(main, /COREBIZ_TRUSTED_PROXIES/);
  assert.match(main, /"loopback"/);
  assert.doesNotMatch(main, /set\("trust proxy",\s*true\)/);
});
