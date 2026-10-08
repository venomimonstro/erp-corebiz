import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationsDir = resolve(
      process.cwd(),
      "../../infrastructure/postgres"
    );

    const filenames = (await readdir(migrationsDir))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();

    for (const filename of filenames) {
      const applied = await client.query<{ filename: string }>(
        "SELECT filename FROM schema_migration WHERE filename = $1",
        [filename]
      );

      if (applied.rowCount) {
        process.stdout.write(`[db] skip ${filename}\n`);
        continue;
      }

      const raw = await readFile(resolve(migrationsDir, filename), "utf8");
      const sql = normalizeMigrationSql(raw);

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migration(filename) VALUES ($1)",
          [filename]
        );
        await client.query("COMMIT");
        process.stdout.write(`[db] applied ${filename}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

void migrate();
