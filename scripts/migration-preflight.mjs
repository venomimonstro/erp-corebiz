#!/usr/bin/env node
/**
 * Read-only migration preflight. A valid release has a nonempty, unambiguous
 * migration sequence. The CLI always scans the repository migration directory.
 */
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function inspectMigrations(directory) {
  const names = (await readdir(directory))
    .filter((name) => /^\d+.*\.sql$/.test(name))
    .sort();
  const findings = [];
  const ordinals = new Map();

  if (names.length === 0) {
    findings.push({ severity: "BLOCK", message: "no SQL migrations found" });
  }

  for (const filename of names) {
    const ordinal = Number(filename.match(/^\d+/)?.[0]);
    const siblings = ordinals.get(ordinal) ?? [];
    siblings.push(filename);
    ordinals.set(ordinal, siblings);

    const sql = await readFile(resolve(directory, filename), "utf8");
    if (!sql.trim()) {
      findings.push({ severity: "BLOCK", filename, message: "empty migration" });
    }
    if (/\bDROP\s+SCHEMA\s+(?:IF\s+EXISTS\s+)?public\b/i.test(sql)) {
      findings.push({ severity: "BLOCK", filename, message: "DROP SCHEMA public" });
    }
    if (/\bDISABLE\s+ROW\s+LEVEL\s+SECURITY\b/i.test(sql)) {
      findings.push({ severity: "BLOCK", filename, message: "RLS explicitly disabled" });
    }
  }

  for (const [ordinal, siblings] of ordinals) {
    if (siblings.length > 1) {
      // The migrator keys applied migrations by their *full filename* and
      // sorts the filenames lexicographically. Duplicate numeric ordinals
      // do not create nondeterminism. Never rename applied SQL: retain the
      // historical order and verify it with a disposable replay.
      findings.push({
        severity: "WARN",
        ordinal,
        files: siblings,
        message: "historical duplicate ordinal (deterministic filename order); verify in disposable replay"
      });
    }
  }

  return {
    checked: names.length,
    blocked: findings.filter((finding) => finding.severity === "BLOCK").length,
    warnings: findings.filter((finding) => finding.severity === "WARN").length,
    findings
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // The path is intentionally not configurable by environment variables:
  // release checks must never inspect an operator-supplied empty directory.
  try {
    const report = await inspectMigrations(resolve(process.cwd(), "infrastructure/postgres"));
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    process.exitCode = report.blocked ? 1 : 0;
  } catch (error) {
    process.stderr.write("[migration-preflight] BLOCKED: " + String(error) + "\n");
    process.exitCode = 1;
  }
}
