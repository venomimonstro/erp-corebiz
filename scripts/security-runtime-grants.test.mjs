import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function allowlist(sql, variable) {
  const match = sql.match(
    new RegExp(variable + String.raw`\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\];`)
  );
  assert.ok(match, variable + " array must be explicit");
  return new Set(
    (match[1].match(/'corebiz_[a-z0-9_]+'/g) ?? [])
      .map((name) => name.slice(1, -1))
  );
}

test("runtime grant list covers each security release gate entrypoint", async () => {
  const migration = await readFile(
    resolve(root, "infrastructure/postgres/120_runtime_function_grants.sql"),
    "utf8"
  );
  const gate = await readFile(
    resolve(root, "scripts/security_runtime_function_gate.sql"),
    "utf8"
  );
  const granted = allowlist(migration, "v_whitelist");
  const required = allowlist(gate, "v_list");

  assert.ok(required.size >= 15, "gate must cover all public and auth entrypoints");
  for (const name of required) {
    assert.ok(granted.has(name), name + " missing from grant migration");
  }

  assert.match(migration, /GRANT EXECUTE ON FUNCTION %s TO corebiz_app/);
  assert.doesNotMatch(migration, /GRANT\s+EXECUTE\s+ON\s+FUNCTION[^;]*\bTO\s+PUBLIC\b/i);
  assert.match(gate, /rolsuper\s+OR\s+rolbypassrls/);
  assert.match(gate, /acl\.grantee\s*=\s*0/);
});
