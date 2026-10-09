import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectMigrations } from "./migration-preflight.mjs";

async function withSqlFiles(files, callback) {
  const directory = await mkdtemp(join(tmpdir(), "corebiz-preflight-"));
  try {
    for (const [name, sql] of Object.entries(files)) {
      await writeFile(join(directory, name), sql, "utf8");
    }
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("valid ordered SQL files are recognized", async () => {
  await withSqlFiles(
    { "001_start.sql": "CREATE TABLE foo(id integer);", "002_next.sql": "ALTER TABLE foo ADD COLUMN val integer;" },
    async (dir) => {
      const result = await inspectMigrations(dir);
      assert.equal(result.checked, 2);
      assert.equal(result.blocked, 0);
    }
  );
});

test("duplicate ordinals warn but preserve full filename ordering", async () => {
  await withSqlFiles(
    { "01_a.sql": "SELECT 1;", "001_b.sql": "SELECT 2;" },
    async (dir) => {
      const result = await inspectMigrations(dir);
      assert.equal(result.blocked, 0);
      assert.equal(result.warnings, 1);
      assert.deepEqual(result.findings[0].files, ["001_b.sql", "01_a.sql"]);
      assert.match(result.findings[0].message, /historical duplicate/);
    }
  );
});

test("empty directory and empty migration fail closed", async () => {
  await withSqlFiles({}, async (dir) => {
    assert.equal((await inspectMigrations(dir)).blocked, 1);
  });
  await withSqlFiles({ "001_bad.sql": "" }, async (dir) => {
    assert.equal((await inspectMigrations(dir)).blocked, 1);
  });
});

test("unsafe RLS and schema deletion are blocked", async () => {
  await withSqlFiles(
    { "001_rls.sql": "ALTER TABLE a DISABLE ROW LEVEL SECURITY;",
      "002_schema.sql": "DROP SCHEMA IF EXISTS public CASCADE;" },
    async (dir) => {
      const result = await inspectMigrations(dir);
      assert.equal(result.blocked, 2);
    }
  );
});
