import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL_REQUIRED");
}

const pool = new Pool({ connectionString: databaseUrl });

function normalizeMigrationSql(sql: string): string {
  return sql
    .replace(/^\s*BEGIN;\s*/i, "")
    .replace(/\s*COMMIT;\s*$/i, "");
}

async function migrate(): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('corebiz-schema-migrate'))");
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '5min'");

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum_sha256 text
      )
    `);
    // Keep historical filename identity. Existing rows may have NULL checksums:
    // their original source bytes cannot be verified retroactively.
    await client.query(
      "ALTER TABLE schema_migration ADD COLUMN IF NOT EXISTS checksum_sha256 text"
    );

    const migrationsDir = resolve(
      process.cwd(),
      "../../infrastructure/postgres"
    );

    const filenames = (await readdir(migrationsDir))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();

    // An applied filename missing from the repository can indicate a
    // renamed/deleted migration. Never silently replay a renamed SQL file.
    const known = new Set(filenames);
    const historical = await client.query<{ filename: string }>(
      "SELECT filename FROM schema_migration ORDER BY filename"
    );
    const missing = historical.rows
      .map((row) => row.filename)
      .filter((name) => !known.has(name));
    if (missing.length) {
      throw new Error(
        "APPLIED_MIGRATIONS_MISSING_FROM_REPOSITORY: " +
        missing.slice(0, 20).join(", ")
      );
    }

    for (const filename of filenames) {
      const raw = await readFile(resolve(migrationsDir, filename), "utf8");
      const checksum = createHash("sha256").update(raw).digest("hex");
      const applied = await client.query<{
        filename: string;
        checksum_sha256: string | null;
      }>(
        "SELECT filename,checksum_sha256 FROM schema_migration WHERE filename=$1",
        [filename]
      );

      if (applied.rowCount) {
        const previous = applied.rows[0]!.checksum_sha256;
        if (previous && previous !== checksum) {
          throw new Error("MIGRATION_CHECKSUM_MISMATCH: " + filename);
        }
        if (!previous) {
          process.stderr.write(
            "[db] historical checksum unavailable; verify externally: " +
            filename + "\n"
          );
        } else {
          process.stdout.write(`[db] skip verified ${filename}\n`);
        }
        continue;
      }

      const sql = normalizeMigrationSql(raw);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migration(filename,checksum_sha256) VALUES ($1,$2)",
          [filename,checksum]
        );
        await client.query("COMMIT");
        process.stdout.write(`[db] applied ${filename}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('corebiz-schema-migrate'))");
    } catch {
      // Connection cleanup still continues if unlock fails.
    }
    client.release();
    await pool.end();
  }
}

void migrate();
